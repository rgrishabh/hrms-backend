import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture } from './helpers.js';

let app: FastifyInstance; let T: TenantFixture; let hr: Client;
beforeAll(async () => { app = await makeApp(); T = await createTenant(); hr = await Client.login(app, T.host, T.users.hr!.email); });
afterAll(async () => { await app.close(); });

const base = () => ({ legalEntityId: T.legalEntityId, branchId: T.branchId, departmentId: T.deptId, dateOfJoining: '2025-06-01' });

describe('employee master', () => {
  it('creates an employee, audits it, and validates business rules', async () => {
    const r = await hr.post('/api/v1/employees', { employee: { ...base(), employeeCode: 'NEW1', firstName: 'Asha', lastName: 'Kulkarni',
      workEmail: 'Asha.K@lab.test', dateOfBirth: '1995-02-01', designation: 'Chemist' } });
    expect(r.statusCode).toBe(201);
    const e = (await hr.get(`/api/v1/employees/${r.json().id}`)).json();
    expect(e).toMatchObject({ employee_code: 'NEW1', work_email: 'asha.k@lab.test', view: 'full' });
    expect((await ownerQuery(`SELECT 1 FROM audit_logs WHERE target_id=$1 AND action='employee.created'`, [r.json().id])).length).toBe(1);

    const bad = await hr.post('/api/v1/employees', { employee: { ...base(), employeeCode: 'BAD1', firstName: 'X', employmentType: 'contract', dateOfBirth: '2020-01-01' } });
    expect(bad.statusCode).toBe(400);
    const paths = bad.json().error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['employee.dateOfBirth', 'employee.contractEndDate']));
  });

  it('detects likely duplicates and requires explicit confirmation', async () => {
    const emp = { ...base(), firstName: 'Ravi', lastName: 'Menon', dateOfBirth: '1990-05-05' };
    expect((await hr.post('/api/v1/employees', { employee: { ...emp, employeeCode: 'DUP1' } })).statusCode).toBe(201);
    const dup = await hr.post('/api/v1/employees', { employee: { ...emp, employeeCode: 'DUP2' } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.details.duplicates[0].reason).toBe('Same name and date of birth');
    expect((await hr.post('/api/v1/employees', { employee: { ...emp, employeeCode: 'DUP2' }, confirmDuplicate: true })).statusCode).toBe(201);
    expect((await hr.post('/api/v1/employees', { employee: { ...emp, employeeCode: 'DUP1', firstName: 'Other' } })).statusCode).toBe(409);
  });

  it('uses optimistic concurrency and records field-level change history', async () => {
    const id = T.users.employee!.employeeId!;
    const cur = (await hr.get(`/api/v1/employees/${id}`)).json();
    const ok = await hr.patch(`/api/v1/employees/${id}`, { changes: { designation: 'Senior Chemist' }, expectedVersion: cur.version });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().changed).toEqual(['designation']);
    expect((await hr.patch(`/api/v1/employees/${id}`, { changes: { designation: 'Lead' }, expectedVersion: cur.version })).statusCode).toBe(409);
    const hist = (await hr.get(`/api/v1/employees/${id}/history`)).json().items;
    expect(hist[0].change_metadata.changes.designation).toEqual({ from: cur.designation, to: 'Senior Chemist' });
  });

  it('prevents circular reporting lines', async () => {
    const mgr = T.users.manager!.employeeId!; const emp = T.users.employee!.employeeId!;
    const m = (await hr.get(`/api/v1/employees/${mgr}`)).json();
    const r = await hr.patch(`/api/v1/employees/${mgr}`, { changes: { reportingManagerId: emp }, expectedVersion: m.version });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/circular/);
  });

  it('employees see only directory fields of colleagues but full data for themselves', async () => {
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    const other = (await emp.get(`/api/v1/employees/${T.users.other!.employeeId}`)).json();
    expect(other.view).toBe('directory');
    expect(other).not.toHaveProperty('date_of_birth');
    expect(other).not.toHaveProperty('phone');
    expect((await emp.get(`/api/v1/employees/${T.users.employee!.employeeId}`)).json().view).toBe('full');
    expect((await emp.get('/api/v1/employees')).json().view).toBe('directory');
    expect((await emp.post('/api/v1/employees', { employee: { ...base(), employeeCode: 'HACK', firstName: 'H' } })).statusCode).toBe(403);
  });
});

describe('restricted bank details', () => {
  it('encrypts at rest, returns only a masked number, and audits every view', async () => {
    const id = T.users.employee!.employeeId!;
    const change = await hr.put(`/api/v1/employees/${id}/bank-account`, { accountHolder: 'Emp N2', accountNumber: '123456789012', ifsc: 'SBIN0001234' });
    expect(change.statusCode).toBe(202);   // a second person approves it: test/bank-change.test.ts
    const finEmail = `fin-bank@${T.host}`;
    const [finUser] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) SELECT tenant_id, $2, 'fin', password_hash FROM users WHERE id=$1 RETURNING id`, [T.users.hr!.id, finEmail]);
    await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'finance_manager')`, [finUser!.id, T.id]);
    const fin = await Client.login(app, T.host, finEmail);
    expect((await fin.post(`/api/v1/approvals/${change.json().approvalRequestId}/act`, { action: 'approve' })).statusCode).toBe(200);
    const [row] = await ownerQuery<{ account_number_enc: string }>(`SELECT account_number_enc FROM employee_bank_accounts WHERE employee_id=$1`, [id]);
    expect(row!.account_number_enc).not.toContain('123456789012');
    expect(row!.account_number_enc.startsWith('v1.')).toBe(true);

    const payroll = await Client.login(app, T.host, T.users.payroll!.email);
    const view = (await payroll.get(`/api/v1/employees/${id}/bank-account`)).json();
    expect(view.accountNumberMasked).toBe('XXXXXX9012');
    expect(JSON.stringify(view)).not.toContain('123456789012');
    expect((await ownerQuery(`SELECT 1 FROM audit_logs WHERE target_id=$1 AND action='employee.bank_viewed'`, [id])).length).toBeGreaterThan(0);
    const [upd] = await ownerQuery<{ change_metadata: object }>(`SELECT change_metadata FROM audit_logs WHERE target_id=$1 AND action='employee.bank_updated'`, [id]);
    expect(JSON.stringify(upd!.change_metadata)).not.toContain('123456789012');
  });

  it('segregation of duties: tenant admin and colleagues cannot view, payroll cannot edit, employee sees own', async () => {
    const id = T.users.employee!.employeeId!;
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    expect((await admin.get(`/api/v1/employees/${id}/bank-account`)).statusCode).toBe(403);
    const other = await Client.login(app, T.host, T.users.other!.email);
    expect((await other.get(`/api/v1/employees/${id}/bank-account`)).statusCode).toBe(403);
    const payroll = await Client.login(app, T.host, T.users.payroll!.email);
    expect((await payroll.put(`/api/v1/employees/${id}/bank-account`, { accountHolder: 'X Y', accountNumber: '999999999', ifsc: 'SBIN0001234' })).statusCode).toBe(403);
    const self = await Client.login(app, T.host, T.users.employee!.email);
    expect((await self.get(`/api/v1/employees/${id}/bank-account`)).json().accountNumberMasked).toBe('XXXXXX9012');
  });

  it('validates IFSC format', async () => {
    expect((await hr.put(`/api/v1/employees/${T.users.other!.employeeId}/bank-account`, { accountHolder: 'A B', accountNumber: '123456789', ifsc: 'BAD' })).statusCode).toBe(400);
  });
});

describe('bulk import', () => {
  const row = (code: string, extra: Record<string, string> = {}) => ({ employeeCode: code, firstName: 'Imp', lastName: code, branchCode: 'HQ', departmentCode: 'LAB', dateOfJoining: '2025-01-15', ...extra });

  it('dry-run reports every row error without writing anything', async () => {
    const r = (await hr.post('/api/v1/employees/import', { dryRun: true, rows: [row('I1'), row('I1'), row('I3', { branchCode: 'NOPE' }), row('E1'), row('I5', { reportingManagerCode: 'ZZZ' })] })).json();
    expect(r.committed).toBe(false);
    expect(r.summary).toMatchObject({ total: 5, errors: 4 });
    const msgs = r.report.flatMap((x: { errors: string[] }) => x.errors).join('|');
    expect(msgs).toMatch(/Duplicate employeeCode in file/);
    expect(msgs).toMatch(/Unknown branchCode 'NOPE'/);
    expect(msgs).toMatch(/employeeCode already exists/);
    expect(msgs).toMatch(/Unknown reportingManagerCode 'ZZZ'/);
    expect((await ownerQuery(`SELECT 1 FROM employees WHERE tenant_id=$1 AND employee_code LIKE 'I%'`, [T.id])).length).toBe(0);
  });

  it('commits all-or-nothing and resolves managers within the same file', async () => {
    const r = (await hr.post('/api/v1/employees/import', { dryRun: false, rows: [row('M10'), row('M11', { reportingManagerCode: 'M10' })] })).json();
    expect(r.committed).toBe(true);
    const [m11] = await ownerQuery<{ mgr: string }>(`SELECT m.employee_code AS mgr FROM employees e JOIN employees m ON m.id=e.reporting_manager_id WHERE e.tenant_id=$1 AND e.employee_code='M11'`, [T.id]);
    expect(m11!.mgr).toBe('M10');
    const fail = (await hr.post('/api/v1/employees/import', { dryRun: false, rows: [row('M20'), row('M10')] })).json();
    expect(fail.committed).toBe(false);
    expect((await ownerQuery(`SELECT 1 FROM employees WHERE tenant_id=$1 AND employee_code='M20'`, [T.id])).length).toBe(0);
  });
});
