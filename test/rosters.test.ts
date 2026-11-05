import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { problem, makeApp, createTenant, Client, ownerQuery, type TenantFixture, flags } from './helpers.js';
import { TEST_OWNER_URL } from './env.js';
import { nonWorkingDates } from '../src/modules/leave/service.js';
import type { Db } from '../src/db/tx.js';

// Rotating rosters: pattern → staggered crews → one-day overrides; attendance and leave follow the roster's days off.
let app: FastifyInstance;
let T: TenantFixture;
let c: pg.Client;
let hr: Client;
let mgr: Client;
let emp: Client;
let today = '';
let D = '';
let pattern = '';
const day = (base: string, n: number) => {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const roster = async (cl: Client, from: string, to: string) => (await cl.get(`/api/v1/attendance/roster?from=${from}&to=${to}`)).json();
const codes = async (empKey: string, from: string, to: string) => {
  const r = await roster(hr, from, to);
  const row = r.items.find((x: { id: string }) => x.id === T.users[empKey]!.employeeId);
  return row.days.map((d: { shiftId: string | null; off: boolean }) => (d.off ? 'off' : (r.shifts.find((s: { id: string }) => s.id === d.shiftId)?.code ?? '-')));
};
const daily = async (empKey: string, date: string) =>
  (
    await ownerQuery<{ day_type: string; shift_id: string | null; policy_snapshot: Record<string, unknown> }>(
      `SELECT day_type, shift_id, policy_snapshot FROM attendance_daily WHERE tenant_id=$1 AND employee_id=$2 AND work_date=$3`,
      [T.id, T.users[empKey]!.employeeId, date],
    )
  )[0];

beforeAll(async () => {
  app = await makeApp({ ...flags('default,leave') });
  T = await createTenant();
  c = new pg.Client({ connectionString: TEST_OWNER_URL });
  await c.connect();
  hr = await Client.login(app, T.host, T.users.hr!.email);
  mgr = await Client.login(app, T.host, T.users.manager!.email);
  emp = await Client.login(app, T.host, T.users.employee!.email);
  today = (await hr.get('/api/v1/approvals/delegations')).json().today;
  D = day(today, -5);
});
afterAll(async () => {
  await c.end();
  await app.close();
});

describe('rotating rosters', () => {
  it('validates patterns', async () => {
    expect(problem(await hr.post('/api/v1/attendance/roster-patterns', { code: 'X', name: 'All off', days: [null, null] })).detail).toMatch(/at least one working day/);
    expect((await hr.post('/api/v1/attendance/roster-patterns', { code: 'X', name: 'Unknown', days: ['00000000-0000-4000-8000-000000000000'] })).statusCode).toBe(400);
    const r = await hr.post('/api/v1/attendance/roster-patterns', { code: 'lab3', name: 'Lab 2-2-2', days: [T.shiftId, T.shiftId, T.nightShiftId, T.nightShiftId, null, null] });
    expect(r.statusCode).toBe(201);
    pattern = r.json().id;
    expect((await hr.post('/api/v1/attendance/roster-patterns', { code: 'LAB3', name: 'Again', days: [T.shiftId] })).statusCode).toBe(409);
    expect((await emp.post('/api/v1/attendance/roster-patterns', { code: 'E', name: 'Mine', days: [T.shiftId] })).statusCode).toBe(403);
  });

  it('crews follow the cycle from their start day, and attendance is recalculated with the roster’s days off', async () => {
    const r = await hr.post('/api/v1/attendance/roster-assignments', { employeeIds: [T.users.employee!.employeeId], patternId: pattern, effectiveFrom: D, startDay: 0 });
    expect(r.json()).toEqual({ assigned: 1, recalculated: 1 });
    await hr.post('/api/v1/attendance/roster-assignments', { employeeIds: [T.users.other!.employeeId], patternId: pattern, effectiveFrom: D, startDay: 2 });
    expect(await codes('employee', D, day(D, 7))).toEqual(['GEN', 'GEN', 'NIGHT', 'NIGHT', 'off', 'off', 'GEN', 'GEN']);
    expect(await codes('other', D, day(D, 5))).toEqual(['NIGHT', 'NIGHT', 'off', 'off', 'GEN', 'GEN']);

    const off = await daily('employee', day(D, 4));
    expect(off).toMatchObject({ day_type: 'weekly_off', shift_id: T.nightShiftId }); // window of the last night worked
    expect(off!.policy_snapshot).toMatchObject({ schedule: 'roster', roster: 'LAB3' });
    expect((await daily('employee', day(D, 2)))!.shift_id).toBe(T.nightShiftId);

    // Leave counts the roster's days off as non-working, whatever the weekly-off setting says.
    const nw = await nonWorkingDates(c as unknown as Db, T.id, T.branchId, D, day(D, 7), T.users.employee!.employeeId);
    expect([day(D, 4), day(D, 5)].every((d) => nw.has(d))).toBe(true);
    expect([D, day(D, 1), day(D, 2), day(D, 3), day(D, 6), day(D, 7)].some((d) => nw.has(d))).toBe(false);
  });

  it('a one-day override beats the roster and can be removed', async () => {
    const date = day(D, 4);
    let r = await hr.put('/api/v1/attendance/roster-overrides', { employeeId: T.users.employee!.employeeId, date, shiftId: T.shiftId, reason: 'Covers for N2 (sick)' });
    expect(r.statusCode).toBe(200);
    const row = (await roster(hr, date, date)).items.find((x: { id: string }) => x.id === T.users.employee!.employeeId).days[0];
    expect(row).toMatchObject({ shiftId: T.shiftId, off: false, source: 'override', reason: 'Covers for N2 (sick)', pattern: 'LAB3' });
    expect((await daily('employee', date))!.day_type).toBe('working');
    r = await hr.del(`/api/v1/attendance/roster-overrides/${T.users.employee!.employeeId}/${date}`);
    expect(r.statusCode).toBe(200);
    expect((await daily('employee', date))!.day_type).toBe('weekly_off');
  });

  it("a used pattern's days are fixed; its name is not", async () => {
    expect((await hr.patch(`/api/v1/attendance/roster-patterns/${pattern}`, { days: [T.shiftId] })).statusCode).toBe(409);
    expect((await hr.patch(`/api/v1/attendance/roster-patterns/${pattern}`, { name: 'Lab rotation 2-2-2' })).statusCode).toBe(200);
    const p = (await hr.get('/api/v1/attendance/roster-patterns')).json().items.find((x: { id: string }) => x.id === pattern);
    expect(p).toMatchObject({ name: 'Lab rotation 2-2-2', employees: 2, used: true });
  });

  it('managers see their team, employees only themselves', async () => {
    const ids = (x: { items: { id: string }[] }) => x.items.map((i) => i.id).sort();
    expect(ids(await roster(emp, today, today))).toEqual([T.users.employee!.employeeId]);
    expect(ids(await roster(mgr, today, today))).toEqual([T.users.employee!.employeeId, T.users.manager!.employeeId].sort());
    expect((await roster(hr, today, today)).items.length).toBeGreaterThanOrEqual(4);
    expect((await hr.get(`/api/v1/attendance/roster?from=${today}&to=${day(today, 42)}`)).statusCode).toBe(400);
  });

  it('a fixed shift or an explicit end takes them off the roster; changes cannot reach far back', async () => {
    const tomorrow = day(today, 1);
    await hr.post('/api/v1/attendance/shift-assignments', { employeeIds: [T.users.employee!.employeeId], shiftId: T.shiftId, effectiveFrom: tomorrow });
    const r = (await roster(hr, tomorrow, day(tomorrow, 6))).items.find((x: { id: string }) => x.id === T.users.employee!.employeeId);
    expect(r.days.every((d: { source: string }) => d.source === 'assignment')).toBe(true);

    expect((await hr.post('/api/v1/attendance/roster-assignments/end', { employeeIds: [T.users.other!.employeeId], lastDay: today })).json()).toEqual({ ended: 1 });
    const o = (await roster(hr, tomorrow, tomorrow)).items.find((x: { id: string }) => x.id === T.users.other!.employeeId);
    expect(o.days[0].source).toBe('assignment');
    expect((await hr.post('/api/v1/attendance/roster-assignments/end', { employeeIds: [T.users.other!.employeeId], lastDay: today })).statusCode).toBe(409);

    const old = await hr.post('/api/v1/attendance/roster-assignments', { employeeIds: [T.users.other!.employeeId], patternId: pattern, effectiveFrom: day(today, -40) });
    expect(problem(old).detail).toMatch(/at most 31 days/);
  });
});
