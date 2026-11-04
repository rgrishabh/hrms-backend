import type { FastifyRequest } from 'fastify';
import type { Db } from '../../db/tx.js';
import { auditMany } from '../audit/audit.js';
import { AppError, notFound } from '../http/errors.js';
import { getSettingValue } from '../settings/service.js';
import { effectiveLevelSql } from './levels.js';

/**
 * The one rule for L4 data. A viewer sees a subject's L4 fields only if the viewer is the subject, or holds an L4 permission
 * and their effective level is strictly above the subject's. Everything reading L4 goes through this file: a SQL fragment for
 * rows, a field mask for what comes back, and the audit row for each read.
 */
export interface PolicyViewer {
  userId: string;
  employeeId: string | null;
  level: number;
  has: (p: string) => boolean;
  /** Reports of this viewer, when the organization lets managers see team salaries. */
  managedTeam?: readonly string[];
}

/** Any one of these makes someone an authorised L4 reader; each path still has its own permission on top. */
export const L4_PERMISSIONS = ['payroll.read', 'payroll.manage', 'payroll.approve', 'employees.bank.read', 'loans.read', 'loans.approve', 'loans.manage', 'accounting.export', 'expenses.pay'] as const;
export const holdsL4 = (v: Pick<PolicyViewer, 'has'>) => L4_PERMISSIONS.some((p) => v.has(p));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidLiteral = (id: string) => { if (!UUID.test(id)) throw new Error('Not a uuid'); return `'${id}'::uuid`; };
const level = (n: number) => { if (!Number.isInteger(n)) throw new Error('Not a level'); return String(n); };

/** The subject's effective level in SQL: `employee` is the alias of an `employees` row. */
export const subjectLevelSql = (employee: string) => effectiveLevelSql(`${employee}.user_id`);

/**
 * Row filter: true for employees whose L4 data this viewer may see. Only integers and checked uuids are inlined. `employee` is the
 * alias of an `employees` row, which the query must join.
 */
export function l4RowFilter(v: PolicyViewer, employee: string): string {
  const self = v.employeeId ? `${employee}.id = ${uuidLiteral(v.employeeId)}` : 'false';
  const above = `${level(v.level)} > ${subjectLevelSql(employee)}`;
  if (holdsL4(v)) return `(${self} OR ${above})`;
  if (v.managedTeam?.length) return `(${self} OR (${employee}.id = ANY(ARRAY[${v.managedTeam.map(uuidLiteral).join(',')}]::uuid[]) AND ${above}))`;
  return `(${self})`;
}

/** L3: self, and HR within hierarchy. HR is whoever maintains employee records. */
export const holdsL3 = (v: Pick<PolicyViewer, 'has'>) => v.has('employees.manage');
export function l3RowFilter(v: PolicyViewer, employee: string): string {
  const self = v.employeeId ? `${employee}.id = ${uuidLiteral(v.employeeId)}` : 'false';
  return holdsL3(v) ? `(${self} OR ${level(v.level)} > ${subjectLevelSql(employee)})` : `(${self})`;
}

/** Whether one subject is visible, read from the database. */
export async function subjectVisible(db: Db, tenantId: string, v: PolicyViewer, employeeId: string, filter: (v: PolicyViewer, e: string) => string = l4RowFilter) {
  const r = await db.query<{ ok: boolean }>(`SELECT ${filter(v, 'e')} AS ok FROM employees e WHERE e.tenant_id=$1 AND e.id=$2`, [tenantId, employeeId]);
  return r.rows[0]?.ok ?? false;
}

/** A subject this viewer cannot see does not exist for them: 404, not 403, so the answer says nothing about who sits above. */
export async function assertSubjectVisible(db: Db, tenantId: string, v: PolicyViewer, employeeId: string, message = 'Not found') {
  if (!(await subjectVisible(db, tenantId, v, employeeId))) throw notFound(message);
}

/** Changing someone's L4 data needs the same standing as seeing it, and never your own through a staff route. */
export async function assertMayChangeSubject(db: Db, tenantId: string, v: PolicyViewer, employeeId: string) {
  if (v.employeeId !== employeeId && !(await subjectVisible(db, tenantId, v, employeeId))) throw notFound('Employee not found');
}

/** Of these employees, who is out of this viewer's reach. */
export async function hiddenSubjects(db: Db, tenantId: string, v: PolicyViewer, employeeIds: readonly string[]) {
  if (!employeeIds.length) return new Set<string>();
  const r = await db.query<{ id: string }>(`SELECT e.id FROM employees e WHERE e.tenant_id=$1 AND e.id = ANY($2) AND NOT ${l4RowFilter(v, 'e')}`, [tenantId, [...employeeIds]]);
  return new Set(r.rows.map((x) => x.id));
}

/**
 * The viewer for one request. A manager's reports count only when the organization has turned that on: off by default, and capped by
 * level in the filter all the same.
 */
export async function policyViewer(db: Db, tenantId: string, u: { userId: string; employeeId: string | null; salaryLevel: number; permissions: ReadonlySet<string> }): Promise<PolicyViewer> {
  const v: PolicyViewer = { userId: u.userId, employeeId: u.employeeId, level: u.salaryLevel, has: (p) => u.permissions.has(p) };
  if (!u.employeeId || !u.permissions.has('loans.team.read') && !u.permissions.has('leave.team.read')) return v;
  if (!(await getSettingValue<boolean>(db, tenantId, 'security.manager_team_salaries'))) return v;
  const team = await db.query<{ id: string }>(`WITH RECURSIVE t AS (SELECT id FROM employees WHERE tenant_id=$1 AND reporting_manager_id=$2
    UNION SELECT e.id FROM employees e JOIN t ON e.reporting_manager_id=t.id WHERE e.tenant_id=$1) SELECT id FROM t`, [tenantId, u.employeeId]);
  return { ...v, managedTeam: team.rows.map((x) => x.id) };
}

// ---------------------------------------------------------------- masking
/** `?reveal=1` is the only explicit reveal. Nothing else, and no other spelling, turns it on. */
export const wantsReveal = (req: FastifyRequest) => (req.query as { reveal?: unknown } | undefined)?.reveal === '1';

export type Masked<T> = T & { masked?: true; maskedFields?: string[] };

/**
 * The single masked shape: each masked field is null, and the object says so beside them, `masked: true` and `maskedFields`.
 * Objects with nothing masked carry neither key. A field that is already null stays out of the list, so a missing value and
 * a hidden one can be told apart.
 */
export function maskFields<T extends Record<string, unknown>>(row: T, fields: readonly string[]): Masked<T> {
  const hit = fields.filter((f) => row[f] !== null && row[f] !== undefined);
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) if (f in out) out[f] = null;
  return (hit.length ? { ...out, masked: true, maskedFields: hit } : out) as Masked<T>;
}

// ---------------------------------------------------------------- audit of each read
export interface ReadContext { tenantId: string; actorId: string; requestId: string; ip: string; userAgent?: string }
export const readContext = (req: FastifyRequest, a: { auditBase: { tenantId: string; actorId: string; requestId: string; ip: string } }): ReadContext =>
  ({ ...a.auditBase, userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined });

/**
 * One row per subject per read: who (actor), whose record (target), which fields, when, IP and device. `kind` is what happened:
 * `reveal` for `?reveal=1`, `read` for L4 that left the server any other way, `export` for a file.
 */
export async function auditL4(db: Db, ctx: ReadContext, kind: 'reveal' | 'read' | 'export', path: string, subjects: readonly { employeeId: string; fields: readonly string[] }[]) {
  await auditMany(db, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: `l4.${kind}`, category: 'access', targetType: 'employee', requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent },
    subjects.map((s) => ({ targetId: s.employeeId, metadata: { path, fields: s.fields } })));
}

/** Refused rather than short or leaking; see DECISIONS.md. */
export const refuseHigherLevel = (hidden: number) =>
  new AppError(403, 'requires_higher_level', `This includes ${hidden} person(s) above your salary level. Someone at a higher level must produce it.`, { hiddenSubjects: hidden });
