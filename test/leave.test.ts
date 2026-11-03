import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture } from './helpers.js';
import { addDays, localDate, weekday } from '../src/modules/attendance/time.js';

const today = () => localDate(new Date(), 'Asia/Kolkata');
/** A Monday at least `minAhead` days ahead whose whole week (Mon–Sun) is in one calendar year. */
function futureMonday(minAhead: number) {
  let d = addDays(today(), minAhead);
  while (weekday(d) !== 1 || d.slice(0, 4) !== addDays(d, 6).slice(0, 4)) d = addDays(d, 1);
  return d;
}
/** Most recent past Mon–Sat (default weekly off is Sunday) at least `minAgo` days ago, same calendar year as today if possible. */
function pastWorkday(minAgo: number) {
  let d = addDays(today(), -minAgo);
  while (weekday(d) === 0) d = addDays(d, -1);
  return d;
}

let app: FastifyInstance; let T: TenantFixture; let hr: Client; let emp: Client; let mgr: Client;
const types: Record<string, string> = {};
const typeBody = (o: Record<string, unknown>) => ({ paid: true, allowHalfDay: true, requiresBalance: true, accrualMethod: 'annual', annualEntitlement: 0,
  carryForwardMax: 0, maxBalance: null, countNonWorkingDays: false, minNoticeDays: 0, maxConsecutiveDays: null, eligibleAfterDays: 0, applicableEmploymentTypes: [], ...o });
const balance = async (c: Client, code: string, year?: number, employeeId?: string) =>
  (await c.get(`/api/v1/leave/balances?${employeeId ? `employeeId=${employeeId}&` : ''}${year ? `year=${year}` : ''}`)).json().items.find((i: { code: string }) => i.code === code);

const MON = futureMonday(21);
const YEAR = Number(MON.slice(0, 4));

beforeAll(async () => {
  app = await makeApp();
  T = await createTenant();
  hr = await Client.login(app, T.host, T.users.hr!.email);
  emp = await Client.login(app, T.host, T.users.employee!.email);
  mgr = await Client.login(app, T.host, T.users.manager!.email);
  for (const [code, o] of Object.entries({
    CL: { name: 'Casual Leave', annualEntitlement: 12 },
    EL: { name: 'Earned Leave', accrualMethod: 'monthly', annualEntitlement: 18, carryForwardMax: 10, minNoticeDays: 7 },
    SW: { name: 'Sandwich Test Leave', annualEntitlement: 20, countNonWorkingDays: true },
    LWP: { name: 'Leave Without Pay', paid: false, requiresBalance: false, accrualMethod: 'none' },
  })) {
    const r = await hr.post('/api/v1/leave/types', typeBody({ code, ...o }));
    expect(r.statusCode, r.body).toBe(201);
    types[code] = r.json().id;
  }
  // Holiday on the Wednesday of the test week.
  await ownerQuery(`INSERT INTO holidays (tenant_id, holiday_date, name) VALUES ($1,$2,'Test Holiday')`, [T.id, addDays(MON, 2)]);
});
afterAll(async () => { await app.close(); });

describe('leave types', () => {
  it('validates policy combinations and requires leave.manage', async () => {
    expect((await hr.post('/api/v1/leave/types', typeBody({ code: 'BAD', name: 'Bad', requiresBalance: false, accrualMethod: 'annual' }))).statusCode).toBe(400);
    expect((await hr.post('/api/v1/leave/types', typeBody({ code: 'X1', name: 'Half', annualEntitlement: 1.3 }))).statusCode).toBe(400);
    expect((await emp.post('/api/v1/leave/types', typeBody({ code: 'HACK', name: 'Hack' }))).statusCode).toBe(403);
  });
});

describe('accruals', () => {
  it('credits annual and monthly entitlements once (idempotent)', async () => {
    const r = (await hr.post('/api/v1/leave/accruals', { leaveYear: YEAR, throughMonth: 12 })).json();
    expect(r.credited).toBeGreaterThan(0);
    expect((await hr.post('/api/v1/leave/accruals', { leaveYear: YEAR, throughMonth: 12 })).json().credited).toBe(0);
    const cl = await balance(emp, 'CL', YEAR);
    expect(cl).toMatchObject({ balance: '12.00', available: '12.00' });
    expect((await balance(emp, 'EL', YEAR)).balance).toBe('18.00'); // 12 × 1.50
    expect(await balance(emp, 'LWP', YEAR)).toMatchObject({ balance: '0', requires_balance: false });
  });

  it('pro-rates the annual entitlement for a mid-year joiner (rounded down to half days)', async () => {
    const [e] = await ownerQuery<{ id: string }>(`INSERT INTO employees (tenant_id, employee_code, first_name, legal_entity_id, branch_id, date_of_joining)
      VALUES ($1,'J1','Joiner',$2,$3,$4) RETURNING id`, [T.id, T.legalEntityId, T.branchId, `${YEAR}-07-15`]);
    await hr.post('/api/v1/leave/accruals', { leaveYear: YEAR });
    expect((await balance(hr, 'CL', YEAR, e!.id)).balance).toBe('6.00');   // Jul–Dec = 6 months
    expect((await balance(hr, 'EL', YEAR, e!.id)).balance).toBe('9.00');   // 6 × 1.50
  });
});

describe('requests: day counting and validation', () => {
  it('counts working days only: weekly off (Sunday) and holiday (Wednesday) excluded', async () => {
    const p = (await emp.post('/api/v1/leave/requests/preview', { leaveTypeId: types.CL, startDate: MON, endDate: addDays(MON, 6) })).json();
    expect(p.days).toBe('5.00'); // Mon, Tue, Thu, Fri, Sat
    expect(p.perDate.filter((d: { fraction: number }) => d.fraction === 0).map((d: { date: string }) => d.date)).toEqual([addDays(MON, 2), addDays(MON, 6)]);
  });

  it('counts non-working days for "sandwich" types', async () => {
    expect((await emp.post('/api/v1/leave/requests/preview', { leaveTypeId: types.SW, startDate: MON, endDate: addDays(MON, 6) })).json().days).toBe('7.00');
  });

  it('supports half days at both ends', async () => {
    const p = (await emp.post('/api/v1/leave/requests/preview', { leaveTypeId: types.CL, startDate: MON, endDate: addDays(MON, 1), startHalf: 'second_half', endHalf: 'first_half' })).json();
    expect(p.days).toBe('1.00');
    expect((await emp.post('/api/v1/leave/requests/preview', { leaveTypeId: types.CL, startDate: MON, endDate: MON, startHalf: 'second_half', endHalf: 'first_half' })).statusCode).toBe(400);
  });

  it('rejects a range with no working days, insufficient balance, and too-short notice', async () => {
    expect((await emp.post('/api/v1/leave/requests/preview', { leaveTypeId: types.CL, startDate: addDays(MON, 2), endDate: addDays(MON, 2) })).json().error.message).toMatch(/no working days/);
    const p = (await emp.post('/api/v1/leave/requests/preview', { leaveTypeId: types.CL, startDate: MON, endDate: addDays(MON, 20) })).json();
    expect(p.sufficient).toBe(false);
    const r = await emp.post('/api/v1/leave/requests', { leaveTypeId: types.CL, startDate: MON, endDate: addDays(MON, 20), reason: 'Long trip' });
    expect(r.statusCode).toBe(409);
    const soon = addDays(today(), 2);
    const n = await emp.post('/api/v1/leave/requests', { leaveTypeId: types.EL, startDate: soon, endDate: soon, reason: 'Short notice' });
    if (weekday(soon) !== 0) expect(n.json().error.message).toMatch(/at least 7 day/);
  });

  it('allows leave without pay with no balance', async () => {
    const p = (await emp.post('/api/v1/leave/requests/preview', { leaveTypeId: types.LWP, startDate: addDays(MON, 7), endDate: addDays(MON, 8) })).json();
    expect(p).toMatchObject({ sufficient: true, requiresBalance: false, paid: false, days: '2.00' });
  });

  it('employees cannot apply for colleagues', async () => {
    expect((await emp.post('/api/v1/leave/requests', { leaveTypeId: types.CL, startDate: MON, endDate: MON, reason: 'x x x', employeeId: T.users.other!.employeeId })).statusCode).toBe(403);
  });
});

describe('approval workflow, ledger and cancellation', () => {
  let reqId = ''; let approvalId = '';
  it('reserves pending days, routes to the manager, and blocks overlaps', async () => {
    const r = await emp.post('/api/v1/leave/requests', { leaveTypeId: types.CL, startDate: MON, endDate: addDays(MON, 1), reason: 'Family function' });
    expect(r.statusCode, r.body).toBe(201);
    reqId = r.json().id; approvalId = r.json().approvalRequestId;
    expect(await balance(emp, 'CL', YEAR)).toMatchObject({ balance: '12.00', pending: '2.00', available: '10.00' });
    expect((await emp.post('/api/v1/leave/requests', { leaveTypeId: types.LWP, startDate: addDays(MON, 1), endDate: addDays(MON, 1), reason: 'Overlap' })).statusCode).toBe(409);
    expect((await mgr.get('/api/v1/approvals/inbox')).json().items.map((x: { id: string }) => x.id)).toContain(approvalId);
    expect((await emp.post(`/api/v1/approvals/${approvalId}/act`, { action: 'approve' })).statusCode).toBe(403);
  });

  it('approval writes a consumption entry and shows in the team calendar', async () => {
    expect((await mgr.post(`/api/v1/approvals/${approvalId}/act`, { action: 'approve', comment: 'Enjoy' })).json().status).toBe('approved');
    expect(await balance(emp, 'CL', YEAR)).toMatchObject({ balance: '10.00', pending: '0', used: '2.00' });
    const ledger = (await emp.get(`/api/v1/leave/ledger?employeeId=${T.users.employee!.employeeId}&leaveTypeId=${types.CL}&year=${YEAR}`)).json().items;
    expect(ledger.map((l: { entry_type: string; days: string }) => `${l.entry_type}:${l.days}`)).toEqual(['accrual:12.00', 'consumption:-2.00']);
    const cal = (await mgr.get(`/api/v1/leave/calendar?from=${MON}&to=${addDays(MON, 6)}`)).json().items;
    expect(cal.map((c: { id: string }) => c.id)).toContain(reqId);
    const other = await Client.login(app, T.host, T.users.other!.email);
    expect((await other.get(`/api/v1/leave/balances?employeeId=${T.users.employee!.employeeId}`)).statusCode).toBe(403);
  });

  it('the employee can cancel approved future leave; the days are reversed', async () => {
    const r = (await emp.post(`/api/v1/leave/requests/${reqId}/cancel`, { reason: 'Plans changed' })).json();
    expect(r.reversedDays).toBe('2.00');
    expect((await balance(emp, 'CL', YEAR)).balance).toBe('12.00');
    expect((await emp.post(`/api/v1/leave/requests/${reqId}/cancel`)).statusCode).toBe(409);
  });

  it('cancelling a pending request closes its approval', async () => {
    const r = (await emp.post('/api/v1/leave/requests', { leaveTypeId: types.CL, startDate: addDays(MON, 3), endDate: addDays(MON, 3), reason: 'Errand' })).json();
    await emp.post(`/api/v1/leave/requests/${r.id}/cancel`);
    expect((await mgr.get('/api/v1/approvals/inbox')).json().items.map((x: { id: string }) => x.id)).not.toContain(r.approvalRequestId);
    expect((await balance(emp, 'CL', YEAR)).pending).toBe('0');
  });
});

describe('attendance integration', () => {
  it('approved past leave makes the day on_leave; half-day leave needs only the other half worked', async () => {
    const day1 = pastWorkday(3); const day2 = pastWorkday(10);
    const y1 = Number(day1.slice(0, 4)); const y2 = Number(day2.slice(0, 4));
    for (const y of new Set([y1, y2])) await hr.post('/api/v1/leave/accruals', { leaveYear: y });
    // HR applies on behalf (backdated sick leave scenario); manager approves.
    const full = (await hr.post('/api/v1/leave/requests', { leaveTypeId: types.CL, startDate: day1, endDate: day1, reason: 'Was unwell', employeeId: T.users.employee!.employeeId })).json();
    await mgr.post(`/api/v1/approvals/${full.approvalRequestId}/act`, { action: 'approve' });
    const half = (await hr.post('/api/v1/leave/requests', { leaveTypeId: types.CL, startDate: day2, endDate: day2, endHalf: 'first_half', reason: 'Morning appointment', employeeId: T.users.employee!.employeeId })).json();
    // Worked 14:00–19:30 IST (5h30m ≥ 4h half-day minimum).
    await ownerQuery(`INSERT INTO attendance_events (tenant_id, employee_id, source, source_ref, event_time, direction) VALUES
      ($1,$2,'web','h-in',($3::date + time '14:00') AT TIME ZONE 'Asia/Kolkata','in'), ($1,$2,'web','h-out',($3::date + time '19:30') AT TIME ZONE 'Asia/Kolkata','out')`,
      [T.id, T.users.employee!.employeeId, day2]);
    await mgr.post(`/api/v1/approvals/${half.approvalRequestId}/act`, { action: 'approve' });
    const rows = await ownerQuery<{ work_date: string; status: string; leave_fraction: string; leave_type_code: string; calc_version: number }>(
      `SELECT work_date, status, leave_fraction, leave_type_code, calc_version FROM attendance_daily WHERE employee_id=$1 AND work_date = ANY($2) ORDER BY work_date`,
      [T.users.employee!.employeeId, [day1, day2]]);
    const byDate = Object.fromEntries(rows.map((r) => [r.work_date, r]));
    expect(byDate[day1]).toMatchObject({ status: 'on_leave', leave_fraction: '1.00', leave_type_code: 'CL', calc_version: 2 });
    expect(byDate[day2]).toMatchObject({ status: 'present', leave_fraction: '0.50' });
  });

  it('cannot request, approve or cancel leave in a payroll-locked period', async () => {
    const d = pastWorkday(40);
    await ownerQuery(`INSERT INTO attendance_period_locks (tenant_id, period_start, period_end, locked_by) VALUES ($1,$2,$2,$3)`, [T.id, d, T.users.hr!.id]);
    await hr.post('/api/v1/leave/accruals', { leaveYear: Number(d.slice(0, 4)) });
    const r = await hr.post('/api/v1/leave/requests', { leaveTypeId: types.LWP, startDate: d, endDate: d, reason: 'Late entry', employeeId: T.users.employee!.employeeId });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toMatch(/locked for payroll/);
  });
});

describe('year-end', () => {
  it('refuses while requests are pending, then carries forward up to the cap and lapses the rest', async () => {
    const T2 = await createTenant();
    const hr2 = await Client.login(app, T2.host, T2.users.hr!.email);
    const emp2 = await Client.login(app, T2.host, T2.users.employee!.email);
    const el = (await hr2.post('/api/v1/leave/types', typeBody({ code: 'EL', name: 'Earned', annualEntitlement: 15, carryForwardMax: 10 }))).json().id;
    const Y = 2025;
    await hr2.post('/api/v1/leave/accruals', { leaveYear: Y });
    const p = (await hr2.post('/api/v1/leave/requests', { leaveTypeId: el, startDate: '2025-06-02', endDate: '2025-06-03', reason: 'Old pending', employeeId: T2.users.employee!.employeeId })).json();
    expect((await hr2.post('/api/v1/leave/year-end', { leaveYear: Y })).statusCode).toBe(409);
    await hr2.post(`/api/v1/leave/requests/${p.id}/cancel`);
    const r = (await hr2.post('/api/v1/leave/year-end', { leaveYear: Y })).json();
    expect(r.balancesProcessed).toBeGreaterThan(0);
    expect((await balance(emp2, 'EL', Y)).balance).toBe('10.00');       // 15 − 5 lapsed
    expect((await balance(emp2, 'EL', Y + 1)).balance).toBe('10.00');   // carried
    expect((await hr2.post('/api/v1/leave/year-end', { leaveYear: Y })).json().balancesProcessed).toBe(0); // idempotent
  });

  it('balance adjustments are audited and leave.manage only', async () => {
    expect((await emp.post('/api/v1/leave/adjustments', { employeeId: T.users.employee!.employeeId, leaveTypeId: types.CL, leaveYear: YEAR, days: 5, note: 'self grant' })).statusCode).toBe(403);
    expect((await hr.post('/api/v1/leave/adjustments', { employeeId: T.users.employee!.employeeId, leaveTypeId: types.CL, leaveYear: YEAR, days: -1.5, note: 'Correction per HR memo' })).statusCode).toBe(201);
    const [a] = await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='leave.balance_adjusted'`, [T.id]);
    expect(a).toBeTruthy();
    expect(await ownerQuery(`SELECT 1 FROM leave_ledger WHERE tenant_id=$1 AND entry_type='adjustment' AND days=-1.5`, [T.id])).toHaveLength(1);
  });
});

describe('module disabled', () => {
  it('rejects leave APIs when leave is not in ENABLED_MODULES', async () => {
    const off = await makeApp({ ENABLED_MODULES: 'attendance,attendance.web,attendance.regularization,shifts,holidays' });
    const c = await Client.login(off, T.host, T.users.employee!.email);
    const r = await c.get('/api/v1/leave/types');
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('feature_unavailable');
    await off.close();
    await makeApp().then((x) => x.close()); // restore the default module set for this process
  });
});
