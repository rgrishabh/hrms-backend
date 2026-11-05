import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { addDays, localDate } from '../src/modules/attendance/time.js';
import { writeSetting } from '../src/core/settings/service.js';
import { withTenant } from '../src/db/tx.js';
import { Client, createTenant, flags, makeApp, ownerQuery, problem, type TenantFixture } from './helpers.js';

const today = localDate(new Date(), 'Asia/Kolkata');

describe('concurrent first write of a setting', () => {
  let app: FastifyInstance; let T: TenantFixture; let admin: Client;
  beforeAll(async () => { app = await makeApp(); T = await createTenant(); admin = await Client.login(app, T.host, T.users.admin!.email); });
  afterAll(() => app.close());

  it('neither writer is told 409, and one row is left', async () => {
    const key = 'attendance.regularization_window_days';
    const w = (value: number) => ({ key, value, scope: 'tenant' as const });
    // The first writer has inserted and not committed: the second finds no row to wait on, and meets the unique index.
    let release = (): void => undefined;
    const held = new Promise<void>((r) => { release = r; });
    let inserted = (): void => undefined;
    const hasInserted = new Promise<void>((r) => { inserted = r; });
    const first = withTenant(app.deps.pool, T.id, async (db) => { await writeSetting(db, T.id, w(10), T.users.admin!.id); inserted(); await held; });
    await hasInserted;
    const second = withTenant(app.deps.pool, T.id, (db) => writeSetting(db, T.id, w(11), T.users.admin!.id));
    // Long enough for the second to reach the index; a late start would only make this pass the easy way, which the row count below still checks.
    await new Promise((r) => setTimeout(r, 100));
    release();
    await Promise.all([first, second]);
    const rows = await ownerQuery<{ version: number; setting_value: number }>(`SELECT version, setting_value FROM tenant_settings WHERE tenant_id=$1 AND setting_key=$2`, [T.id, key]);
    expect(rows).toEqual([{ version: 2, setting_value: 11 }]);
    const answers = await Promise.all([12, 13, 14].map((value) => admin.put(`/api/v1/tenant/settings/${key}`, { value, scope: 'tenant' })));
    expect(answers.map((r) => r.statusCode)).toEqual([200, 200, 200]);
  });

  it('an editor who saw an old version is still refused', async () => {
    const key = '/api/v1/tenant/settings/attendance.regularization_window_days';
    const r = await admin.put(key, { value: 14, scope: 'tenant', expectedVersion: 1 });
    expect([r.statusCode, problem(r).code]).toEqual([400, 'bad_request']);
  });
});

describe('a notification poll is not activity', () => {
  let app: FastifyInstance; let T: TenantFixture; let emp: Client;
  beforeAll(async () => { app = await makeApp(); T = await createTenant(); emp = await Client.login(app, T.host, T.users.employee!.email); });
  afterAll(() => app.close());
  const seen = async () => (await ownerQuery<{ last_seen_at: Date }>(`SELECT s.last_seen_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email=$1 AND s.revoked_at IS NULL`, [T.users.employee!.email]))[0]!.last_seen_at;
  const age = (minutes: number) => ownerQuery(`UPDATE sessions SET last_seen_at = now() - make_interval(mins => $2) FROM users u WHERE u.id=sessions.user_id AND u.email=$1`, [T.users.employee!.email, minutes]);

  it('the poll leaves the idle clock alone, and real use moves it', async () => {
    await age(5);
    const before = await seen();
    expect((await emp.get('/api/v1/notifications/unread-count')).statusCode).toBe(200);
    expect((await seen()).getTime()).toBe(before.getTime());
    expect((await emp.get('/api/v1/auth/me')).statusCode).toBe(200);
    expect((await seen()).getTime()).toBeGreaterThan(before.getTime());
  });

  it('polling cannot keep an idle session alive', async () => {
    await age(31);
    expect((await emp.get('/api/v1/notifications/unread-count')).statusCode).toBe(401);
  });
});

describe('own loan deferral', () => {
  let app: FastifyInstance; let T: TenantFixture;
  beforeAll(async () => { app = await makeApp({ ...flags('default,payroll,loans,salary_advance') }); T = await createTenant(); });
  afterAll(() => app.close());

  it('holding loans.manage does not let someone defer their own recovery', async () => {
    const pay = await Client.login(app, T.host, T.users.payroll!.email);
    const [own] = await ownerQuery<{ id: string }>(`SELECT id FROM employees WHERE tenant_id=$1 AND user_id=$2`, [T.id, T.users.payroll!.id]);
    let employeeId = own?.id;
    if (!employeeId) {
      await ownerQuery(`UPDATE employees SET user_id=$3 WHERE tenant_id=$1 AND id=$2`, [T.id, T.users.other!.employeeId, T.users.payroll!.id]).catch(() => undefined);
      employeeId = T.users.other!.employeeId;
    }
    const period = today.slice(0, 7);
    const [loan] = await ownerQuery<{ id: string }>(`INSERT INTO employee_loans (tenant_id, employee_id, kind, amount, installments, installment_amount, first_period, status, purpose, created_by)
      VALUES ($1,$2,'loan',1000,2,500,$3,'disbursed','Own loan fixture',$4) RETURNING id`, [T.id, employeeId, period, T.users.payroll!.id]);
    const again = await Client.login(app, T.host, T.users.payroll!.email);
    void pay;
    const r = await again.post(`/api/v1/loans/requests/${loan!.id}/defer`, { period, reason: 'A hard month for me' });
    expect([r.statusCode, problem(r).code]).toEqual([403, 'forbidden']);
    expect((await ownerQuery<{ skip_periods: string[] }>(`SELECT skip_periods FROM employee_loans WHERE id=$1`, [loan!.id]))[0]!.skip_periods).toEqual([]);
  });
});

describe('selfie id on the daily view', () => {
  it('only with the feature on, and only for those who may open the selfie', async () => {
    const T = await createTenant();
    const [s] = await ownerQuery<{ id: string }>(`INSERT INTO attendance_selfies (tenant_id, employee_id, storage_key, content_type, size_bytes, sha256, retain_until)
      VALUES ($1,$2,'k','image/png',1,'x',now() + interval '10 days') RETURNING id`, [T.id, T.users.employee!.employeeId]);
    const [ev] = await ownerQuery<{ id: string }>(`INSERT INTO attendance_events (tenant_id, employee_id, event_time, direction, source, status, source_ref)
      VALUES ($1,$2,($3::date + time '09:00') AT TIME ZONE 'Asia/Kolkata','in','web','accepted','e1') RETURNING id`, [T.id, T.users.employee!.employeeId, today]);
    await ownerQuery(`UPDATE attendance_selfies SET event_id=$2 WHERE id=$1`, [s!.id, ev!.id]);
    const row = (r: { json: () => { items: { employee_id: string; selfie_id?: string | null }[] } }) => r.json().items.find((i) => i.employee_id === T.users.employee!.employeeId);
    // Sequential: the store is one per process, and the app built last owns it.
    const on = await makeApp({ ...flags('default,attendance.selfie'), STORAGE_DRIVER: 'local', STORAGE_PATH: tmpdir() });
    try {
      const hrOn = await Client.login(on, T.host, T.users.hr!.email);
      await hrOn.post('/api/v1/attendance/recalculate', { from: today, to: today, employeeId: T.users.employee!.employeeId });
      const a = await hrOn.get(`/api/v1/attendance/daily?date=${today}`);
      expect(a.statusCode, a.body).toBe(200);
      expect(row(a)?.selfie_id).toBe(s!.id);
    } finally { await on.close(); }
    const off = await makeApp({ ...flags('default') });
    try {
      const hrOff = await Client.login(off, T.host, T.users.hr!.email);
      const b = await hrOff.get(`/api/v1/attendance/daily?date=${today}`);
      expect(row(b)).not.toHaveProperty('selfie_id');
    } finally { await off.close(); }
  });
});

describe('stuck approvals', () => {
  let app: FastifyInstance; let T: TenantFixture;
  beforeAll(async () => { app = await makeApp(); T = await createTenant(); });
  afterAll(() => app.close());

  it('users.manage lists requests nobody can act on; others cannot', async () => {
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    expect((await emp.get('/api/v1/approvals/stuck')).statusCode).toBe(403);
    const [r] = await ownerQuery<{ id: string }>(`INSERT INTO approval_requests (tenant_id, entity_type, entity_id, requester_id, summary, status, current_step)
      VALUES ($1,'leave_request',gen_random_uuid(),$2,'Stuck one','pending',0) RETURNING id`, [T.id, T.users.employee!.id]);
    // The only approver is disabled.
    await ownerQuery(`UPDATE users SET status='disabled' WHERE id=$1`, [T.users.other!.id]);
    await ownerQuery(`INSERT INTO approval_steps (tenant_id, request_id, step_index, approver_kind, approver_user_id, status) VALUES ($1,$2,0,'user',$3,'active')`, [T.id, r!.id, T.users.other!.id]);
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    const list = await admin.get('/api/v1/approvals/stuck');
    expect(list.statusCode, list.body).toBe(200);
    const item = list.json().items.find((i: { id: string }) => i.id === r!.id);
    expect(item).toMatchObject({ summary: 'Stuck one', requester_name: expect.any(String) });
    expect(list.json()).toMatchObject({ page: 1, total: expect.any(Number) });
  });
});

describe('a returned trip', () => {
  let app: FastifyInstance; let T: TenantFixture;
  beforeAll(async () => { app = await makeApp({ ...flags('default,expenses,travel') }); T = await createTenant(); });
  afterAll(() => app.close());
  const trip = (over: Record<string, unknown> = {}) => ({
    purpose: 'Client visit for audit', tripType: 'domestic', origin: 'Pune', destination: 'Delhi', startDate: addDays(today, 30), endDate: addDays(today, 32), travelMode: 'air', accommodation: true,
    estimate: { travel: 100, stay: 100, local: 0, meals: 0, other: 0 }, advance: 0, markOnDuty: false, ...over,
  });

  it('is changed and sent again, a new approval, by the traveller only', async () => {
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    const mgr = await Client.login(app, T.host, T.users.manager!.email);
    const created = await emp.post('/api/v1/travel/requests', trip());
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    expect((await emp.post(`/api/v1/travel/requests/${id}/resubmit`, trip())).statusCode).toBe(409);
    const ap = (await mgr.get('/api/v1/approvals/inbox')).json().items.find((i: { entity_id: string }) => i.entity_id === id);
    const back = await mgr.post(`/api/v1/approvals/${ap.id}/act`, { action: 'return', comment: 'Wrong dates' });
    expect(back.statusCode, back.body).toBe(200);
    expect((await emp.get(`/api/v1/travel/requests/${id}`)).json().status).toBe('returned');

    const other = await Client.login(app, T.host, T.users.other!.email);
    expect((await other.post(`/api/v1/travel/requests/${id}/resubmit`, trip())).statusCode).toBe(404);
    const bad = await emp.post(`/api/v1/travel/requests/${id}/resubmit`, trip({ destination: '' }));
    expect(problem(bad).code).toBe('validation_failed');

    const again = await emp.post(`/api/v1/travel/requests/${id}/resubmit`, trip({ destination: 'Mumbai', startDate: addDays(today, 40), endDate: addDays(today, 41) }));
    expect(again.statusCode, again.body).toBe(200);
    const after = (await emp.get(`/api/v1/travel/requests/${id}`)).json();
    expect(after).toMatchObject({ status: 'pending', destination: 'Mumbai' });
    const fresh = (await mgr.get('/api/v1/approvals/inbox')).json().items.find((i: { entity_id: string }) => i.entity_id === id);
    expect(fresh.id).not.toBe(ap.id);
  });
});
