import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture } from './helpers.js';
import { activeRule, activeSalary, approveEntity, compute, createRun, day, itemOf, lineOf, seedComponents } from './payroll-helpers.js';
import { calculateDay, type DayInput } from '../src/modules/attendance/calc.js';
import { csvCell } from '../src/core/http/csv.js';

const MODULES = 'default,payroll,payroll.payslips,payroll.statutory';
let app: FastifyInstance; let T: TenantFixture; let pay: Client; let emp: string;

beforeAll(async () => {
  app = await makeApp({ ENABLED_MODULES: MODULES });
  T = await createTenant();
  pay = await Client.login(app, T.host, T.users.payroll!.email);
  emp = T.users.employee!.employeeId!;
  await seedComponents(T);
  await activeSalary(T, emp, '2020-01-01', { BASIC: 30000 });
  await ownerQuery(`INSERT INTO leave_types (tenant_id, code, name, paid, requires_balance, accrual_method) VALUES ($1,'CL','Casual',true,true,'annual'),($1,'LWP','Without pay',false,false,'none')`, [T.id]);
});
afterAll(async () => { await app.close(); });

async function finance(W: TenantFixture) {
  const email = `fin@${W.host}`;
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) SELECT tenant_id, $2, 'fin', password_hash FROM users WHERE id=$1 RETURNING id`, [W.users.payroll!.id, email]);
  await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'finance_manager')`, [u!.id, W.id]);
  return Client.login(app, W.host, email);
}
async function toApproved(p: Client, f: Client, runId: string) {
  await p.post(`/api/v1/payroll/runs/${runId}/acknowledge-warnings`, { note: 'Fixture warnings' });
  const s = await p.post(`/api/v1/payroll/runs/${runId}/submit`);
  expect(s.statusCode, s.body).toBe(200);
  const a = await approveEntity(f, runId);
  expect(a.statusCode, a.body).toBe(200);
}

describe('F-1 half-day leave and loss of pay', () => {
  const dayInput = (o: Partial<DayInput>): DayInput => ({ workDate: '2026-01-05', timezone: 'Asia/Kolkata', shift: null, dayType: 'working', employment: { joiningDate: '2020-01-01', exitDate: null },
    punches: [], minGapSeconds: 60, overtimeEnabled: false, ...o });

  it('the engine reports half paid leave with no work as half_day, and a worked other half as present', () => {
    expect(calculateDay(dayInput({ leave: { fraction: 0.5, code: 'CL' } })).status).toBe('half_day');
    const worked = calculateDay(dayInput({ leave: { fraction: 0.5, code: 'CL' }, punches: [
      { id: 'a', time: new Date('2026-01-05T04:00:00Z'), direction: 'in' }, { id: 'b', time: new Date('2026-01-05T09:00:00Z'), direction: 'out' }] }));
    expect(worked.status).toBe('present');
  });

  it.each([
    ['half paid leave, other half unworked', '2026-01', 'half_day', 0.5, 'CL', '0.50'],
    ['half unpaid leave, other half unworked', '2026-02', 'half_day', 0.5, 'LWP', '1.00'],
    ['half paid leave, other half worked', '2026-03', 'present', 0.5, 'CL', '0.00'],
    ['half unpaid leave, other half worked', '2026-04', 'present', 0.5, 'LWP', '0.50'],
    ['half day of work, no leave', '2026-05', 'half_day', 0, null, '0.50'],
  ])('%s', async (_name, period, status, lf, code, expected) => {
    await day(T, emp, `${period}-05`, status, { leaveFraction: lf, code: code ?? undefined });
    const id = await createRun(pay, T, period);
    await compute(pay, id);
    expect((await itemOf(pay, id, emp))!.lop_days).toBe(expected);
  });
});

describe('F-5 ESI contribution periods through a run', () => {
  const ESI = { employeeRate: 1, employerRate: 3, wageThreshold: 21000, rounding: 'up' };
  let W: TenantFixture; let p: Client;
  beforeAll(async () => {
    W = await createTenant();
    p = await Client.login(app, W.host, W.users.payroll!.email);
    await seedComponents(W);
    await activeRule(W, 'esi', 'IN', ESI);
  });

  it('a raise mid-period keeps cover until the next period; a cut mid-period does not start it', async () => {
    const raised = W.users.employee!.employeeId!; const cut = W.users.other!.employeeId!;
    await activeSalary(W, raised, '2024-01-01', { BASIC: 20000 });
    await activeSalary(W, raised, '2026-07-01', { BASIC: 25000 });
    await activeSalary(W, cut, '2024-01-01', { BASIC: 25000 });
    await activeSalary(W, cut, '2026-07-01', { BASIC: 20000 });
    const july = await createRun(p, W, '2026-07');
    await compute(p, july);
    expect(lineOf(await itemOf(p, july, raised), 'ESI_EE')).toBe(250);
    expect(lineOf(await itemOf(p, july, cut), 'ESI_EE')).toBeUndefined();
    const oct = await createRun(p, W, '2026-10');
    await compute(p, oct);
    expect(lineOf(await itemOf(p, oct, raised), 'ESI_EE')).toBeUndefined();
    expect(lineOf(await itemOf(p, oct, cut), 'ESI_EE')).toBe(200);
    const jan = await createRun(p, W, '2027-01');   // same contribution period as October
    await compute(p, jan);
    expect(lineOf(await itemOf(p, jan, cut), 'ESI_EE')).toBe(200);
  });

  it('a joiner is judged on their first salary in the period', async () => {
    const J = W.users.manager!.employeeId!;
    await ownerQuery(`UPDATE employees SET date_of_joining='2026-08-15' WHERE id=$1`, [J]);
    await activeSalary(W, J, '2026-08-15', { BASIC: 20000 });
    await activeSalary(W, J, '2026-09-01', { BASIC: 30000 });
    const sep = await createRun(p, W, '2026-09');
    await compute(p, sep);
    expect(lineOf(await itemOf(p, sep, J), 'ESI_EE')).toBe(300);
  });
});

describe('F-6 salary change within the month', () => {
  let W: TenantFixture; let p: Client; let e: string;
  beforeAll(async () => {
    W = await createTenant();
    p = await Client.login(app, W.host, W.users.payroll!.email);
    e = W.users.employee!.employeeId!;
    await seedComponents(W);
    await activeSalary(W, e, '2024-01-01', { BASIC: 30000 });
    await activeSalary(W, e, '2026-09-20', { BASIC: 60000 });
  });

  it('an increment on the 20th pays 19 days at the old rate and 11 at the new', async () => {
    const id = await createRun(p, W, '2026-09');
    await compute(p, id);
    const i = await itemOf(p, id, e);
    expect(lineOf(i, 'BASIC')).toBe(19000 + 22000);
    expect(i!.paid_days).toBe('30.00');
    expect(i!.lines.find((l) => l.code === 'BASIC')!.basis).toMatch(/2026-09-20/);
  });

  it('loss of pay lands on the days it happened', async () => {
    await day(W, e, '2026-08-05', 'absent');
    await activeSalary(W, e, '2026-08-20', { BASIC: 62000 });
    const id = await createRun(p, W, '2026-08');
    await compute(p, id);
    const i = await itemOf(p, id, e);
    // 31 days: 19 at 30000 less one absent day = 18/31 × 30000; 12 at 62000 = 12/31 × 62000.
    expect(lineOf(i, 'BASIC')).toBe(Math.round(18 / 31 * 30000) + Math.round(12 / 31 * 62000));
    expect(i!.lop_days).toBe('1.00');
    expect(i!.paid_days).toBe('30.00');
  });

  it('days before the first salary are unpaid and flagged', async () => {
    const o = W.users.other!.employeeId!;
    await activeSalary(W, o, '2026-07-11', { BASIC: 31000 });
    const id = await createRun(p, W, '2026-07');
    await compute(p, id);
    const i = await itemOf(p, id, o);
    expect(lineOf(i, 'BASIC')).toBe(21000);
    expect(i!.paid_days).toBe('21.00');
    expect(i!.warnings.join(' ')).toMatch(/2026-07-11/);
  });
});

describe('F-3 full-and-final and regular runs never pay the same days', () => {
  let W: TenantFixture; let p: Client;
  const leaver = async (who: string, lwd: string) => {
    const id = W.users[who]!.employeeId!;
    await activeSalary(W, id, '2024-01-01', { BASIC: 30000 });
    await ownerQuery(`UPDATE employees SET exit_date=$2, status='on_notice' WHERE id=$1`, [id, lwd]);
    await ownerQuery(`INSERT INTO separations (tenant_id, employee_id, kind, reason, notice_date, notice_days_required, requested_lwd, approved_lwd, status, initiated_by)
      VALUES ($1,$2,'resignation','Fixture','2025-01-01',30,$3,$3,'approved',$4)`, [W.id, id, lwd, W.users.hr!.id]);
    return id;
  };
  beforeAll(async () => {
    W = await createTenant();
    p = await Client.login(app, W.host, W.users.payroll!.email);
    await seedComponents(W, [{ code: 'FLAT', taxable: false, esi: false }]);
    await activeRule(W, 'pt', 'Maharashtra', { slabs: [{ upTo: null, amount: 200 }] });
    await activeRule(W, 'lwf', 'Maharashtra', { employee: 12, employer: 36, months: [3, 6] });
  });

  it('an open F&F run takes the leaver out of the regular run for that month', async () => {
    const id = await leaver('employee', '2026-03-15');
    const fnf = await createRun(p, W, '2026-03', { kind: 'fnf', employeeId: id });
    await compute(p, fnf);
    expect(lineOf(await itemOf(p, fnf, id), 'BASIC')).toBe(Math.round(15 / 31 * 30000));
    const reg = await createRun(p, W, '2026-03');
    await compute(p, reg);
    expect(await itemOf(p, reg, id)).toBeUndefined();
  });

  it('computing F&F sends a computed regular run back to be recomputed without the leaver', async () => {
    const id = await leaver('other', '2026-04-10');
    const reg = await createRun(p, W, '2026-04');
    await compute(p, reg);
    expect(await itemOf(p, reg, id)).toBeTruthy();
    const fnf = await createRun(p, W, '2026-04', { kind: 'fnf', employeeId: id });
    await compute(p, fnf);
    expect((await p.get(`/api/v1/payroll/runs/${reg}`)).json().status).toBe('draft');
    expect((await p.post(`/api/v1/payroll/runs/${reg}/submit`)).statusCode).toBe(409);
    await compute(p, reg);
    expect(await itemOf(p, reg, id)).toBeUndefined();
  });

  it('when the regular run has the salary, F&F pays only its adjustments and no second PT or LWF', async () => {
    const id = await leaver('manager', '2026-06-10');
    const reg = await createRun(p, W, '2026-06');
    await compute(p, reg);
    const first = await itemOf(p, reg, id);
    expect(first!.paid_days).toBe('10.00');
    await p.post(`/api/v1/payroll/runs/${reg}/acknowledge-warnings`, { note: 'Fixture warnings' });
    expect((await p.post(`/api/v1/payroll/runs/${reg}/submit`)).statusCode).toBe(200);
    const fnf = await createRun(p, W, '2026-06', { kind: 'fnf', employeeId: id });
    expect((await p.post(`/api/v1/payroll/runs/${fnf}/adjustments`, { employeeId: id, kind: 'earning', label: 'Leave encashment', amount: 5000 })).statusCode).toBe(201);
    await compute(p, fnf);
    const i = await itemOf(p, fnf, id);
    expect(i!.paid_days).toBe('0.00');
    expect(i!.gross).toBe('5000.00');
    expect(lineOf(i, 'BASIC')).toBeUndefined();
    expect(lineOf(i, 'PT')).toBeUndefined();
    expect(lineOf(i, 'LWF_EE')).toBeUndefined();
    expect(i!.warnings.join(' ')).toMatch(/regular run/);
  });

  it('allows one F&F run per employee until it is cancelled', async () => {
    const id = W.users.hr!.employeeId!;
    await leaver('hr', '2026-07-10');
    const fnf = await createRun(p, W, '2026-07', { kind: 'fnf', employeeId: id });
    const dup = await p.post('/api/v1/payroll/runs', { period: '2026-07', legalEntityId: W.legalEntityId, kind: 'fnf', employeeId: id });
    expect(dup.statusCode).toBe(409);
    expect((await p.post(`/api/v1/payroll/runs/${fnf}/cancel`)).statusCode).toBe(200);
    expect((await p.post('/api/v1/payroll/runs', { period: '2026-07', legalEntityId: W.legalEntityId, kind: 'fnf', employeeId: id })).statusCode).toBe(201);
  });
});

describe('F-7 finalize refuses a stale result', () => {
  let W: TenantFixture; let p: Client; let f: Client; let e: string;
  beforeAll(async () => {
    W = await createTenant();
    p = await Client.login(app, W.host, W.users.payroll!.email);
    f = await finance(W);
    e = W.users.employee!.employeeId!;
    await seedComponents(W);
    await activeSalary(W, e, '2024-01-01', { BASIC: 30000 });
  });

  it('a run computed before attendance was locked must be reopened and recomputed', async () => {
    const id = await createRun(p, W, '2026-02');
    await compute(p, id);
    expect((await itemOf(p, id, e))!.lop_days).toBe('0.00');
    await toApproved(p, f, id);
    expect((await p.post('/api/v1/attendance/locks', { periodStart: '2026-02-01', periodEnd: '2026-02-28' })).statusCode).toBe(201);
    const stale = await p.post(`/api/v1/payroll/runs/${id}/finalize`);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.message).toMatch(/recompute|reopen/i);
    expect((await p.post(`/api/v1/payroll/runs/${id}/reopen`)).statusCode).toBe(200);
    expect((await p.get(`/api/v1/payroll/runs/${id}`)).json().status).toBe('draft');
    await compute(p, id);
    expect(Number((await itemOf(p, id, e))!.lop_days)).toBeGreaterThan(0);
    await toApproved(p, f, id);
    const ok = await p.post(`/api/v1/payroll/runs/${id}/finalize`);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('a run computed by an older calculation version must be recomputed', async () => {
    expect((await p.post('/api/v1/attendance/locks', { periodStart: '2026-03-01', periodEnd: '2026-03-31' })).statusCode).toBe(201);
    const id = await createRun(p, W, '2026-03');
    await compute(p, id);
    await toApproved(p, f, id);
    await ownerQuery(`UPDATE payroll_items SET calc_version=1 WHERE run_id=$1`, [id]);
    expect((await p.post(`/api/v1/payroll/runs/${id}/finalize`)).statusCode).toBe(409);
  });

  it('an F&F run needs recomputing when the attendance behind it changed', async () => {
    const o = W.users.other!.employeeId!;
    await activeSalary(W, o, '2024-01-01', { BASIC: 30000 });
    await ownerQuery(`UPDATE employees SET exit_date='2026-04-10', status='on_notice' WHERE id=$1`, [o]);
    await ownerQuery(`INSERT INTO separations (tenant_id, employee_id, kind, reason, notice_date, notice_days_required, requested_lwd, approved_lwd, status, initiated_by)
      VALUES ($1,$2,'resignation','Fixture','2026-03-01',30,'2026-04-10','2026-04-10','approved',$3)`, [W.id, o, W.users.hr!.id]);
    const id = await createRun(p, W, '2026-04', { kind: 'fnf', employeeId: o });
    await compute(p, id);
    await toApproved(p, f, id);
    await ownerQuery(`INSERT INTO attendance_daily (tenant_id, employee_id, work_date, day_type, status, calc_version, calculated_at) VALUES ($1,$2,'2026-04-06','working','absent',3,now() + interval '1 minute')`, [W.id, o]);
    expect((await p.post(`/api/v1/payroll/runs/${id}/finalize`)).statusCode).toBe(409);
  });

  it('only an approved run can be reopened, by someone who manages payroll', async () => {
    const id = await createRun(p, W, '2026-05');
    expect((await p.post(`/api/v1/payroll/runs/${id}/reopen`)).statusCode).toBe(409);
    expect((await f.post(`/api/v1/payroll/runs/${id}/reopen`)).statusCode).toBe(403);
  });
});

describe('other payroll findings (AUDIT 4.2)', () => {
  let W: TenantFixture; let p: Client; let f: Client; let e: string;
  beforeAll(async () => {
    W = await createTenant();
    p = await Client.login(app, W.host, W.users.payroll!.email);
    f = await finance(W);
    e = W.users.employee!.employeeId!;
    await seedComponents(W);
    await activeSalary(W, e, '2024-01-01', { BASIC: 30000 });
  });

  it('salary approval refuses a date a finalized run came to cover after the proposal', async () => {
    const o = W.users.other!.employeeId!;
    await activeSalary(W, o, '2024-01-01', { BASIC: 30000 });
    const sal = await p.post(`/api/v1/payroll/employees/${o}/salaries`, { effectiveFrom: '2026-01-15', amounts: { BASIC: 40000 }, reason: 'Proposed before the run closed' });
    expect(sal.statusCode, sal.body).toBe(201);
    expect((await p.post('/api/v1/attendance/locks', { periodStart: '2026-01-01', periodEnd: '2026-01-31' })).statusCode).toBe(201);
    const id = await createRun(p, W, '2026-01');
    await compute(p, id);
    await toApproved(p, f, id);
    expect((await p.post(`/api/v1/payroll/runs/${id}/finalize`)).statusCode).toBe(200);
    const late = await approveEntity(f, sal.json().id);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.message).toMatch(/finalized/);
  });

  it('whoever computed or adjusted a run cannot approve it, not only the submitter', async () => {
    const [row] = await ownerQuery<{ id: string }>(`SELECT id FROM users WHERE email=$1`, [W.users.hr!.email]);
    await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'payroll_manager'),($1,$2,'finance_manager') ON CONFLICT DO NOTHING`, [row!.id, W.id]);
    const both = await Client.login(app, W.host, W.users.hr!.email);
    const id = await createRun(p, W, '2026-06');
    expect((await both.post(`/api/v1/payroll/runs/${id}/adjustments`, { employeeId: e, kind: 'earning', label: 'Hand-keyed bonus', amount: 100 })).statusCode).toBe(201);
    await compute(both, id);
    await p.post(`/api/v1/payroll/runs/${id}/acknowledge-warnings`, { note: 'Fixture warnings' });
    expect((await p.post(`/api/v1/payroll/runs/${id}/submit`)).statusCode).toBe(200);
    const inbox = (await both.get('/api/v1/approvals/inbox')).json().items;
    expect(inbox.some((x: { entity_id: string }) => x.entity_id === id)).toBe(false);
    expect((await approveEntity(f, id)).statusCode).toBe(200);
  });

  it('PUT statutory keeps what it was not sent; null clears', async () => {
    const put = (b: unknown) => p.put(`/api/v1/payroll/employees/${e}/statutory`, b);
    expect((await put({ uan: '100200300400', esiIpNumber: '1234567890', pfMemberId: 'PF1', ptState: 'Goa', taxRegime: 'old', pfExcluded: true })).statusCode).toBe(200);
    expect((await put({ taxRegime: 'new' })).statusCode).toBe(200);
    let s = (await p.get(`/api/v1/payroll/employees/${e}/statutory`)).json();
    expect(s).toMatchObject({ uan: '100200300400', esi_ip_number: '1234567890', pf_member_id: 'PF1', pt_state: 'Goa', tax_regime: 'new', pf_excluded: true });
    expect((await put({ uan: null })).statusCode).toBe(200);
    s = (await p.get(`/api/v1/payroll/employees/${e}/statutory`)).json();
    expect(s.uan).toBeNull();
    expect(s.esi_ip_number).toBe('1234567890');
  });

  it('csv keeps negative numbers numeric and still neutralizes formulas', () => {
    expect(csvCell('-1250.50')).toBe('-1250.50');
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell('-1+1')).toBe("'-1+1");
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+919999')).toBe("'+919999");
  });
});

describe('F-12 held pay', () => {
  let W: TenantFixture; let p: Client; let f: Client; let e: string; let loan: string; let run: string;
  let loansApp: FastifyInstance;
  beforeAll(async () => {
    loansApp = await makeApp({ ENABLED_MODULES: `${MODULES},advances_loans` });
    W = await createTenant();
    p = await Client.login(loansApp, W.host, W.users.payroll!.email);
    const email = `fin@${W.host}`;
    const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) SELECT tenant_id, $2, 'fin', password_hash FROM users WHERE id=$1 RETURNING id`, [W.users.payroll!.id, email]);
    await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'finance_manager')`, [u!.id, W.id]);
    f = await Client.login(loansApp, W.host, email);
    e = W.users.employee!.employeeId!;
    await seedComponents(W);
    await activeSalary(W, e, '2024-01-01', { BASIC: 30000 });
    await ownerQuery(`INSERT INTO employee_bank_accounts (employee_id, tenant_id, account_holder, account_number_enc, account_last4, ifsc) VALUES ($1,$2,'Emp',$3,'9012','SBIN0001234')`, [e, W.id, loansApp.deps.cipher.encrypt('123456789012')]);
    const [l] = await ownerQuery<{ id: string }>(`INSERT INTO employee_loans (tenant_id, employee_id, kind, amount, installments, installment_amount, first_period, purpose, status, created_by, disbursed_at)
      VALUES ($1,$2,'salary_advance',1000,1,1000,'2026-01','Fixture purpose','disbursed',$3,now()) RETURNING id`, [W.id, e, W.users.hr!.id]);
    loan = l!.id;
    await p.post('/api/v1/attendance/locks', { periodStart: '2026-01-01', periodEnd: '2026-01-31' });
    run = await createRun(p, W, '2026-01');
    await compute(p, run);
    expect((await p.post(`/api/v1/payroll/runs/${run}/hold`, { employeeId: e, hold: true })).statusCode).toBe(200);
    await toApproved(p, f, run);
    expect((await p.post(`/api/v1/payroll/runs/${run}/finalize`)).statusCode).toBe(200);
  });
  afterAll(async () => { await loansApp.close(); });
  const status = async () => (await ownerQuery<{ status: string }>(`SELECT status FROM employee_loans WHERE id=$1`, [loan]))[0]!.status;

  it('held pay is not a final recovery: the loan stays open and shows the amount in progress', async () => {
    expect(await status()).toBe('disbursed');
    const hrc = await Client.login(loansApp, W.host, W.users.hr!.email);
    const d = (await hrc.get(`/api/v1/loans/requests/${loan}`)).json();
    expect(d.recovered ?? d.balance?.recovered).toBe('0.00');
    expect(d.inProgress ?? d.balance?.inProgress).toBe('1000.00');
  });

  it('only a payroll approver can release, and it opens payslip, loan closure and a separate bank file', async () => {
    const url = `/api/v1/payroll/runs/${run}/items/${e}/release`;
    expect((await p.post(url, { reason: 'Documents received' })).statusCode).toBe(403);
    const before = (await p.get(`/api/v1/payroll/runs/${run}/bank.csv`)).body;
    expect(before).not.toContain('XXXXXX9012');
    expect(before).not.toContain('123456789012');
    expect((await f.post(url, { reason: 'x' })).statusCode).toBe(400);
    const r = await f.post(url, { reason: 'Documents received' });
    expect(r.statusCode, r.body).toBe(200);
    expect((await f.post(url, { reason: 'Documents received' })).statusCode).toBe(409);
    expect(await status()).toBe('closed');
    const emp = await Client.login(loansApp, W.host, W.users.employee!.email);
    expect((await emp.get('/api/v1/payroll/payslips/mine')).json().items).toHaveLength(1);
    expect((await ownerQuery(`SELECT 1 FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND kind='payroll.payslip'`, [W.id, W.users.employee!.id])).length).toBe(1);
    expect((await p.get(`/api/v1/payroll/runs/${run}/bank.csv`)).body).not.toContain('123456789012');   // the original file does not change
    expect((await p.get(`/api/v1/payroll/runs/${run}/bank-released.csv`)).body).toContain('123456789012');
    await expect(ownerQuery(`UPDATE payroll_items SET net=1 WHERE run_id=$1`, [run])).rejects.toThrow(/cannot be changed/);
  });

  it('release is for held items of finalized runs', async () => {
    const o = await createRun(p, W, '2026-02');
    expect((await f.post(`/api/v1/payroll/runs/${o}/items/${e}/release`, { reason: 'Too early' })).statusCode).toBe(409);
  });
});
