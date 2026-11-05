import { z } from 'zod';
import type { Db } from '../../db/tx.js';
import { IsoDate, Uuid } from '../../core/http/pagination.js';
import { badRequest, conflict } from '../../core/http/errors.js';
import { isModuleEnabled } from '../../core/features/state.js';

export const EMPLOYMENT_TYPES = ['permanent', 'probation', 'contract', 'trainee', 'intern', 'consultant'] as const;
export const EMPLOYEE_STATUSES = ['pre_joining', 'active', 'on_notice', 'exited', 'inactive'] as const;

const opt = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional();

export const EmployeeInput = z
  .object({
    employeeCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9/_-]{0,29}$/, 'Letters, digits, /, _ or - (max 30)'),
    firstName: z.string().trim().min(1).max(100),
    lastName: opt(z.string().trim().max(100)),
    workEmail: opt(z.string().trim().toLowerCase().pipe(z.email())),
    phone: opt(
      z
        .string()
        .trim()
        .regex(/^\+?[0-9 -]{10,15}$/, 'Enter a valid phone number'),
    ),
    dateOfBirth: opt(IsoDate),
    legalEntityId: Uuid,
    branchId: Uuid,
    departmentId: opt(Uuid),
    designation: opt(z.string().trim().max(120)),
    grade: opt(z.string().trim().max(40)),
    employmentType: z.enum(EMPLOYMENT_TYPES).default('permanent'),
    status: z.enum(EMPLOYEE_STATUSES).default('active'),
    reportingManagerId: opt(Uuid),
    dateOfJoining: IsoDate,
    probationEndDate: opt(IsoDate),
    confirmationDate: opt(IsoDate),
    contractEndDate: opt(IsoDate),
  })
  .superRefine((e, ctx) => {
    if (e.dateOfBirth && e.dateOfBirth >= e.dateOfJoining) ctx.addIssue({ code: 'custom', path: ['dateOfBirth'], message: 'Date of birth must be before date of joining' });
    if (e.dateOfBirth) {
      const age = (Date.parse(e.dateOfJoining) - Date.parse(e.dateOfBirth)) / (365.25 * 86400e3);
      if (age < 14) ctx.addIssue({ code: 'custom', path: ['dateOfBirth'], message: 'Employee would be under 14 on the joining date' });
    }
    for (const k of ['probationEndDate', 'confirmationDate', 'contractEndDate'] as const) {
      if (e[k] && e[k]! < e.dateOfJoining) ctx.addIssue({ code: 'custom', path: [k], message: 'Must be on or after date of joining' });
    }
    if (e.employmentType === 'contract' && !e.contractEndDate)
      ctx.addIssue({ code: 'custom', path: ['contractEndDate'], message: 'Contract end date is required for contract employees' });
  });
export type EmployeeInput = z.infer<typeof EmployeeInput>;

/** Column mapping (camelCase API ⇄ snake_case DB). */
export const COLS: Record<keyof EmployeeInput, string> = {
  employeeCode: 'employee_code',
  firstName: 'first_name',
  lastName: 'last_name',
  workEmail: 'work_email',
  phone: 'phone',
  dateOfBirth: 'date_of_birth',
  legalEntityId: 'legal_entity_id',
  branchId: 'branch_id',
  departmentId: 'department_id',
  designation: 'designation',
  grade: 'grade',
  employmentType: 'employment_type',
  status: 'status',
  reportingManagerId: 'reporting_manager_id',
  dateOfJoining: 'date_of_joining',
  probationEndDate: 'probation_end_date',
  confirmationDate: 'confirmation_date',
  contractEndDate: 'contract_end_date',
};

/** L1: what every employee may see of anyone. */
export const DIRECTORY_SELECT = `e.id, e.employee_code, e.first_name, e.last_name, e.work_email, e.designation, e.department_id, d.name AS department_name`;
/** L2: the employee's manager chain sees this as well. */
export const TEAM_SELECT = `${DIRECTORY_SELECT}, e.status, e.branch_id, b.name AS branch_name, e.reporting_manager_id, trim(m.first_name || ' ' || coalesce(m.last_name, '')) AS reporting_manager_name, e.date_of_joining`;
/** Probation and confirmation dates belong to onboarding: while it is off they are not part of an employee record. */
export const fullSelect =
  () => `${DIRECTORY_SELECT}, e.status, e.branch_id, b.name AS branch_name, e.phone, e.date_of_birth, e.legal_entity_id, le.name AS legal_entity_name, e.grade,
  e.employment_type, e.reporting_manager_id, trim(m.first_name || ' ' || coalesce(m.last_name, '')) AS reporting_manager_name,
  e.date_of_joining, ${isModuleEnabled('core.onboarding') ? 'e.probation_end_date, e.confirmation_date, ' : ''}e.contract_end_date, e.exit_date, e.user_id, e.version, e.created_at, e.updated_at`;
export const FROM_JOINS = `FROM employees e
  JOIN branches b ON b.tenant_id = e.tenant_id AND b.id = e.branch_id
  JOIN legal_entities le ON le.tenant_id = e.tenant_id AND le.id = e.legal_entity_id
  LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
  LEFT JOIN employees m ON m.tenant_id = e.tenant_id AND m.id = e.reporting_manager_id`;

/** Branch must belong to the legal entity; manager must be an active employee. */
export async function validateReferences(db: Db, tenantId: string, e: Partial<EmployeeInput>, selfId?: string) {
  if (e.branchId && e.legalEntityId) {
    const b = await db.query('SELECT 1 FROM branches WHERE tenant_id=$1 AND id=$2 AND legal_entity_id=$3', [tenantId, e.branchId, e.legalEntityId]);
    if (!b.rowCount) throw badRequest('Branch does not belong to the selected legal entity');
  }
  if (e.reportingManagerId) {
    if (e.reportingManagerId === selfId) throw badRequest('An employee cannot report to themselves');
    const m = await db.query<{ status: string }>('SELECT status FROM employees WHERE tenant_id=$1 AND id=$2', [tenantId, e.reportingManagerId]);
    if (!m.rowCount) throw badRequest('Reporting manager not found');
    if (!['active', 'on_notice'].includes(m.rows[0]!.status)) throw badRequest('Reporting manager is not an active employee');
    if (selfId) {
      // Prevent cycles: the new manager must not be in this employee's reporting subtree.
      const cyc = await db.query(
        `WITH RECURSIVE sub AS (SELECT id FROM employees WHERE tenant_id=$1 AND reporting_manager_id=$2
          UNION SELECT e.id FROM employees e JOIN sub ON e.reporting_manager_id = sub.id WHERE e.tenant_id=$1)
        SELECT 1 FROM sub WHERE id=$3`,
        [tenantId, selfId, e.reportingManagerId],
      );
      if (cyc.rowCount) throw badRequest('This would create a circular reporting line');
    }
  }
}

export interface DuplicateCandidate {
  id: string;
  employee_code: string;
  name: string;
  reason: string;
}

/** Heuristic duplicate detection: same work email/phone, or same name + date of birth. */
export async function findDuplicates(db: Db, tenantId: string, e: Partial<EmployeeInput>, excludeId?: string): Promise<DuplicateCandidate[]> {
  const r = await db.query<DuplicateCandidate>(
    `SELECT id, employee_code, trim(first_name || ' ' || coalesce(last_name,'')) AS name,
      CASE WHEN $3::text IS NOT NULL AND work_email = $3 THEN 'Same work email'
           WHEN $4::text IS NOT NULL AND regexp_replace(phone, '[^0-9]', '', 'g') = regexp_replace($4, '[^0-9]', '', 'g') THEN 'Same phone number'
           ELSE 'Same name and date of birth' END AS reason
    FROM employees WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id <> $2) AND (
      ($3::text IS NOT NULL AND work_email = $3)
      OR ($4::text IS NOT NULL AND regexp_replace(phone, '[^0-9]', '', 'g') = regexp_replace($4, '[^0-9]', '', 'g'))
      OR ($6::date IS NOT NULL AND date_of_birth = $6 AND lower(first_name) = lower($5) AND lower(coalesce(last_name,'')) = lower(coalesce($7,''))))
    LIMIT 5`,
    [tenantId, excludeId ?? null, e.workEmail ?? null, e.phone ?? null, e.firstName ?? '', e.dateOfBirth ?? null, e.lastName ?? null],
  );
  return r.rows;
}

export async function insertEmployee(db: Db, tenantId: string, e: EmployeeInput, confirmDuplicate: boolean): Promise<string> {
  await validateReferences(db, tenantId, e);
  const dups = await findDuplicates(db, tenantId, e);
  // Same work email is a hard stop (unique index); other matches can be confirmed by the user.
  if (dups.some((d) => d.reason === 'Same work email')) throw conflict('Another employee already uses this work email', { duplicates: dups });
  if (dups.length && !confirmDuplicate) throw conflict('Possible duplicate employee found. Review and confirm to continue.', { duplicates: dups, confirmable: true });
  const keys = Object.keys(COLS) as (keyof EmployeeInput)[];
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (tenant_id, ${keys.map((k) => COLS[k]).join(',')})
    VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING id`,
    [tenantId, ...keys.map((k) => e[k] ?? null)],
  );
  return r.rows[0]!.id;
}
