import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, flags, type TenantFixture } from './helpers.js';
import { addDays, localDate, weekday } from '../src/modules/attendance/time.js';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp({ ...flags('default,attendance.mobile,attendance.biometric,attendance.geofence') }); });
afterAll(async () => { await app.close(); });

const TZ = 'Asia/Kolkata';
const today = () => localDate(new Date(), TZ);
/** An ISO timestamp with +05:30 offset for `date` at `hh:mm` IST. */
const ist = (date: string, hhmm: string) => `${date}T${hhmm}:00+05:30`;
/** Most recent Mon–Sat date at least `minAgo` days back (default weekly off is Sunday). */
const workday = (minAgo: number) => { let x = addDays(today(), -minAgo); while (weekday(x) === 0) x = addDays(x, -1); return x; };

describe('web punches', () => {
  it('is idempotent per client key and uses server time', async () => {
    const T = await createTenant();
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    const first = await emp.post('/api/v1/attendance/punch', { channel: 'web', idempotencyKey: 'abc-12345' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ duplicate: false, direction: 'in' });
    expect(Math.abs(Date.parse(first.json().eventTime) - Date.now())).toBeLessThan(5000);
    expect((await emp.post('/api/v1/attendance/punch', { channel: 'web', idempotencyKey: 'abc-12345' })).json().duplicate).toBe(true);
    expect((await emp.post('/api/v1/attendance/punch', { channel: 'web', idempotencyKey: 'abc-67890' })).json().direction).toBe('out');
    expect((await ownerQuery(`SELECT 1 FROM attendance_events WHERE tenant_id=$1`, [T.id])).length).toBe(2);
  });

  it('does not store location when policy is off; requires it when policy says required', async () => {
    const T = await createTenant();
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    await emp.post('/api/v1/attendance/punch', { channel: 'mobile', idempotencyKey: 'loc-off-1', latitude: 19.07, longitude: 72.87 });
    const [ev] = await ownerQuery<{ latitude: string | null }>(`SELECT latitude FROM attendance_events WHERE tenant_id=$1`, [T.id]);
    expect(ev!.latitude).toBeNull();
    await admin.put('/api/v1/tenant/settings/attendance.mobile_location_mode', { value: 'required' });
    expect((await emp.post('/api/v1/attendance/punch', { channel: 'mobile', idempotencyKey: 'loc-req-1' })).statusCode).toBe(400);
    expect((await emp.post('/api/v1/attendance/punch', { channel: 'mobile', idempotencyKey: 'loc-req-2', latitude: 19.07, longitude: 72.87 })).statusCode).toBe(200);
  });
});

describe('biometric ingestion', () => {
  let T: TenantFixture; let key: string; let itc: Client;
  beforeAll(async () => {
    T = await createTenant(); // biometric is enabled in the test deployment's ENABLED_MODULES
    itc = await Client.login(app, T.host, T.users.it!.email);
    key = (await itc.post('/api/v1/attendance/devices', { branchId: T.branchId, serialNumber: 'ZK-001', name: 'Main gate', adapterKey: 'generic_push_v1' })).json().apiKey;
    await itc.put('/api/v1/attendance/device-mappings/1001', { employeeId: T.users.employee!.employeeId });
  });
  const push = (k: string, body: unknown) => app.inject({ method: 'POST', url: '/api/v1/devices/events', headers: { host: 'any.host', 'x-device-key': k }, payload: body as never });

  it('rejects bad keys', async () => {
    expect((await push('dev_x.y', { deviceTime: new Date().toISOString(), events: [] })).statusCode).toBe(401);
    expect((await push(key.replace(/.$/, 'Z'), { deviceTime: new Date().toISOString(), events: [{ eventId: '1', deviceUserId: '1', timestamp: new Date().toISOString() }] })).statusCode).toBe(401);
  });

  it('corrects clock drift, deduplicates retries, queues unmapped users and calculates the day', async () => {
    const d = workday(1);
    // Device clock runs 10 minutes fast: it reports 09:35 for a 09:25 real punch.
    const deviceNow = new Date(Date.now() + 10 * 60e3).toISOString();
    const batch = { deviceTime: deviceNow, events: [
      { eventId: 'e1', deviceUserId: '1001', timestamp: `${d}T09:35:00`, direction: 'in' },
      { eventId: 'e2', deviceUserId: '1001', timestamp: `${d}T18:15:00`, direction: 'out' },
      { eventId: 'e3', deviceUserId: '9999', timestamp: `${d}T09:40:00`, direction: 'in' },
    ] };
    const r1 = (await push(key, batch)).json();
    expect(r1).toMatchObject({ accepted: 2, duplicates: 0, unmapped: 1, rejected: 0 });
    expect(Math.abs(r1.clockDriftSeconds - 600)).toBeLessThanOrEqual(2);
    expect(r1.warning).toMatch(/Clock drift/);
    // Retry of the same batch (offline re-sync) is a no-op.
    expect((await push(key, batch)).json()).toMatchObject({ accepted: 0, duplicates: 3 });

    const hr = await Client.login(app, T.host, T.users.hr!.email);
    const att = (await hr.get(`/api/v1/attendance/employees/${T.users.employee!.employeeId}?from=${d}&to=${d}`)).json();
    expect(att.days[0].status).toBe('present');
    // 09:25 IST corrected in-time — within grace of 09:30.
    expect(new Date(att.days[0].first_in).toISOString()).toBe(new Date(ist(d, '09:25')).toISOString());
    expect(att.days[0].late_minutes).toBe(0);
    const raw = att.events[0];
    expect(new Date(raw.device_time).toISOString()).toBe(new Date(ist(d, '09:35')).toISOString());

    // Unmapped event waits in the error queue, then is reprocessed once mapped.
    expect((await itc.get('/api/v1/attendance/device-events/unmapped')).json().items).toHaveLength(1);
    expect((await itc.put('/api/v1/attendance/device-mappings/9999', { employeeId: T.users.other!.employeeId })).json().reprocessedEvents).toBe(1);
    const other = (await hr.get(`/api/v1/attendance/employees/${T.users.other!.employeeId}?from=${d}&to=${d}`)).json();
    expect(other.days[0].status).toBe('missing_punch');
  });

  it('rejects future-dated events and disabled devices', async () => {
    const future = new Date(Date.now() + 2 * 3600e3).toISOString();
    expect((await push(key, { deviceTime: new Date().toISOString(), events: [{ eventId: 'f1', deviceUserId: '1001', timestamp: future }] })).json().rejected).toBe(1);
    const dev = (await itc.get('/api/v1/attendance/devices')).json().items[0];
    await itc.patch(`/api/v1/attendance/devices/${dev.id}`, { status: 'disabled' });
    expect((await push(key, { deviceTime: new Date().toISOString(), events: [{ eventId: 'f2', deviceUserId: '1001', timestamp: new Date().toISOString() }] })).statusCode).toBe(403);
  });
});

describe('regularization approval workflow and payroll lock', () => {
  let T: TenantFixture; let emp: Client; let mgr: Client;
  const d = () => workday(2);
  beforeAll(async () => {
    T = await createTenant();
    emp = await Client.login(app, T.host, T.users.employee!.email);
    mgr = await Client.login(app, T.host, T.users.manager!.email);
  });

  it('routes to the reporting manager; requester cannot self-approve; approval creates new events and recalculates', async () => {
    const r = await emp.post('/api/v1/attendance/regularizations', { workDate: d(), requestedIn: ist(d(), '09:30'), requestedOut: ist(d(), '18:00'), reason: 'Biometric device was offline' });
    expect(r.statusCode).toBe(201);
    const reqId = r.json().approvalRequestId;
    expect((await emp.get('/api/v1/approvals/inbox')).json().items).toHaveLength(0);
    expect((await emp.post(`/api/v1/approvals/${reqId}/act`, { action: 'approve' })).statusCode).toBe(403);
    const other = await Client.login(app, T.host, T.users.other!.email);
    expect((await other.post(`/api/v1/approvals/${reqId}/act`, { action: 'approve' })).statusCode).toBe(403);
    const inbox = (await mgr.get('/api/v1/approvals/inbox')).json().items;
    expect(inbox.map((x: { id: string }) => x.id)).toContain(reqId);
    expect((await mgr.post(`/api/v1/approvals/${reqId}/act`, { action: 'reject' })).statusCode).toBe(400); // comment required
    expect((await mgr.post(`/api/v1/approvals/${reqId}/act`, { action: 'approve', comment: 'Verified with lab log' })).json().status).toBe('approved');
    expect((await mgr.post(`/api/v1/approvals/${reqId}/act`, { action: 'approve' })).statusCode).toBe(409);
    const att = (await emp.get(`/api/v1/attendance/me?from=${d()}&to=${d()}`)).json();
    expect(att.days[0].status).toBe('present');
    expect(att.events.every((e: { source: string }) => e.source === 'regularization')).toBe(true);
  });

  it('routes to HR (permission step) when the employee has no manager login', async () => {
    const other = await Client.login(app, T.host, T.users.other!.email);
    const r = await other.post('/api/v1/attendance/regularizations', { workDate: d(), requestedIn: ist(d(), '09:30'), reason: 'Forgot to punch in' });
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    expect((await hr.get('/api/v1/approvals/inbox')).json().items.map((x: { id: string }) => x.id)).toContain(r.json().approvalRequestId);
    expect((await mgr.get('/api/v1/approvals/inbox')).json().items.map((x: { id: string }) => x.id)).not.toContain(r.json().approvalRequestId);
    expect((await hr.post(`/api/v1/approvals/${r.json().approvalRequestId}/act`, { action: 'return', comment: 'Please add out time too' })).json().status).toBe('returned');
  });

  it('enforces the regularization window', async () => {
    const old = addDays(today(), -30);
    const r = await emp.post('/api/v1/attendance/regularizations', { workDate: old, requestedIn: ist(old, '09:30'), reason: 'Too old request' });
    expect(r.statusCode).toBe(400);
  });

  it('managers see their team, not others; employees cannot see colleagues', async () => {
    expect((await mgr.get(`/api/v1/attendance/employees/${T.users.employee!.employeeId}?from=${d()}&to=${d()}`)).statusCode).toBe(200);
    expect((await mgr.get(`/api/v1/attendance/employees/${T.users.other!.employeeId}?from=${d()}&to=${d()}`)).statusCode).toBe(403);
    expect((await emp.get(`/api/v1/attendance/employees/${T.users.other!.employeeId}?from=${d()}&to=${d()}`)).statusCode).toBe(403);
    const team = (await mgr.get(`/api/v1/attendance/daily?date=${d()}`)).json();
    expect(team.items.map((x: { employee_id: string }) => x.employee_id)).toEqual([T.users.employee!.employeeId]);
  });

  it('locks a period: blocks new regularizations and recalculation changes; refuses lock with pending requests', async () => {
    const payroll = await Client.login(app, T.host, T.users.payroll!.email);
    const day = addDays(d(), -1);
    const pend = await emp.post('/api/v1/attendance/regularizations', { workDate: day, requestedIn: ist(day, '09:30'), requestedOut: ist(day, '18:00'), reason: 'Pending one' });
    expect((await payroll.post('/api/v1/attendance/locks', { periodStart: day, periodEnd: d() })).statusCode).toBe(409);
    await emp.post(`/api/v1/approvals/${pend.json().approvalRequestId}/cancel`);
    const lock = await payroll.post('/api/v1/attendance/locks', { periodStart: day, periodEnd: d() });
    expect(lock.statusCode).toBe(201);
    expect((await emp.post('/api/v1/attendance/regularizations', { workDate: d(), requestedIn: ist(d(), '10:00'), reason: 'After lock' })).statusCode).toBe(409);
    const before = await ownerQuery<{ status: string; calculated_at: Date }>(`SELECT status, calculated_at FROM attendance_daily WHERE tenant_id=$1 AND employee_id=$2 AND work_date=$3`, [T.id, T.users.employee!.employeeId, d()]);
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    const re = (await hr.post('/api/v1/attendance/recalculate', { from: day, to: d() })).json();
    expect(re.lockedDaysSkipped).toBeGreaterThan(0);
    const after = await ownerQuery<{ status: string; calculated_at: Date }>(`SELECT status, calculated_at FROM attendance_daily WHERE tenant_id=$1 AND employee_id=$2 AND work_date=$3`, [T.id, T.users.employee!.employeeId, d()]);
    expect(after[0]).toEqual(before[0]);
    expect((await payroll.post('/api/v1/attendance/locks', { periodStart: day, periodEnd: day })).statusCode).toBe(409);
  });

  it('only payroll (attendance.lock) can lock periods', async () => {
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    expect((await hr.post('/api/v1/attendance/locks', { periodStart: '2025-01-01', periodEnd: '2025-01-31' })).statusCode).toBe(403);
  });
});

describe('shift assignment', () => {
  it('closes the previous open assignment and applies the night shift from the effective date', async () => {
    const T = await createTenant();
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    const from = addDays(today(), -5);
    expect((await hr.post('/api/v1/attendance/shift-assignments', { employeeIds: [T.users.employee!.employeeId], shiftId: T.nightShiftId, effectiveFrom: from })).statusCode).toBe(200);
    const rows = await ownerQuery<{ effective_from: string; effective_to: string | null }>(`SELECT effective_from, effective_to FROM shift_assignments WHERE employee_id=$1 ORDER BY effective_from`, [T.users.employee!.employeeId]);
    expect(rows).toEqual([{ effective_from: '2024-01-01', effective_to: addDays(from, -1) }, { effective_from: from, effective_to: null }]);
    const r = (await hr.post('/api/v1/attendance/recalculate', { from, to: from, employeeId: T.users.employee!.employeeId })).json();
    expect(r.daysCalculated).toBe(1);
    const [day] = await ownerQuery<{ shift: string }>(`SELECT s.code AS shift FROM attendance_daily d JOIN shifts s ON s.id=d.shift_id WHERE d.employee_id=$1 AND d.work_date=$2`, [T.users.employee!.employeeId, from]);
    expect(day!.shift).toBe('NIGHT');
  });
});
