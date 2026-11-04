import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture } from './helpers.js';
import { periodParams, nextRun } from '../src/modules/reports/service.js';
import { REPORT_MAP } from '../src/modules/reports/registry.js';

let app: FastifyInstance; let T: TenantFixture;
let admin: Client; let hr: Client; let emp: Client; let pay: Client; let mgr: Client;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

beforeAll(async () => {
  app = await makeApp({ ENABLED_MODULES: 'default,reports.advanced' });
  T = await createTenant();
  admin = await Client.login(app, T.host, T.users.admin!.email);
  hr = await Client.login(app, T.host, T.users.hr!.email);
  emp = await Client.login(app, T.host, T.users.employee!.email);
  pay = await Client.login(app, T.host, T.users.payroll!.email);
  mgr = await Client.login(app, T.host, T.users.manager!.email);
});
afterAll(async () => { await app.close(); });

describe('advanced reporting', () => {
  it('relative periods and next runs', () => {
    const def = REPORT_MAP.get('department_overview')!;
    expect(periodParams(def, 'last_month', '2026-03-15')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodParams(def, 'last_7_days', '2026-03-15')).toEqual({ from: '2026-03-08', to: '2026-03-14' });
    expect(periodParams(def, 'as_saved', '2026-03-15')).toEqual({});
    expect(nextRun({ frequency: 'weekly', weekday: 1, day_of_month: null }, '2026-03-15')).toBe('2026-03-16');   // a Monday
    expect(nextRun({ frequency: 'monthly', weekday: null, day_of_month: 1 }, '2026-03-15')).toBe('2026-04-01');
    expect(nextRun({ frequency: 'daily', weekday: null, day_of_month: null }, '2026-03-31')).toBe('2026-04-01');
  });

  it('the department overview shows only what the viewer may see and modules in use', async () => {
    expect((await emp.get('/api/v1/reports/department_overview')).statusCode).toBe(403);
    const r = (await hr.get('/api/v1/reports/department_overview')).json();
    const keys = r.columns.map((c: { key: string }) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['department', 'headcount', 'attendance_pct', 'leave_days']));
    expect(keys).not.toContain('payroll_gross');                       // payroll is not in use here
    expect(r.notes.join(' ')).toMatch(/Not shown .*Overtime approved \(h\).*Payroll gross/);
    expect(r.rows.find((x: { department: string }) => x.department === 'Lab')).toMatchObject({ headcount: 4 });
  });

  it('saved reports are personal; a schedule goes only to people who may see the report organization-wide', async () => {
    const s = await hr.post('/api/v1/reports/saved', { reportKey: 'headcount', name: 'Headcount by department', params: { groupBy: 'department', nope: 'x' } });
    expect(s.statusCode, s.body).toBe(201);
    const id = s.json().id;
    expect((await hr.post('/api/v1/reports/saved', { reportKey: 'headcount', name: 'Headcount by department' })).statusCode).toBe(409);
    expect((await emp.post('/api/v1/reports/saved', { reportKey: 'headcount', name: 'Mine' })).statusCode).toBe(404);
    const list = (await hr.get('/api/v1/reports/saved')).json().items;
    expect(list).toEqual([expect.objectContaining({ id, reportName: 'Headcount', params: { groupBy: 'department' }, schedule: null })]);
    expect((await pay.get('/api/v1/reports/saved')).json().items).toEqual([]);
    expect((await pay.del(`/api/v1/reports/saved/${id}`)).statusCode).toBe(404);

    expect((await hr.put(`/api/v1/reports/saved/${id}/schedule`, { frequency: 'weekly' })).json().error.message).toMatch(/day of the week/);
    expect((await hr.put(`/api/v1/reports/saved/${id}/schedule`, { frequency: 'daily', recipientIds: [T.users.employee!.id] })).json().error.message).toMatch(/1 recipient\(s\) cannot see/);
    const sc = await hr.put(`/api/v1/reports/saved/${id}/schedule`, { frequency: 'daily', recipientIds: [T.users.payroll!.id] });
    expect(sc.json()).toMatchObject({ ok: true });

    // Due today: the job runs it as its owner and the recipients find it in HRMS.
    await ownerQuery(`UPDATE report_schedules SET next_run_on=$2 WHERE tenant_id=$1`, [T.id, today]);
    const run = await admin.post('/api/v1/tenant/jobs/reports.scheduled/run');
    expect(run.statusCode, run.body).toBeLessThan(300);
    const mine = (await pay.get('/api/v1/reports/snapshots')).json().items;
    expect(mine).toEqual([expect.objectContaining({ name: 'Headcount by department', scope: 'all', owner: 'hr' })]);
    const snap = (await pay.get(`/api/v1/reports/snapshots/${mine[0].id}`)).json();
    expect(snap.columns.length).toBeGreaterThan(1);
    expect((await pay.get(`/api/v1/reports/snapshots/${mine[0].id}/export.csv`)).headers['content-type']).toMatch(/text\/csv/);
    expect((await emp.get(`/api/v1/reports/snapshots/${mine[0].id}`)).statusCode).toBe(404);   // not a recipient
    expect((await ownerQuery(`SELECT title FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND kind='reports.ready'`, [T.id, T.users.payroll!.id]))).toHaveLength(1);
    const [sched] = await ownerQuery<{ next_run_on: string; last_result: string }>(`SELECT next_run_on::text, last_result FROM report_schedules WHERE tenant_id=$1`, [T.id]);
    expect(sched!.next_run_on > today).toBe(true);
    expect(sched!.last_result).toMatch(/Sent to 2 person/);

    // A recipient who loses access no longer gets it, nor can open earlier copies.
    await ownerQuery(`DELETE FROM user_roles WHERE tenant_id=$1 AND user_id=$2 AND role_key='payroll_manager'`, [T.id, T.users.payroll!.id]);
    const pay2 = await Client.login(app, T.host, T.users.payroll!.email);
    expect((await pay2.get(`/api/v1/reports/snapshots/${mine[0].id}`)).statusCode).toBe(404);
    await ownerQuery(`UPDATE report_schedules SET next_run_on=$2 WHERE tenant_id=$1`, [T.id, today]);
    await admin.post('/api/v1/tenant/jobs/reports.scheduled/run');
    expect((await pay2.get('/api/v1/reports/snapshots')).json().items).toHaveLength(1);           // the new copy was not sent to them
  });

  it('a manager\'s team report can be scheduled only for themselves', async () => {
    const def = REPORT_MAP.get('attendance_summary')!;
    expect(def.access.team).toBeTruthy();
    const s = (await mgr.post('/api/v1/reports/saved', { reportKey: 'attendance_summary', name: 'My team attendance' })).json().id;
    expect((await mgr.put(`/api/v1/reports/saved/${s}/schedule`, { frequency: 'monthly', dayOfMonth: 1, period: 'last_month', recipientIds: [T.users.hr!.id] })).json().error.message)
      .toMatch(/only be scheduled for yourself/);
    expect((await mgr.put(`/api/v1/reports/saved/${s}/schedule`, { frequency: 'monthly', dayOfMonth: 1, period: 'last_month' })).statusCode).toBe(200);
  });
});
