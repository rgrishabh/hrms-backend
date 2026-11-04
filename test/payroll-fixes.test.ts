import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture } from './helpers.js';
import { activeRule, activeSalary, approveEntity, compute, createRun, day, itemOf, lineOf, seedComponents } from './payroll-helpers.js';
import { calculateDay, type DayInput } from '../src/modules/attendance/calc.js';

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
