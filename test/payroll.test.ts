import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, PASSWORD, type TenantFixture, flags } from './helpers.js';
import { readXlsx } from './helpers.js';
import { hashPassword } from '../src/core/crypto/index.js';

// Rule values here are TEST FIXTURES that exercise the engine — not statutory rates.
const PF = { employeeRate: 10, employerRate: 10, epsRate: 5, wageCeiling: 15000, ceilingOnEmployee: true, ceilingOnEmployer: true };
const PT = { slabs: [{ upTo: 10000, amount: 0 }, { upTo: null, amount: 200 }] };
const TDS = { slabs: [{ upTo: 300000, rate: 0 }, { upTo: null, rate: 10 }], standardDeduction: 50000, rebateLimit: 0, rebateMax: 0, cessRate: 0 };
const PERIOD = '2026-09';
let app: FastifyInstance; let T: TenantFixture;
let pay: Client; let fin: Client; let emp: Client; let other: Client; let hr: Client;
let empId: string; let runId: string;

async function user(key: string, roles: string[]) {
  const email = `${key}@${T.host}`;
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`, [T.id, email, key, await hashPassword(PASSWORD)]);
  for (const r of roles) await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,$3)`, [u!.id, T.id, r]);
  return Client.login(app, T.host, email);
}
const approve = async (c: Client, entityId: string) => {
  const item = (await c.get('/api/v1/approvals/inbox')).json().items.find((x: { entity_id: string }) => x.entity_id === entityId);
  expect(item, 'visible to approver').toBeTruthy();
  return c.post(`/api/v1/approvals/${item.id}/act`, { action: 'approve' });
};
const rule = async (kind: string, scope: string, params: unknown) => {
  const r = await pay.post('/api/v1/payroll/statutory-rules', { kind, scope, effectiveFrom: '2026-04-01', params, sourceReference: 'Test fixture — not a statutory source' });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
};

beforeAll(async () => {
  app = await makeApp({ ...flags('default,payroll,payroll.payslips,payroll.statutory') });
  T = await createTenant();
  empId = T.users.employee!.employeeId!;
  pay = await Client.login(app, T.host, T.users.payroll!.email);
  hr = await Client.login(app, T.host, T.users.hr!.email);
  emp = await Client.login(app, T.host, T.users.employee!.email);
  other = await Client.login(app, T.host, T.users.other!.email);
  fin = await user('finance', ['finance_manager']);
  await ownerQuery(`UPDATE employees SET date_of_joining='2025-01-01' WHERE tenant_id=$1`, [T.id]);
  await ownerQuery(`INSERT INTO employee_bank_accounts (employee_id, tenant_id, account_holder, account_number_enc, account_last4, ifsc) VALUES ($1,$2,'Emp',$3,'9012','SBIN0001234')`,
    [empId, T.id, app.deps.cipher.encrypt('123456789012')]);
});
afterAll(async () => { await app.close(); });

describe('setup', () => {
  it('components: percent only of fixed components', async () => {
    expect((await pay.post('/api/v1/payroll/components', { code: 'HRA', name: 'HRA', kind: 'earning', calc: 'percent', baseCodes: ['BASIC'] })).statusCode).toBe(400); // BASIC not yet defined
    for (const c of [{ code: 'BASIC', name: 'Basic', kind: 'earning', pfWage: true, position: 1 }, { code: 'HRA', name: 'House rent allowance', kind: 'earning', calc: 'percent', baseCodes: ['BASIC'], position: 2 },
      { code: 'SPECIAL', name: 'Special allowance', kind: 'earning', position: 3 }]) expect((await pay.post('/api/v1/payroll/components', c)).statusCode).toBe(201);
    expect((await pay.post('/api/v1/payroll/components', { code: 'X', name: 'Bad', kind: 'earning', calc: 'percent', baseCodes: ['HRA'] })).statusCode).toBe(400);
    expect((await emp.get('/api/v1/payroll/components')).statusCode).toBe(403);
  });

  it('salaries need a different approver and never show figures in the approval', async () => {
    const r = await pay.post(`/api/v1/payroll/employees/${empId}/salaries`, { effectiveFrom: '2026-04-01', amounts: { BASIC: 20000, HRA: 40, SPECIAL: 6000 }, reason: 'Annual revision' });
    expect(r.statusCode).toBe(201);
    expect((await pay.post(`/api/v1/payroll/employees/${empId}/salaries`, { effectiveFrom: '2026-05-01', amounts: { NOPE: 1 }, reason: 'x unknown' })).statusCode).toBe(400);
    const inbox = (await fin.get('/api/v1/approvals/inbox')).json().items.find((x: { entity_id: string }) => x.entity_id === r.json().id);
    expect(inbox.summary).not.toMatch(/20000|26000/);
    await approve(fin, r.json().id);
    expect((await pay.get(`/api/v1/payroll/employees/${empId}/salaries`)).json().items[0].status).toBe('active');
    expect((await emp.get(`/api/v1/payroll/employees/${empId}/salaries`)).statusCode).toBe(403);
  });

  it('statutory rules are validated, and only a second person can verify (activate) them; PAN is encrypted', async () => {
    expect((await pay.post('/api/v1/payroll/statutory-rules', { kind: 'pf', scope: 'IN', effectiveFrom: '2026-04-01', params: { employeeRate: 200 }, sourceReference: 'bad values' })).statusCode).toBe(400);
    expect((await pay.post('/api/v1/payroll/statutory-rules', { kind: 'pf', scope: 'Maharashtra', effectiveFrom: '2026-04-01', params: PF, sourceReference: 'wrong scope' })).statusCode).toBe(400);
    const ids = [await rule('pf', 'IN', PF), await rule('pt', 'Maharashtra', PT), await rule('tds', 'new', TDS)];
    expect((await pay.post(`/api/v1/payroll/statutory-rules/${ids[0]}/verify`)).statusCode).toBe(403);
    for (const id of ids) expect((await fin.post(`/api/v1/payroll/statutory-rules/${id}/verify`)).statusCode).toBe(200);
    expect((await pay.put(`/api/v1/payroll/statutory-rules/${ids[0]}`, { kind: 'pf', scope: 'IN', effectiveFrom: '2026-04-01', params: PF, sourceReference: 'edit after activation' })).statusCode).toBe(409);
    expect((await pay.put(`/api/v1/payroll/employees/${empId}/statutory`, { uan: '100200300400', pan: 'ABCDE1234F', taxRegime: 'new' })).statusCode).toBe(200);
    const s = (await pay.get(`/api/v1/payroll/employees/${empId}/statutory`)).json();
    expect(s.pan).toBe('XXXXXX1234');
    const [row] = await ownerQuery<{ pan_enc: string }>(`SELECT pan_enc FROM employee_statutory WHERE employee_id=$1`, [empId]);
    expect(row!.pan_enc).not.toContain('ABCDE');
  });
});

describe('payroll run', () => {
  it('computes from attendance (LOP), with warnings that must be acknowledged', async () => {
    // Two absences, one unpaid half day; the rest of the month present.
    for (let d = 1; d <= 30; d++) {
      const day = `${PERIOD}-${String(d).padStart(2, '0')}`;
      const status = d === 3 || d === 4 ? 'absent' : d === 10 ? 'half_day' : 'present';
      await ownerQuery(`INSERT INTO attendance_daily (tenant_id, employee_id, work_date, day_type, status, calc_version) VALUES ($1,$2,$3,'working',$4,2)`, [T.id, empId, day, status]);
    }
    const r = await pay.post('/api/v1/payroll/runs', { period: PERIOD, legalEntityId: T.legalEntityId });
    expect(r.statusCode).toBe(201);
    runId = r.json().id;
    expect((await pay.post('/api/v1/payroll/runs', { period: PERIOD, legalEntityId: T.legalEntityId })).statusCode).toBe(409);
    const c = (await pay.post(`/api/v1/payroll/runs/${runId}/compute`)).json();
    expect(c.totals.employees).toBe(1); // only employees with an active salary are on payroll
    const run = (await pay.get(`/api/v1/payroll/runs/${runId}`)).json();
    const item = run.items[0];
    expect(item).toMatchObject({ employed_days: '30.00', lop_days: '2.50', paid_days: '27.50' });
    const l = (code: string) => item.lines.find((x: { code: string }) => x.code === code)?.amount;
    expect(l('BASIC')).toBe(18333);            // 20000 × 27.5/30
    expect(l('HRA')).toBe(7333);
    expect(l('PF_EE')).toBe(1500);             // ceiling
    expect(l('PT')).toBe(200);
    expect(item.warnings.join(' ')).toMatch(/ESI.*not deducted/); // ESI expected but no rule
    expect((await pay.post(`/api/v1/payroll/runs/${runId}/submit`)).json().error.message).toMatch(/acknowledge/);
  });

  it('adjustments force a recompute; LOP can be corrected', async () => {
    expect((await pay.post(`/api/v1/payroll/runs/${runId}/adjustments`, { employeeId: empId, kind: 'lop_days', label: 'Absence on 3rd regularized late', amount: -1 })).statusCode).toBe(201);
    expect((await pay.post(`/api/v1/payroll/runs/${runId}/adjustments`, { employeeId: empId, kind: 'earning', label: 'Night sampling allowance', amount: 1500 })).statusCode).toBe(201);
    expect((await pay.get(`/api/v1/payroll/runs/${runId}`)).json().status).toBe('draft');
    expect((await pay.post(`/api/v1/payroll/runs/${runId}/submit`)).statusCode).toBe(409);
    await pay.post(`/api/v1/payroll/runs/${runId}/compute`);
    const item = (await pay.get(`/api/v1/payroll/runs/${runId}`)).json().items[0];
    expect(item.lop_days).toBe('1.50');
    expect(item.lines.some((x: { name: string }) => x.name === 'Night sampling allowance')).toBe(true);
  });

  it('a different person approves; finalize needs locked attendance; finalized runs are immutable', async () => {
    await pay.post(`/api/v1/payroll/runs/${runId}/acknowledge-warnings`, { note: 'ESI not applicable at this branch — confirmed with consultant' });
    expect((await pay.post(`/api/v1/payroll/runs/${runId}/submit`)).statusCode).toBe(200);
    expect((await pay.get('/api/v1/approvals/inbox')).json().items.some((x: { entity_id: string }) => x.entity_id === runId)).toBe(false);
    await approve(fin, runId);
    expect((await pay.post(`/api/v1/payroll/runs/${runId}/finalize`)).json().error.message).toMatch(/Lock attendance/);
    await ownerQuery(`INSERT INTO attendance_period_locks (tenant_id, period_start, period_end, locked_by) VALUES ($1,'2026-09-01','2026-09-30',$2)`, [T.id, T.users.payroll!.id]);
    // The result predates the lock, so it has to be recomputed and approved again.
    expect((await pay.post(`/api/v1/payroll/runs/${runId}/finalize`)).json().error.message).toMatch(/Reopen the run/);
    expect((await pay.post(`/api/v1/payroll/runs/${runId}/reopen`)).statusCode).toBe(200);
    expect((await pay.post(`/api/v1/payroll/runs/${runId}/compute`)).statusCode).toBe(200);
    await pay.post(`/api/v1/payroll/runs/${runId}/acknowledge-warnings`, { note: 'ESI not applicable at this branch — confirmed with consultant' });
    expect((await pay.post(`/api/v1/payroll/runs/${runId}/submit`)).statusCode).toBe(200);
    await approve(fin, runId);
    expect((await pay.post(`/api/v1/payroll/runs/${runId}/finalize`)).json()).toMatchObject({ ok: true, payslips: 1 });
    await expect(ownerQuery(`UPDATE payroll_items SET net=0 WHERE run_id=$1`, [runId])).rejects.toThrow(/finalized and cannot be changed/);
    expect((await pay.post(`/api/v1/payroll/runs/${runId}/adjustments`, { employeeId: empId, kind: 'earning', label: 'Too late', amount: 1 })).statusCode).toBe(409);
    expect((await pay.post(`/api/v1/payroll/employees/${empId}/salaries`, { effectiveFrom: '2026-09-15', amounts: { BASIC: 1 }, reason: 'Backdated into a closed month' })).statusCode).toBe(409);
  });

  it('employees see their own payslip only; exports are audited and mask accounts without bank access', async () => {
    const mine = (await emp.get('/api/v1/payroll/payslips/mine')).json().items;
    expect(mine).toHaveLength(1);
    const slip = (await emp.get(`/api/v1/payroll/payslips/${mine[0].id}`)).json();
    expect(slip).toMatchObject({ period: PERIOD, pan: 'XXXXXX1234X', account: 'XXXXXX9012' });
    expect((await other.get(`/api/v1/payroll/payslips/${mine[0].id}`)).statusCode).toBe(404);
    expect((await ownerQuery(`SELECT 1 FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND kind='payroll.payslip'`, [T.id, T.users.employee!.id])).length).toBe(1);
    const bankFull = (await pay.get(`/api/v1/payroll/runs/${runId}/bank.csv`)).body;
    expect(bankFull.split('\r\n')[1]).toMatch(/123456789012$/);       // payroll manager holds employees.bank.read
    const bankMasked = (await fin.get(`/api/v1/payroll/runs/${runId}/bank.csv`)).body;
    expect(bankMasked.split('\r\n')[1]).toMatch(/XXXXXX9012$/);
    expect((await pay.get(`/api/v1/payroll/runs/${runId}/pf.csv`)).body.split('\r\n')[1]).toMatch(/^100200300400,/);
    expect((await pay.get(`/api/v1/payroll/runs/${runId}/register.csv`)).body.split('\r\n')[0]).toMatch(/^employee_code,name,paid_days,lop_days,BASIC/);
    expect((await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action LIKE 'payroll.export_%'`, [T.id])).length).toBe(4);
    const reg = await pay.get(`/api/v1/payroll/runs/${runId}/register.xlsx`);
    expect(reg.headers['content-type']).toMatch(/spreadsheetml/);
    const regSheet = readXlsx(reg.rawPayload)['xl/worksheets/sheet1.xml']!;
    expect(regSheet).toMatch(/<c r="A2" t="inlineStr"><is><t xml:space="preserve">E\d+<\/t>/);   // codes stay text
    expect(regSheet).toMatch(/<c r="C2"><v>\d+(\.\d+)?<\/v><\/c>/);                              // paid days are numbers
    expect((await pay.get(`/api/v1/payroll/runs/${runId}/bank.xlsx`)).statusCode).toBe(404);          // bank files stay CSV
    expect((await pay.post(`/api/v1/payroll/runs/${runId}/paid`, { paymentReference: 'NEFT-2026-09-001' })).statusCode).toBe(200);
  });

  it('F&F runs need an approved separation; module off → 403', async () => {
    expect((await pay.post('/api/v1/payroll/runs', { period: PERIOD, legalEntityId: T.legalEntityId, kind: 'fnf', employeeId: empId })).statusCode).toBe(409);
    const off = await makeApp({ ...flags('default') });
    try { expect((await (await Client.login(off, T.host, T.users.payroll!.email)).get('/api/v1/payroll/runs')).json().error.code).toBe('not_found'); }
    finally { await off.close(); }
    void hr;
  });
});
