import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture } from './helpers.js';
import { activeRule, activeSalary, compute, createRun, day, itemOf, lineOf, seedComponents } from './payroll-helpers.js';
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
