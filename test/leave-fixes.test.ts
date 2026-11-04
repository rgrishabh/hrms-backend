import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture, flags } from './helpers.js';

const MODULES = 'default,payroll,payroll.payslips,payroll.statutory,overtime,core.offboarding';
let app: FastifyInstance;
const typeBody = (o: Record<string, unknown>) => ({ paid: true, allowHalfDay: true, requiresBalance: true, accrualMethod: 'annual', annualEntitlement: 12, carryForwardMax: 0, ...o });

interface World { T: TenantFixture; hr: Client; emp: Client; empId: string }
async function world(): Promise<World> {
  const T = await createTenant();
  return { T, hr: await Client.login(app, T.host, T.users.hr!.email), emp: await Client.login(app, T.host, T.users.employee!.email), empId: T.users.employee!.employeeId! };
}
const balanceOf = async (c: Client, code: string, year: number) => (await c.get(`/api/v1/leave/balances?year=${year}`)).json().items.find((x: { code: string }) => x.code === code);

beforeAll(async () => { app = await makeApp({ ...flags(MODULES) }); });
afterAll(async () => { await app.close(); });

describe('F-2 year-end carry-forward', () => {
  const Y = 2024;
  it('moves carried days out of the closed year, so they exist only once', async () => {
    const w = await world();
    await w.hr.post('/api/v1/leave/types', typeBody({ code: 'EL', name: 'Earned', annualEntitlement: 15, carryForwardMax: 10 }));
    await w.hr.post('/api/v1/leave/accruals', { leaveYear: Y });
    const r = await w.hr.post('/api/v1/leave/year-end', { leaveYear: Y });
    expect(r.statusCode, r.body).toBe(200);
    expect((await balanceOf(w.emp, 'EL', Y)).balance).toBe('0.00');
    expect((await balanceOf(w.emp, 'EL', Y + 1)).balance).toBe('10.00');
    const [sum] = await ownerQuery<{ s: string }>(`SELECT sum(days)::text AS s FROM leave_ledger WHERE tenant_id=$1 AND employee_id=$2`, [w.T.id, w.empId]);
    expect(sum!.s).toBe('10.00');
  });

  it('refuses leave, adjustments and accruals in a closed year; leave without pay still works', async () => {
    const w = await world();
    const el = (await w.hr.post('/api/v1/leave/types', typeBody({ code: 'EL', name: 'Earned', annualEntitlement: 15, carryForwardMax: 15 }))).json().id;
    const lwp = (await w.hr.post('/api/v1/leave/types', typeBody({ code: 'LWP', name: 'Unpaid', paid: false, requiresBalance: false, accrualMethod: 'none' }))).json().id;
    await w.hr.post('/api/v1/leave/accruals', { leaveYear: Y });
    await w.hr.post('/api/v1/leave/year-end', { leaveYear: Y });
    const r = await w.hr.post('/api/v1/leave/requests', { leaveTypeId: el, startDate: '2024-06-03', endDate: '2024-06-04', reason: 'Backdated', employeeId: w.empId });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toMatch(/closed/i);
    expect((await w.hr.post('/api/v1/leave/requests', { leaveTypeId: lwp, startDate: '2024-06-03', endDate: '2024-06-04', reason: 'Backdated unpaid', employeeId: w.empId })).statusCode).toBe(201);
    expect((await w.hr.post('/api/v1/leave/adjustments', { employeeId: w.empId, leaveTypeId: el, leaveYear: Y, days: 1, note: 'Into closed year' })).statusCode).toBe(409);
    expect((await w.hr.post('/api/v1/leave/accruals', { leaveYear: Y })).statusCode).toBe(409);
  });

  it('F&F and separation leave balances count only the leave year of the last working day', async () => {
    const w = await world();
    await w.hr.post('/api/v1/leave/types', typeBody({ code: 'EL', name: 'Earned', annualEntitlement: 15, carryForwardMax: 10 }));
    await w.hr.post('/api/v1/leave/accruals', { leaveYear: Y });
    await w.hr.post('/api/v1/leave/year-end', { leaveYear: Y });
    await w.hr.post('/api/v1/leave/accruals', { leaveYear: Y + 1 });
    const pay = await Client.login(app, w.T.host, w.T.users.payroll!.email);
    const [sep] = await ownerQuery<{ id: string }>(`INSERT INTO separations (tenant_id, employee_id, kind, reason, notice_date, notice_days_required, requested_lwd, approved_lwd, status, initiated_by)
      VALUES ($1,$2,'resignation','Fixture','2025-05-01',30,'2025-06-30','2025-06-30','approved',$3) RETURNING id`, [w.T.id, w.empId, w.T.users.hr!.id]);
    const s = await pay.get(`/api/v1/payroll/fnf-suggestions/${w.empId}`);
    expect(s.statusCode, s.body).toBe(200);
    // 10 carried into 2025 plus 15 accrued in 2025; neither the old closed year nor anything else.
    expect(s.json().leaveBalances.find((l: { code: string }) => l.code === 'EL').balance).toBe('25.00');
    expect(s.json().leaveYear).toBe(2025);
    const d = await w.hr.get(`/api/v1/lifecycle/separations/${sep!.id}`);
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().leaveBalances.find((l: { code: string }) => l.code === 'EL').balance).toBe('25.00');
  });

  it('refuses to close a leave year that has not ended', async () => {
    const w = await world();
    const r = await w.hr.post('/api/v1/leave/year-end', { leaveYear: new Date().getUTCFullYear() });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toMatch(/has not ended|runs until/i);
  });

  it('caps the carried amount at max_balance and lapses the rest', async () => {
    const w = await world();
    await w.hr.post('/api/v1/leave/types', typeBody({ code: 'EL', name: 'Earned', annualEntitlement: 15, carryForwardMax: 12, maxBalance: 8 }));
    await w.hr.post('/api/v1/leave/adjustments', { employeeId: w.empId, leaveTypeId: (await w.hr.get('/api/v1/leave/types')).json().items[0].id, leaveYear: Y, days: 10, note: 'Opening fixture' });
    await w.hr.post('/api/v1/leave/year-end', { leaveYear: Y });
    expect((await balanceOf(w.emp, 'EL', Y + 1)).balance).toBe('8.00');
    expect((await balanceOf(w.emp, 'EL', Y)).balance).toBe('0.00');
  });

  it('re-running year-end on a year closed by the old code repairs it, once, without carrying again', async () => {
    const w = await world();
    const el = (await w.hr.post('/api/v1/leave/types', typeBody({ code: 'EL', name: 'Earned', annualEntitlement: 15, carryForwardMax: 10 }))).json().id;
    await ownerQuery(`INSERT INTO leave_ledger (tenant_id, employee_id, leave_type_id, leave_year, entry_type, days, reference) VALUES
      ($1,$2,$3,${Y},'accrual',15,'legacy-a'), ($1,$2,$3,${Y},'lapse',-5,$4), ($1,$2,$3,${Y + 1},'carry_forward',10,$5), ($1,$2,$3,${Y},'consumption',-3,'legacy-after-close')`,
      [w.T.id, w.empId, el, `yearend:lapse:${el}:${w.empId}:${Y}`, `yearend:carry:${el}:${w.empId}:${Y}`]);
    await ownerQuery(`INSERT INTO leave_year_closures (tenant_id, leave_year, backfilled) VALUES ($1,${Y},true)`, [w.T.id]);
    const first = (await w.hr.post('/api/v1/leave/year-end', { leaveYear: Y })).json();
    expect(first.repaired).toBe(1);
    expect(first.overspent).toBe(1);   // 3 days were spent in the closed year after it had been carried: HR decides
    expect(first.balancesProcessed).toBe(0);
    expect((await balanceOf(w.emp, 'EL', Y)).balance).toBe('-3.00');
    expect((await balanceOf(w.emp, 'EL', Y + 1)).balance).toBe('10.00');
    expect((await w.hr.post('/api/v1/leave/year-end', { leaveYear: Y })).json().repaired).toBe(0);
  });
});

describe('accruals (AUDIT 4.2)', () => {
  const Y = 2024;
  const type = async (w: World, o: Record<string, unknown>) => (await w.hr.post('/api/v1/leave/types', typeBody({ code: 'EL', name: 'Earned', accrualMethod: 'monthly', ...o }))).json().id as string;

  it('monthly accrual stops at the cap and does not back-fill capped months', async () => {
    const w = await world();
    const el = await type(w, { annualEntitlement: 12, maxBalance: 2 });
    expect((await w.hr.post('/api/v1/leave/accruals', { leaveYear: Y, throughMonth: 4 })).statusCode).toBe(200);
    expect((await balanceOf(w.emp, 'EL', Y)).balance).toBe('2.00');   // months 3 and 4 hit the cap
    await w.hr.post('/api/v1/leave/adjustments', { employeeId: w.empId, leaveTypeId: el, leaveYear: Y, days: -2, note: 'Room freed by fixture' });
    await w.hr.post('/api/v1/leave/accruals', { leaveYear: Y, throughMonth: 5 });
    expect((await balanceOf(w.emp, 'EL', Y)).balance).toBe('1.00');   // only month 5, not 3 and 4 again
  });

  it('a monthly entitlement adds up to the year exactly', async () => {
    const w = await world();
    await type(w, { annualEntitlement: 20 });
    await w.hr.post('/api/v1/leave/accruals', { leaveYear: Y, throughMonth: 12 });
    expect((await balanceOf(w.emp, 'EL', Y)).balance).toBe('20.00');
  });

  it('re-running accruals credits nothing new and reports it as already credited', async () => {
    const w = await world();
    await type(w, { annualEntitlement: 12 });
    await w.hr.post('/api/v1/leave/accruals', { leaveYear: Y, throughMonth: 3 });
    const again = (await w.hr.post('/api/v1/leave/accruals', { leaveYear: Y, throughMonth: 3 })).json();
    expect(again.credited).toBe(0);
    expect(again.alreadyCredited).toBeGreaterThan(0);
    expect((await balanceOf(w.emp, 'EL', Y)).balance).toBe('3.00');
  });

  it('an annual credit is prorated for a known exit date in the year', async () => {
    const w = await world();
    await w.hr.post('/api/v1/leave/types', typeBody({ code: 'AL', name: 'Annual', annualEntitlement: 12 }));
    await ownerQuery(`UPDATE employees SET exit_date='${Y}-06-15', status='on_notice' WHERE id=$1`, [w.empId]);
    await w.hr.post('/api/v1/leave/accruals', { leaveYear: Y });
    expect((await balanceOf(w.emp, 'AL', Y)).balance).toBe('6.00');   // January to June
  });
});

describe('leave and comp-off (AUDIT 4.2)', () => {
  it('leave managers cannot change their own balance', async () => {
    const w = await world();
    const cl = (await w.hr.post('/api/v1/leave/types', typeBody({ code: 'CL', name: 'Casual' }))).json().id;
    const r = await w.hr.post('/api/v1/leave/adjustments', { employeeId: w.T.users.hr!.employeeId, leaveTypeId: cl, leaveYear: 2024, days: 5, note: 'Self-credit attempt' });
    expect(r.statusCode).toBe(403);
    expect((await w.hr.post('/api/v1/leave/adjustments', { employeeId: w.empId, leaveTypeId: cl, leaveYear: 2024, days: 5, note: 'For someone else' })).statusCode).toBe(201);
  });

  it('a cancelled comp-off credit does not count as leave used', async () => {
    const w = await world();
    const co = (await w.hr.post('/api/v1/leave/types', typeBody({ code: 'COFF', name: 'Comp off', accrualMethod: 'none' }))).json().id;
    await ownerQuery(`INSERT INTO leave_ledger (tenant_id, employee_id, leave_type_id, leave_year, entry_type, days, reference) VALUES ($1,$2,$3,2024,'adjustment',1,'overtime:x:credit'),($1,$2,$3,2024,'reversal',-1,'overtime:x:reverse')`,
      [w.T.id, w.empId, co]);
    const b = await balanceOf(w.emp, 'COFF', 2024);
    expect(Number(b.balance)).toBe(0);
    expect(Number(b.used)).toBe(0);
  });

  it('a cancelled leave request still nets out of used', async () => {
    const w = await world();
    const cl = (await w.hr.post('/api/v1/leave/types', typeBody({ code: 'CL', name: 'Casual' }))).json().id;
    await ownerQuery(`INSERT INTO leave_ledger (tenant_id, employee_id, leave_type_id, leave_year, entry_type, days, reference) VALUES ($1,$2,$3,2024,'consumption',-2,'c1'),($1,$2,$3,2024,'reversal',2,'c1r'),($1,$2,$3,2024,'consumption',-1,'c2')`,
      [w.T.id, w.empId, cl]);
    expect(Number((await balanceOf(w.emp, 'CL', 2024)).used)).toBe(1);
  });
});
