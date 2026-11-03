import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantActor, tenantActorAny } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { PageQuery, offsetOf, paged, Uuid } from '../../core/http/pagination.js';
import {
  EmployeeInput, COLS, DIRECTORY_SELECT, FULL_SELECT, FROM_JOINS, EMPLOYEE_STATUSES,
  insertEmployee, validateReferences, findDuplicates,
} from './service.js';

const ListQuery = PageQuery.extend({
  search: z.string().trim().max(100).optional(),
  branchId: Uuid.optional(),
  departmentId: Uuid.optional(),
  status: z.enum(EMPLOYEE_STATUSES).optional(),
});

const BankBody = z.object({
  accountHolder: z.string().trim().min(2).max(120),
  accountNumber: z.string().trim().regex(/^[0-9]{9,18}$/, 'Account number must be 9–18 digits'),
  ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC code'),
  bankName: z.string().trim().max(120).nullable().optional(),
});

export async function employeeRoutes(app: FastifyInstance) {
  const { cipher } = app.deps;

  app.get('/', async (req) => {
    const a = tenantActorAny(req, 'employees.read', 'employees.directory');
    const full = a.has('employees.read');
    const q = ListQuery.parse(req.query);
    return a.tx(async (db) => {
      // Directory-only users see active staff; full readers can filter any status.
      const status = full ? q.status ?? null : 'active';
      const params = [a.tenantId, q.search ?? null, q.branchId ?? null, q.departmentId ?? null, status];
      const where = `e.tenant_id=$1
        AND ($2::text IS NULL OR e.employee_code ILIKE $2||'%' OR lower(e.first_name||' '||coalesce(e.last_name,'')) LIKE '%'||lower($2)||'%' OR e.work_email ILIKE '%'||$2||'%')
        AND ($3::uuid IS NULL OR e.branch_id=$3) AND ($4::uuid IS NULL OR e.department_id=$4) AND ($5::text IS NULL OR e.status=$5)`;
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM employees e WHERE ${where}`, params)).rows[0]!.n);
      const rows = await db.query(`SELECT ${full ? FULL_SELECT : DIRECTORY_SELECT} ${FROM_JOINS} WHERE ${where}
        ORDER BY e.first_name, e.last_name, e.employee_code LIMIT $6 OFFSET $7`, [...params, q.pageSize, offsetOf(q)]);
      return { ...paged(rows.rows, total, q), view: full ? 'full' : 'directory' };
    });
  });

  app.get('/me', async (req) => {
    const a = tenantActor(req);
    if (!a.user.employeeId) throw notFound('Your user account is not linked to an employee record');
    return a.tx(async (db) => (await db.query(`SELECT ${FULL_SELECT} ${FROM_JOINS} WHERE e.tenant_id=$1 AND e.id=$2`, [a.tenantId, a.user.employeeId])).rows[0]);
  });

  app.get('/:id', async (req) => {
    const a = tenantActorAny(req, 'employees.read', 'employees.directory');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const full = a.has('employees.read') || a.user.employeeId === id;
    return a.tx(async (db) => {
      const r = await db.query(`SELECT ${full ? FULL_SELECT : DIRECTORY_SELECT} ${FROM_JOINS} WHERE e.tenant_id=$1 AND e.id=$2`, [a.tenantId, id]);
      if (!r.rowCount) throw notFound('Employee not found');
      return { ...r.rows[0], view: full ? 'full' : 'directory' };
    });
  });

  app.post('/', async (req, reply) => {
    const a = tenantActor(req, 'employees.manage');
    const body = z.object({ employee: EmployeeInput, confirmDuplicate: z.boolean().default(false) }).parse(req.body);
    return a.tx(async (db) => {
      const id = await insertEmployee(db, a.tenantId, body.employee, body.confirmDuplicate);
      await audit(db, { ...a.auditBase, action: 'employee.created', targetType: 'employee', targetId: id,
        metadata: { employeeCode: body.employee.employeeCode, confirmedDuplicate: body.confirmDuplicate } });
      reply.code(201); return { id };
    });
  });

  app.patch('/:id', async (req) => {
    const a = tenantActor(req, 'employees.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const body = z.object({ changes: z.record(z.string(), z.unknown()), expectedVersion: z.number().int() }).parse(req.body);
    return a.tx(async (db) => {
      const cur = await db.query(`SELECT * FROM employees WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [a.tenantId, id]);
      const row = cur.rows[0];
      if (!row) throw notFound('Employee not found');
      if (row.version !== body.expectedVersion) throw conflict('This record was changed by someone else. Reload and try again.');
      // Rebuild the full input from current values + changes, then validate as a whole.
      const currentInput = Object.fromEntries(Object.entries(COLS).map(([k, col]) => [k, row[col]]));
      const unknownKeys = Object.keys(body.changes).filter((k) => !(k in COLS));
      if (unknownKeys.length) throw badRequest(`Unknown fields: ${unknownKeys.join(', ')}`);
      const next = EmployeeInput.parse({ ...currentInput, ...body.changes });
      await validateReferences(db, a.tenantId, next, id);
      const changed = (Object.keys(COLS) as (keyof typeof COLS)[]).filter((k) => (next[k] ?? null) !== (currentInput[k] ?? null));
      if (!changed.length) return { ok: true, version: row.version, changed: [] };
      if (changed.includes('workEmail') || changed.includes('phone')) {
        const d = await findDuplicates(db, a.tenantId, { workEmail: next.workEmail, phone: next.phone }, id);
        if (d.length) throw conflict('Another employee already uses this email or phone', { duplicates: d });
      }
      const sets = changed.map((k, i) => `${COLS[k]}=$${i + 3}`).join(', ');
      const r = await db.query<{ version: number }>(`UPDATE employees SET ${sets}, version=version+1, updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING version`,
        [a.tenantId, id, ...changed.map((k) => next[k] ?? null)]);
      await audit(db, { ...a.auditBase, action: 'employee.updated', targetType: 'employee', targetId: id,
        metadata: { changes: Object.fromEntries(changed.map((k) => [k, { from: currentInput[k] ?? null, to: next[k] ?? null }])) } });
      return { ok: true, version: r.rows[0]!.version, changed };
    });
  });

  /**
   * Bulk import. All-or-nothing: rows are validated first (dryRun returns the
   * per-row report), then inserted in one transaction. Org references by code.
   */
  app.post('/import', { bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    const a = tenantActor(req, 'employees.manage');
    const body = z.object({ dryRun: z.boolean().default(true), rows: z.array(z.record(z.string(), z.unknown())).min(1).max(2000) }).parse(req.body);
    return a.tx(async (db) => {
      const branches = new Map((await db.query<{ code: string; id: string; legal_entity_id: string }>('SELECT code, id, legal_entity_id FROM branches WHERE tenant_id=$1', [a.tenantId])).rows.map((r) => [r.code, r]));
      const depts = new Map((await db.query<{ code: string; id: string }>('SELECT code, id FROM departments WHERE tenant_id=$1', [a.tenantId])).rows.map((r) => [r.code, r.id]));
      const codesInFile = new Map<string, number>();
      const report: { row: number; employeeCode?: string; errors: string[]; warnings: string[] }[] = [];
      const valid: { input: z.infer<typeof EmployeeInput>; managerCode?: string }[] = [];
      body.rows.forEach((raw, idx) => {
        const errors: string[] = []; const warnings: string[] = [];
        const s = (k: string) => { const v = raw[k]; return v === undefined || v === null || v === '' ? undefined : String(v).trim(); };
        const branch = s('branchCode') ? branches.get(s('branchCode')!) : undefined;
        if (!branch) errors.push(`Unknown branchCode '${s('branchCode') ?? ''}'`);
        const deptId = s('departmentCode') ? depts.get(s('departmentCode')!) : undefined;
        if (s('departmentCode') && !deptId) errors.push(`Unknown departmentCode '${s('departmentCode')}'`);
        const code = s('employeeCode');
        if (code) {
          if (codesInFile.has(code)) errors.push(`Duplicate employeeCode in file (also row ${codesInFile.get(code)})`);
          else codesInFile.set(code, idx + 1);
        }
        const parsed = EmployeeInput.safeParse({
          employeeCode: code, firstName: s('firstName'), lastName: s('lastName') ?? null, workEmail: s('workEmail') ?? null, phone: s('phone') ?? null,
          dateOfBirth: s('dateOfBirth') ?? null, legalEntityId: branch?.legal_entity_id, branchId: branch?.id, departmentId: deptId ?? null,
          designation: s('designation') ?? null, grade: s('grade') ?? null, employmentType: s('employmentType'), status: s('status'),
          dateOfJoining: s('dateOfJoining'), probationEndDate: s('probationEndDate') ?? null, contractEndDate: s('contractEndDate') ?? null,
        });
        if (!parsed.success) parsed.error.issues.forEach((i) => { if (!(branch === undefined && ['legalEntityId', 'branchId'].includes(String(i.path[0])))) errors.push(`${i.path.join('.')}: ${i.message}`); });
        report.push({ row: idx + 1, employeeCode: code, errors, warnings });
        if (!errors.length && parsed.success) valid.push({ input: parsed.data, managerCode: s('reportingManagerCode') });
      });
      // DB-level checks: existing codes, duplicates.
      for (const [i, v] of valid.entries()) {
        const rep = report.find((r) => r.employeeCode === v.input.employeeCode)!;
        const ex = await db.query('SELECT 1 FROM employees WHERE tenant_id=$1 AND employee_code=$2', [a.tenantId, v.input.employeeCode]);
        if (ex.rowCount) rep.errors.push('employeeCode already exists');
        const d = await findDuplicates(db, a.tenantId, v.input);
        d.forEach((x) => (x.reason === 'Same work email' ? rep.errors : rep.warnings).push(`${x.reason} as ${x.employee_code} (${x.name})`));
        if (v.managerCode && !codesInFile.has(v.managerCode)) {
          const m = await db.query('SELECT 1 FROM employees WHERE tenant_id=$1 AND employee_code=$2', [a.tenantId, v.managerCode]);
          if (!m.rowCount) rep.errors.push(`Unknown reportingManagerCode '${v.managerCode}'`);
        }
        void i;
      }
      const errorCount = report.filter((r) => r.errors.length).length;
      const summary = { total: body.rows.length, valid: body.rows.length - errorCount, errors: errorCount, warnings: report.filter((r) => r.warnings.length).length };
      if (body.dryRun || errorCount) return { committed: false, summary, report: report.filter((r) => r.errors.length || r.warnings.length) };
      // Insert without managers first, then resolve manager codes (handles managers inside the same file).
      for (const v of valid) await insertEmployee(db, a.tenantId, { ...v.input, reportingManagerId: null }, true);
      for (const v of valid.filter((x) => x.managerCode)) {
        await db.query(`UPDATE employees e SET reporting_manager_id = m.id FROM employees m
          WHERE e.tenant_id=$1 AND m.tenant_id=$1 AND e.employee_code=$2 AND m.employee_code=$3`, [a.tenantId, v.input.employeeCode, v.managerCode]);
      }
      await audit(db, { ...a.auditBase, action: 'employee.bulk_imported', targetType: 'employee', metadata: { count: valid.length, codes: valid.map((v) => v.input.employeeCode).slice(0, 200) } });
      return { committed: true, summary, report: report.filter((r) => r.warnings.length) };
    });
  });

  app.get('/:id/history', async (req) => {
    const a = tenantActor(req, 'employees.read');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => ({ items: (await db.query(`SELECT l.id, l.action, l.change_metadata, l.created_at, u.display_name AS actor_name
      FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_id WHERE l.tenant_id=$1 AND l.target_type='employee' AND l.target_id=$2
      ORDER BY l.created_at DESC LIMIT 100`, [a.tenantId, id])).rows }));
  });

  // ------------------------------------------------------------ restricted: bank details
  app.get('/:id/bank-account', async (req) => {
    const a = tenantActorAny(req, 'employees.bank.read', 'attendance.self');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    if (!a.has('employees.bank.read') && a.user.employeeId !== id) throw forbidden();
    return a.tx(async (db) => {
      const r = await db.query(`SELECT account_holder, account_last4, ifsc, bank_name, updated_at FROM employee_bank_accounts WHERE tenant_id=$1 AND employee_id=$2`, [a.tenantId, id]);
      // Viewing restricted data is itself audited.
      await audit(db, { ...a.auditBase, action: 'employee.bank_viewed', category: 'access', targetType: 'employee', targetId: id });
      const b = r.rows[0];
      return b ? { accountHolder: b.account_holder, accountNumberMasked: `XXXXXX${b.account_last4}`, ifsc: b.ifsc, bankName: b.bank_name, updatedAt: b.updated_at } : null;
    });
  });

  app.put('/:id/bank-account', async (req) => {
    const a = tenantActor(req, 'employees.bank.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const body = BankBody.parse(req.body);
    return a.tx(async (db) => {
      const e = await db.query('SELECT 1 FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, id]);
      if (!e.rowCount) throw notFound('Employee not found');
      const prev = await db.query<{ account_last4: string }>('SELECT account_last4 FROM employee_bank_accounts WHERE tenant_id=$1 AND employee_id=$2', [a.tenantId, id]);
      await db.query(`INSERT INTO employee_bank_accounts (employee_id, tenant_id, account_holder, account_number_enc, account_last4, ifsc, bank_name, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (employee_id) DO UPDATE SET account_holder=$3, account_number_enc=$4, account_last4=$5, ifsc=$6,
        bank_name=$7, updated_by=$8, updated_at=now()`,
        [id, a.tenantId, body.accountHolder, cipher.encrypt(body.accountNumber), body.accountNumber.slice(-4), body.ifsc, body.bankName ?? null, a.user.userId]);
      await audit(db, { ...a.auditBase, action: 'employee.bank_updated', category: 'security', targetType: 'employee', targetId: id,
        metadata: { previousLast4: prev.rows[0]?.account_last4 ?? null, newLast4: body.accountNumber.slice(-4), ifsc: body.ifsc } });
      return { ok: true };
    });
  });

}
