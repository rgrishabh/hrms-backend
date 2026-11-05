import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { problem, makeApp, createTenant, Client, ownerQuery, type TenantFixture, flags } from './helpers.js';
import { lossOfPay } from '../src/modules/payroll/service.js';
import type { Db } from '../src/db/tx.js';

let app: FastifyInstance;
let T: TenantFixture;
let hr: Client;
let emp: Client;
let mgr: Client;
let other: Client;
let empId: string;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** The first working day (not a Sunday) at or before `n` days back (negative = ahead). */
const workday = (n: number) => {
  let d = shift(today, -n);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() === 0) d = shift(d, -1);
  return d;
};
const [D1, D2, D3, D4] = [workday(1), workday(3), workday(5), workday(-7)];

const request = (c: Client, b: Record<string, unknown>) =>
  c.post('/api/v1/field-duty/requests', { purpose: 'field_sampling', place: 'Chakan MIDC — STP outlet', reason: 'Composite sampling for the monthly work order', ...b });
const approve = async (c: Client, entityId: string) => {
  const item = (await c.get('/api/v1/approvals/inbox')).json().items.find((x: { entity_id: string }) => x.entity_id === entityId);
  expect(item, 'visible to approver').toBeTruthy();
  const r = await c.post(`/api/v1/approvals/${item.id}/act`, { action: 'approve' });
  expect(r.statusCode, r.body).toBe(200);
  return item;
};
const status = async (id: string) => (await emp.get(`/api/v1/field-duty/requests/${id}`)).json().status;
const day = async (date: string) =>
  (
    await ownerQuery<{ status: string; duty_fraction: string }>(`SELECT status, duty_fraction::text FROM attendance_daily WHERE tenant_id=$1 AND employee_id=$2 AND work_date=$3`, [
      T.id,
      empId,
      date,
    ])
  )[0];
const set = (key: string, value: unknown) => hr.put(`/api/v1/tenant/settings/${key}`, { value });

beforeAll(async () => {
  app = await makeApp({ ...flags('default,field_duty') });
  T = await createTenant();
  empId = T.users.employee!.employeeId!;
  hr = await Client.login(app, T.host, T.users.hr!.email);
  emp = await Client.login(app, T.host, T.users.employee!.email);
  mgr = await Client.login(app, T.host, T.users.manager!.email);
  other = await Client.login(app, T.host, T.users.other!.email);
});
afterAll(async () => {
  await app.close();
});

describe('field duty', () => {
  it('checks the dates: order, halves, the window, the length', async () => {
    expect((await request(emp, { startDate: D1, endDate: D2 })).statusCode).toBe(400); // end before start
    expect((await request(emp, { startDate: D2, endDate: D1, dayPart: 'first_half' })).statusCode).toBe(400); // half over several days
    expect(problem(await request(emp, { startDate: workday(12), endDate: workday(12) })).detail).toMatch(/7 days back/);
    expect(problem(await request(emp, { startDate: shift(today, 100), endDate: shift(today, 100) })).detail).toMatch(/90 days ahead/);
    expect(problem(await request(emp, { startDate: shift(today, 1), endDate: shift(today, 40) })).detail).toMatch(/at most 31 days/);
  });

  it('the manager approves; nobody approves their own; approved days are paid on-duty days without punches', async () => {
    const r = await request(emp, { startDate: D1, endDate: D1, clientName: 'Kiran Auto Components', reference: 'WO-1182' });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id;
    expect((await emp.get('/api/v1/approvals/inbox')).json().items.some((x: { entity_id: string }) => x.entity_id === id)).toBe(false);
    expect((await other.get(`/api/v1/field-duty/requests/${id}`)).statusCode).toBe(404);
    expect((await other.get('/api/v1/field-duty/requests?scope=all')).statusCode).toBe(403);
    expect((await mgr.get('/api/v1/field-duty/requests?scope=team')).json().items.map((x: { id: string }) => x.id)).toContain(id);
    const step = await approve(mgr, id);
    expect(step.summary).toMatch(/field sampling at Chakan MIDC — STP outlet/);
    expect(await status(id)).toBe('approved');
    expect(await day(D1)).toMatchObject({ status: 'on_duty', duty_fraction: '1.00' });
    expect((await hr.get(`/api/v1/field-duty/requests?scope=all&on=${D1}`)).json().items.map((x: { id: string }) => x.id)).toEqual([id]);
  });

  it('refuses overlaps with other field duty and leave; opposite halves fit together', async () => {
    expect(problem(await request(emp, { startDate: D1, endDate: D1, dayPart: 'second_half' })).detail).toMatch(/Overlaps approved field duty/);
    expect((await request(emp, { startDate: D2, endDate: D2, dayPart: 'first_half' })).statusCode).toBe(201);
    expect((await request(emp, { startDate: D2, endDate: D2, dayPart: 'first_half' })).statusCode).toBe(409);
    expect((await request(emp, { startDate: D2, endDate: D2, dayPart: 'second_half' })).statusCode).toBe(201);
    const [t] = await ownerQuery<{ id: string }>(
      `INSERT INTO leave_types (tenant_id, code, name, paid, requires_balance, accrual_method, annual_entitlement) VALUES ($1,'LWP','Leave without pay',false,false,'none',0) RETURNING id`,
      [T.id],
    );
    await ownerQuery(
      `INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id, leave_year, start_date, end_date, end_half, days, reason, status, requested_by)
      VALUES ($1,$2,$3,$4,$5,$5,'first_half',0.5,'Bank work','approved',$6)`,
      [T.id, empId, t!.id, Number(D3.slice(0, 4)), D3, T.users.employee!.id],
    );
    expect(problem(await request(emp, { startDate: D3, endDate: D3 })).detail).toMatch(/Overlaps approved leave/);
    expect((await request(emp, { startDate: D3, endDate: D3, dayPart: 'first_half' })).statusCode).toBe(409); // the leave is the first half
    const r = await request(emp, { startDate: D3, endDate: D3, dayPart: 'second_half' });
    expect(r.statusCode, r.body).toBe(201);
    await approve(mgr, r.json().id);
    // Half a day unpaid leave + half a day on duty: the day is accounted for, and the unpaid half is loss of pay.
    expect(await day(D3)).toMatchObject({ status: 'on_duty', duty_fraction: '0.50' });
    const db = {
      query: async (sql: string, p: unknown[]) => {
        const rows = await ownerQuery(sql, p);
        return { rows, rowCount: rows.length };
      },
    } as unknown as Db;
    expect((await lossOfPay(db, T.id, empId, D3, D3)).lop).toBe(0.5);
  });

  it('an unpaid half-day of leave on a day otherwise worked is loss of pay (it used to be paid)', async () => {
    const d = workday(6) === D3 ? workday(7) : workday(6);
    const [t] = await ownerQuery<{ code: string }>(`SELECT code FROM leave_types WHERE tenant_id=$1 AND code='LWP'`, [T.id]);
    await ownerQuery(
      `INSERT INTO attendance_daily (tenant_id, employee_id, work_date, day_type, status, worked_minutes, leave_fraction, leave_type_code, calc_version) VALUES ($1,$2,$3,'working','present',300,0.5,$4,3)`,
      [T.id, empId, d, t!.code],
    );
    const db = {
      query: async (sql: string, p: unknown[]) => {
        const rows = await ownerQuery(sql, p);
        return { rows, rowCount: rows.length };
      },
    } as unknown as Db;
    expect((await lossOfPay(db, T.id, empId, d, d)).lop).toBe(0.5);
  });

  it('HR can record field duty for an employee: the manager still approves, never HR or the employee', async () => {
    const r = await request(hr, { employeeId: empId, startDate: D4, endDate: shift(D4, 1), purpose: 'site_audit', place: 'Taloja MIDC' });
    expect(r.statusCode, r.body).toBe(201);
    expect((await hr.get('/api/v1/approvals/inbox')).json().items.some((x: { entity_id: string }) => x.entity_id === r.json().id)).toBe(false);
    expect((await emp.get('/api/v1/field-duty/requests')).json().items.find((x: { id: string }) => x.id === r.json().id)).toMatchObject({ recorded_by_other: true });
    expect((await request(other, { employeeId: empId, startDate: D4, endDate: D4 })).statusCode).toBe(403);
    // The employee withdraws what HR recorded.
    expect((await emp.post(`/api/v1/field-duty/requests/${r.json().id}/withdraw`)).statusCode).toBe(200);
    expect(await status(r.json().id)).toBe('cancelled');
  });

  it('with HR approval on, HR approves after the manager', async () => {
    expect((await set('field_duty.hr_approval', true)).statusCode).toBe(200);
    const r = await request(emp, { startDate: D4, endDate: D4, purpose: 'client_visit', place: 'Vashi' });
    await approve(mgr, r.json().id);
    expect(await status(r.json().id)).toBe('pending');
    await approve(hr, r.json().id);
    expect(await status(r.json().id)).toBe('approved');
    expect(await day(D4)).toBeUndefined(); // not yet begun: calculated when the day closes
    expect((await set('field_duty.hr_approval', false)).statusCode).toBe(200);
    // Not begun: the employee may cancel, and cannot report on it yet.
    expect((await emp.post(`/api/v1/field-duty/requests/${r.json().id}/report`, { outcome: 'completed' })).statusCode).toBe(409);
    expect((await emp.post(`/api/v1/field-duty/requests/${r.json().id}/cancel`, { reason: 'Client postponed' })).statusCode).toBe(200);
  });

  it('after the duty: the employee reports on it; only HR cancels it, and attendance follows', async () => {
    const id = (await emp.get(`/api/v1/field-duty/requests?on=${D1}`)).json().items[0].id;
    expect((await emp.post(`/api/v1/field-duty/requests/${id}/report`, { outcome: 'partly_completed' })).statusCode).toBe(400); // say what was not done
    expect((await emp.post(`/api/v1/field-duty/requests/${id}/report`, { outcome: 'partly_completed', note: 'Outlet 2 dry; resample next week' })).statusCode).toBe(200);
    expect((await emp.get(`/api/v1/field-duty/requests/${id}`)).json()).toMatchObject({ outcome: 'partly_completed', outcome_note: 'Outlet 2 dry; resample next week' });
    expect(problem(await emp.post(`/api/v1/field-duty/requests/${id}/cancel`, { reason: 'test' })).detail).toMatch(/only by HR/);
    expect((await hr.post(`/api/v1/field-duty/requests/${id}/cancel`, { reason: 'Recorded against the wrong person' })).statusCode).toBe(200);
    expect(await day(D1)).toMatchObject({ status: 'absent', duty_fraction: '0.00' });
  });

  it('locked payroll periods cannot gain or lose field duty', async () => {
    const d = workday(2);
    await ownerQuery(`INSERT INTO attendance_period_locks (tenant_id, period_start, period_end, locked_by) VALUES ($1,$2,$2,$3)`, [T.id, d, T.users.hr!.id]);
    expect(problem(await request(emp, { startDate: d, endDate: d })).detail).toMatch(/locked for payroll/);
  });
});
