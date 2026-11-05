import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { problem, makeApp, createTenant, Client, ownerQuery, flags, inApp, multipart, type TenantFixture, seal } from './helpers.js';
import { TINY_PNG } from './images.js';
import { TEST_OWNER_URL } from './env.js';
import { notifyUsers } from '../src/core/notify/service.js';
import { generateDemo } from '../src/db/demo.js';
import { withTenant } from '../src/db/tx.js';
import { getStore } from '../src/core/storage/index.js';
import { tick } from '../src/core/jobs/scheduler.js';
import { currentFeatures, isModuleEnabled, withFeatures } from '../src/core/features/state.js';
import { resolveFeatures } from '../src/core/features/registry.js';

const quiet = { info: () => undefined, error: () => undefined };

describe('each app has its own set of features', () => {
  it('a request sees its own app\'s flags whichever app was built last, on GET and after a body was read', async () => {
    const a = await makeApp({ ...flags('default,attendance.mobile') });
    const b = await makeApp({ ...flags('default') });
    const T = await createTenant();
    const [ca, cb] = [await Client.login(a, T.host, T.users.employee!.email), await Client.login(b, T.host, T.users.other!.email)];
    const body = { channel: 'mobile', idempotencyKey: 'iso-mobile-1' };
    expect((await cb.post('/api/v1/attendance/punch', body)).statusCode).toBe(404);
    expect((await ca.post('/api/v1/attendance/punch', body)).statusCode).toBe(200);
    expect((await cb.post('/api/v1/attendance/punch', { ...body, idempotencyKey: 'iso-mobile-2' })).statusCode).toBe(404);
    expect((await ca.get('/api/v1/auth/me')).json().capabilities['attendance.mobile']).toBe(true);
    expect((await cb.get('/api/v1/auth/me')).json().capabilities['attendance.mobile']).toBe(false);
    await a.close(); await b.close();
  });

  it('outside any app, code sees the registry defaults; there is no global to leave behind', async () => {
    const a = await makeApp({ ...flags('payroll,attendance') });
    expect(isModuleEnabled('payroll')).toBe(false);
    expect(inApp(a, () => isModuleEnabled('payroll'))).toBe(true);
    expect(withFeatures(new Set(['x']), () => [...currentFeatures()])).toEqual(['x']);
    expect(isModuleEnabled('leave')).toBe(true);
    await a.close();
  });

  it('a flag outside this process is parsed the same way by seeds and the demo', () => {
    expect(resolveFeatures({ FEATURE_PAYROLL: 'true' }).features.has('payroll')).toBe(true);
  });
});

describe('pending approvals of a module that is off', () => {
  let on: FastifyInstance; let off: FastifyInstance; let T: TenantFixture; let requestId: string;
  beforeAll(async () => {
    on = await makeApp({ ...flags('default') });
    off = await makeApp({ ...flags('default'), FEATURE_LEAVE: 'false' });
    T = await createTenant();
    const hr = await Client.login(on, T.host, T.users.hr!.email);
    const type = await hr.post('/api/v1/leave/types', { code: 'CL', name: 'Casual', paid: true, requiresBalance: false, accrualMethod: 'none', annualEntitlement: 0 });
    expect(type.statusCode).toBe(201);
    const emp = await Client.login(on, T.host, T.users.employee!.email);
    const r = await emp.post('/api/v1/leave/requests', { leaveTypeId: type.json().id, startDate: '2030-03-04', endDate: '2030-03-04', reason: 'Family function' });
    expect(r.statusCode).toBe(201);
    const [row] = await ownerQuery<{ id: string }>(`SELECT id FROM approval_requests WHERE tenant_id=$1 AND entity_type='leave_request'`, [T.id]);
    requestId = row!.id;
  });
  afterAll(async () => { await on.close(); await off.close(); });

  it('leave the inbox, the requester\'s list and the detail view, and answer 404 to every action', async () => {
    const mgr = await Client.login(off, T.host, T.users.manager!.email);
    const emp = await Client.login(off, T.host, T.users.employee!.email);
    const hr = await Client.login(off, T.host, T.users.hr!.email);
    expect((await mgr.get('/api/v1/approvals/inbox')).json().items).toEqual([]);
    expect((await emp.get('/api/v1/approvals/mine')).json().items).toEqual([]);
    expect((await mgr.get(`/api/v1/approvals/${requestId}`)).statusCode).toBe(404);
    expect((await mgr.post(`/api/v1/approvals/${requestId}/act`, { action: 'approve' })).statusCode).toBe(404);
    expect((await emp.post(`/api/v1/approvals/${requestId}/cancel`)).statusCode).toBe(404);
    expect((await hr.post(`/api/v1/approvals/${requestId}/reassign`, { userId: T.users.other!.id, reason: 'covering for now' })).statusCode).toBe(404);
  });

  it('get no reminders or escalations while off', async () => {
    await ownerQuery(`UPDATE approval_requests SET created_at=now() - interval '30 days' WHERE id=$1`, [requestId]);
    await ownerQuery(`UPDATE approval_steps SET activated_at=now() - interval '30 days' WHERE request_id=$1`, [requestId]);
    await ownerQuery(`INSERT INTO tenant_settings (tenant_id, setting_key, scope_type, setting_value) VALUES ($1,'approvals.escalate_after_days','tenant','1')`, [T.id]);
    const admin = await Client.login(off, T.host, T.users.admin!.email);
    expect((await admin.runJob('approvals.reminder')).json().status).toBe('succeeded');
    expect((await admin.runJob('approvals.escalation')).json().result).toMatchObject({ escalated: 0 });
    expect(await ownerQuery(`SELECT 1 FROM notifications WHERE tenant_id=$1 AND kind='approval.reminder'`, [T.id])).toHaveLength(0);
    const [step] = await ownerQuery<{ escalated_at: Date | null; status: string }>(`SELECT escalated_at, status FROM approval_steps WHERE request_id=$1`, [requestId]);
    expect(step).toMatchObject({ escalated_at: null, status: 'active' });
  });

  it('resume unchanged when the flag returns', async () => {
    await ownerQuery(`DELETE FROM tenant_settings WHERE tenant_id=$1 AND setting_key='approvals.escalate_after_days'`, [T.id]);
    const mgr = await Client.login(on, T.host, T.users.manager!.email);
    const items = (await mgr.get('/api/v1/approvals/inbox')).json().items as { id: string }[];
    expect(items.map((i) => i.id)).toEqual([requestId]);
    expect((await mgr.post(`/api/v1/approvals/${requestId}/act`, { action: 'approve' })).json().status).toBe('approved');
  });
});

describe('everything an administrator can list follows the flags', () => {
  let off: FastifyInstance; let T: TenantFixture; let admin: Client; let hr: Client;
  beforeAll(async () => {
    off = await makeApp({ ...flags('default'), FEATURE_LEAVE: 'false' });
    T = await createTenant();
    admin = await Client.login(off, T.host, T.users.admin!.email);
    hr = await Client.login(off, T.host, T.users.hr!.email);
  });
  afterAll(async () => { await off.close(); });

  it('role and permission listings', async () => {
    const r = (await admin.get('/api/v1/tenant/roles')).json();
    const keys = (r.permissions as { key: string }[]).map((p) => p.key);
    expect(keys).toContain('employees.read');
    expect(keys.filter((k) => k.startsWith('leave.') || k.startsWith('payroll.') || k.startsWith('recruitment.'))).toEqual([]);
    for (const role of r.system as { permissions: string[] }[]) expect(role.permissions.filter((p) => p.startsWith('leave.'))).toEqual([]);
  });

  it('/auth/me', async () => {
    const me = (await hr.get('/api/v1/auth/me')).json();
    expect((me.permissions as string[]).filter((p) => p.startsWith('leave.'))).toEqual([]);
    expect(me.capabilities.leave).toBe(false);
    expect(me.capabilities.attendance).toBe(true);
    expect(me.capabilities).not.toHaveProperty('advances_loans');
  });

  it('/tenant/settings, which also refuses to change them', async () => {
    const items = (await admin.get('/api/v1/tenant/settings')).json().items as { key: string }[];
    expect(items.map((s) => s.key)).toContain('attendance.weekly_offs');
    expect(items.filter((s) => s.key.startsWith('leave.') || s.key.startsWith('overtime.'))).toEqual([]);
    expect((await admin.put('/api/v1/tenant/settings/leave.year_start_month', { value: 1 })).statusCode).toBe(404);
    expect((await admin.del('/api/v1/tenant/settings/leave.year_start_month')).statusCode).toBe(404);
  });

  it('/tenant/jobs: gone, and cannot be run, except retention which still is', async () => {
    const items = (await admin.get('/api/v1/tenant/jobs')).json().items as { key: string; active: boolean }[];
    const keys = items.map((j) => j.key);
    expect(keys).not.toContain('leave.accrual');
    expect(keys).not.toContain('reports.scheduled');
    expect(items.find((j) => j.key === 'recruitment.retention')!.active).toBe(true);
    expect((await hr.post('/api/v1/tenant/jobs/leave.accrual/run')).statusCode).toBe(404);
    expect((await hr.runJob('recruitment.retention')).json().status).toBe('succeeded');
  });

  it('/tenant/installation lists only what is on', async () => {
    const mods = (await admin.get('/api/v1/tenant/installation')).json().modules as { key: string }[];
    expect(mods.map((m) => m.key)).toContain('attendance');
    expect(mods.map((m) => m.key)).not.toContain('leave');
  });

  it('reports and the dashboard', async () => {
    const reports = (await hr.get('/api/v1/reports')).json().items as { key: string }[];
    expect(reports.map((r) => r.key)).not.toContain('leave_taken');
    expect((await hr.get('/api/v1/reports/leave_taken')).statusCode).toBe(404);
    expect(JSON.stringify((await hr.get('/api/v1/dashboard/summary')).json())).not.toMatch(/"leave_/);
  });
});

describe('report snapshots', () => {
  it('of a module that is off leave the list and answer 404, and schedules wait unchanged', async () => {
    const off = await makeApp({ ...flags('default,reports.advanced'), FEATURE_LEAVE: 'false' });
    const on = await makeApp({ ...flags('default,reports.advanced') });
    const T = await createTenant();
    const hrId = T.users.hr!.id;
    const [s] = await ownerQuery<{ id: string }>(`INSERT INTO report_snapshots (tenant_id, owner_id, report_key, name, params, scope, columns, data_enc, row_count, recipient_ids, expires_at)
      VALUES ($1,$2,'leave_taken','L','{}','all','[]',$4,0,$3, now() + interval '1 day') RETURNING id`, [T.id, hrId, [hrId], seal({ rows: [], totals: null })]);
    const hrOff = await Client.login(off, T.host, T.users.hr!.email);
    const hrOn = await Client.login(on, T.host, T.users.hr!.email);
    expect((await hrOff.get('/api/v1/reports/snapshots')).json().items).toEqual([]);
    expect((await hrOff.get(`/api/v1/reports/snapshots/${s!.id}`)).statusCode).toBe(404);
    expect((await hrOn.get('/api/v1/reports/snapshots')).json().items).toHaveLength(1);
    await off.close(); await on.close();
  });
});

describe('in-app notifications', () => {
  it('are not written while off, and those already written go out of sight and come back', async () => {
    const on = await makeApp({ ...flags('default,payroll,payroll.payslips') });
    const off = await makeApp({ ...flags('default') });
    const T = await createTenant();
    const user = T.users.employee!.id;
    await inApp(on, () => withTenant(on.deps.pool, T.id, (db) => notifyUsers(db, T.id, [user], { kind: 'payroll.payslip', title: 'Payslip ready', link: '/payslips' })));
    expect((await inApp(off, () => withTenant(off.deps.pool, T.id, (db) => notifyUsers(db, T.id, [user], { kind: 'payroll.payslip', title: 'Another' })))).inApp).toBe(0);
    const empOff = await Client.login(off, T.host, T.users.employee!.email);
    const empOn = await Client.login(on, T.host, T.users.employee!.email);
    expect((await empOff.get('/api/v1/notifications')).json().items ?? (await empOff.get('/api/v1/notifications')).json().rows).toEqual([]);
    expect((await empOff.get('/api/v1/notifications/unread-count')).json().unread).toBe(0);
    expect((await empOn.get('/api/v1/notifications/unread-count')).json().unread).toBe(1);
    await on.close(); await off.close();
  });
});

describe('fields of a module that is off', () => {
  it('are not in employee records or expense claims', async () => {
    const on = await makeApp({ ...flags('default,core.onboarding,expenses,travel') });
    const off = await makeApp({ ...flags('default,expenses') });
    const T = await createTenant();
    const url = `/api/v1/employees/${T.users.employee!.employeeId}`;
    expect((await (await Client.login(on, T.host, T.users.hr!.email)).get(url)).json()).toHaveProperty('probation_end_date');
    expect((await (await Client.login(off, T.host, T.users.hr!.email)).get(url)).json()).not.toHaveProperty('probation_end_date');
    const [c] = await ownerQuery<{ id: string }>(`INSERT INTO expense_claims (tenant_id, employee_id, title, purpose, created_by) VALUES ($1,$2,'Claim','Purpose',$3) RETURNING id`, [T.id, T.users.employee!.employeeId, T.users.employee!.id]);
    const claim = (await (await Client.login(off, T.host, T.users.employee!.email)).get(`/api/v1/expenses/claims/${c!.id}`)).json();
    expect(claim).toHaveProperty('title');
    expect(claim).not.toHaveProperty('travel_request_id');
    expect(claim).not.toHaveProperty('advance_adjusted');
    await on.close(); await off.close();
  });
});

describe('on but not set up stays registered and says so', () => {
  it('answers 409 feature_not_configured, not 404', async () => {
    const app = await makeApp({ ...flags('default,overtime,attendance.biometric') });
    const T = await createTenant();
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    const r = await emp.get('/api/v1/overtime/eligible');
    expect([r.statusCode, problem(r).code]).toEqual([409, 'feature_not_configured']);
    expect(app.hasRoute({ method: 'POST', url: '/api/v1/devices/events' })).toBe(true);
    await app.close();
  });
});

describe('retention follows the date, not the flag', () => {
  it('erases a selfie whose feature is off, in a scheduled pass', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'hrms-ret-'));
    const on = await makeApp({ ...flags('default,attendance.selfie'), STORAGE_DRIVER: 'local', STORAGE_PATH: root });
    const T = await createTenant();
    const emp = await Client.login(on, T.host, T.users.employee!.email);
    const m = multipart({}, { name: 'me.png', content: TINY_PNG });
    const id = (await emp.req('POST', '/api/v1/attendance/selfies', m.body, m.headers)).json().id as string;
    await on.close();
    await ownerQuery(`UPDATE attendance_selfies SET retain_until=now() - interval '1 minute' WHERE id=$1`, [id]);
    const [{ storage_key: key }] = (await ownerQuery<{ storage_key: string }>('SELECT storage_key FROM attendance_selfies WHERE id=$1', [id])) as [{ storage_key: string }];

    const off = await makeApp({ ...flags('default'), STORAGE_DRIVER: 'local', STORAGE_PATH: root });
    await inApp(off, () => tick(off.deps.pool, quiet, new Date(`${new Date().toISOString().slice(0, 10)}T23:30:00+05:30`)));
    await expect(getStore()!.get(key)).rejects.toThrow();
    expect((await ownerQuery<{ erased_at: Date | null }>('SELECT erased_at FROM attendance_selfies WHERE id=$1', [id]))[0]!.erased_at).not.toBeNull();
    await off.close();
  });
});

describe('the demo generator follows the flags', () => {
  it('creates nothing for a module that is off', async () => {
    const [t] = await ownerQuery<{ id: string }>(`INSERT INTO tenants (slug, name) VALUES ($1,'Flag Labs') RETURNING id`, ['f' + randomBytes(5).toString('hex')]);
    const tid = t!.id;
    await ownerQuery(`INSERT INTO tenant_domains (tenant_id, hostname, verification_token, verification_status, verified_at, activation_status) VALUES ($1,$2,'x','verified',now(),'active')`, [tid, `f${randomBytes(4).toString('hex')}.test`]);
    const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,'A','x') RETURNING id`, [tid, `a${randomBytes(3).toString('hex')}@x.test`]);
    await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'tenant_admin')`, [u!.id, tid]);
    const c = new pg.Client({ connectionString: TEST_OWNER_URL });
    await c.connect();
    try {
      const today = new Date().toISOString().slice(0, 10);
      await generateDemo(c, { password: 'Demo-Password-123!', today, tenantId: tid, features: resolveFeatures({ FEATURE_DOCUMENTS: 'false', FEATURE_LEAVE: 'false', FEATURE_HOLIDAYS: 'false' }).features });
    } finally { await c.end(); }
    const count = async (table: string) => Number((await ownerQuery<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE tenant_id=$1`, [tid]))[0]!.n);
    expect(await count('employees')).toBeGreaterThan(0);
    for (const table of ['leave_types', 'holidays', 'overtime_claims', 'expense_claims', 'travel_requests', 'employee_loans', 'policies', 'job_requisitions', 'assets', 'review_cycles', 'training_courses', 'pay_components', 'posh_committee_members']) {
      expect([table, await count(table)]).toEqual([table, 0]);
    }
  });
});
