import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture } from './helpers.js';
import { resolveEnabledModules } from '../src/core/features/state.js';
import { FEATURES } from '../src/core/features/registry.js';

// A module listed but not built yet (if any remain in this release).
const PLANNED = FEATURES.find((f) => f.availability === 'planned')?.key;

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });

const mod = async (c: Client, key: string) => (await c.get('/api/v1/tenant/installation')).json().modules.find((m: { key: string }) => m.key === key);

describe('ENABLED_MODULES validation (startup)', () => {
  it("expands 'default', always includes core modules, accepts extra modules", () => {
    const s = resolveEnabledModules('default,attendance.biometric');
    expect(s.has('core.employees')).toBe(true);
    expect(s.has('attendance.web')).toBe(true);
    expect(s.has('attendance.biometric')).toBe(true);
    expect(s.has('attendance.mobile')).toBe(false);
  });
  it('rejects unknown, unimplemented and dependency-missing modules with clear messages', () => {
    expect(() => resolveEnabledModules('default,nope')).toThrow(/unknown module 'nope'/);
    if (PLANNED) expect(() => resolveEnabledModules(`default,${PLANNED}`)).toThrow(new RegExp(`'${PLANNED.replace('.', '\\.')}' is not available in this release`));
    expect(() => resolveEnabledModules('attendance.web')).toThrow(/'attendance.web' requires 'attendance'/);
  });
  it('the app refuses to build with an invalid module list', async () => {
    await expect(makeApp({ ENABLED_MODULES: 'default,nope' })).rejects.toThrow(/unknown module 'nope'/);
    if (PLANNED) await expect(makeApp({ ENABLED_MODULES: `default,${PLANNED}` })).rejects.toThrow(/not available in this release/);
  });
});

describe('deployment-controlled modules', () => {
  let app2: FastifyInstance; let T: TenantFixture; let admin: Client; let deviceKey = '';
  // Web attendance deliberately NOT enabled for this installation.
  beforeAll(async () => {
    app2 = await makeApp({ ENABLED_MODULES: 'attendance,attendance.regularization,shifts,holidays,attendance.biometric' });
    T = await createTenant();
    admin = await Client.login(app2, T.host, T.users.admin!.email);
  });
  afterAll(async () => { await app2.close(); });

  it('reports supported / enabled / configured / usable separately', async () => {
    expect(await mod(admin, 'attendance.web')).toMatchObject({ supported: true, enabled: false, usable: false, blockers: ['Not enabled for this installation'] });
    if (PLANNED) expect(await mod(admin, PLANNED)).toMatchObject({ supported: false, enabled: false });
    expect(await mod(admin, 'attendance.biometric')).toMatchObject({ enabled: true, configured: false, usable: false });
    expect(await mod(admin, 'core.employees')).toMatchObject({ core: true, usable: true });
  });

  it('a disabled module is rejected by the API and hidden via capabilities; history is kept', async () => {
    await ownerQuery(`INSERT INTO attendance_events (tenant_id, employee_id, source, source_ref, event_time, direction) VALUES ($1,$2,'web','old-1', now() - interval '1 day','in')`,
      [T.id, T.users.employee!.employeeId]);
    const emp = await Client.login(app2, T.host, T.users.employee!.email);
    const r = await emp.post('/api/v1/attendance/punch', { channel: 'web', idempotencyKey: 'disabled-1' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('feature_unavailable');
    expect((await emp.get('/api/v1/auth/me')).json().capabilities['attendance.web']).toBe(false);
    expect((await ownerQuery(`SELECT 1 FROM attendance_events WHERE tenant_id=$1`, [T.id])).length).toBe(1);
  });

  it('becomes usable once configured (biometric: first device registered)', async () => {
    const it = await Client.login(app2, T.host, T.users.it!.email);
    const r = await it.post('/api/v1/attendance/devices', { branchId: T.branchId, serialNumber: 'SN-1', name: 'Gate', adapterKey: 'generic_push_v1' });
    expect(r.statusCode).toBe(201);
    deviceKey = r.json().apiKey;
    expect((await mod(admin, 'attendance.biometric')).usable).toBe(true);
  });

  it('administrators cannot change module enablement', async () => {
    expect((await admin.put('/api/v1/tenant/modules/attendance.web', { enabled: true })).statusCode).toBe(404);
    expect((await admin.get('/api/v1/tenant/installation')).json().managedBy).toBe('deployment');
  });

  it('a module disabled in deployment config rejects even valid device credentials', async () => {
    // Same database, redeployed with biometric removed from ENABLED_MODULES (module state is per process).
    const app3 = await makeApp({ ENABLED_MODULES: 'default' });
    const r = await app3.inject({ method: 'POST', url: '/api/v1/devices/events', headers: { host: 'x', 'x-device-key': deviceKey },
      payload: { deviceTime: new Date().toISOString(), events: [{ eventId: 'e1', deviceUserId: '1', timestamp: new Date().toISOString() }] } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('feature_unavailable');
    await app3.close();
    await makeApp().then((a) => a.close()); // restore the default test module set for the rest of this file
  });
});

describe('settings center', () => {
  let T: TenantFixture; let admin: Client;
  beforeAll(async () => { T = await createTenant(); admin = await Client.login(app, T.host, T.users.admin!.email); });
  const get = async (c: Client, key: string, q = '') => (await c.get(`/api/v1/tenant/settings${q}`)).json().items.find((s: { key: string }) => s.key === key);

  it('shows defaults with their source', async () => {
    const s = await get(admin, 'attendance.weekly_offs');
    expect(s).toMatchObject({ effective: [0], source: 'default', defaultValue: [0] });
  });

  it('persists a tenant value, applies it without restart, and audits the change', async () => {
    expect((await admin.put('/api/v1/tenant/settings/attendance.weekly_offs', { value: [6, 0] })).statusCode).toBe(200);
    const s = await get(admin, 'attendance.weekly_offs');
    expect(s).toMatchObject({ effective: [0, 6], source: 'tenant' });
    const [log] = await ownerQuery<{ change_metadata: { from: unknown; to: unknown } }>(
      `SELECT change_metadata FROM audit_logs WHERE tenant_id=$1 AND setting_key='attendance.weekly_offs'`, [T.id]);
    expect(log!.change_metadata).toEqual({ from: null, to: [0, 6] });
  });

  it('branch override takes precedence over tenant value; reset restores inheritance', async () => {
    await admin.put('/api/v1/tenant/settings/attendance.weekly_offs', { value: [0], scope: 'branch', branchId: T.branchId });
    expect(await get(admin, 'attendance.weekly_offs', `?branchId=${T.branchId}`)).toMatchObject({ effective: [0], source: 'branch', tenantValue: [0, 6] });
    expect((await admin.del(`/api/v1/tenant/settings/attendance.weekly_offs?scope=branch&branchId=${T.branchId}`)).statusCode).toBe(200);
    expect(await get(admin, 'attendance.weekly_offs', `?branchId=${T.branchId}`)).toMatchObject({ effective: [0, 6], source: 'tenant' });
  });

  it('rejects branch overrides for tenant-only settings and invalid values', async () => {
    expect((await admin.put('/api/v1/tenant/settings/general.date_format', { value: 'YYYY-MM-DD', scope: 'branch', branchId: T.branchId })).statusCode).toBe(400);
    expect((await admin.put('/api/v1/tenant/settings/general.timezone', { value: 'Mars/Olympus' })).statusCode).toBe(400);
    expect((await admin.put('/api/v1/tenant/settings/security.password_min_length', { value: 6 })).statusCode).toBe(400);
  });

  it('enforces the deployment ceiling over tenant values', async () => {
    const r = await admin.put('/api/v1/tenant/settings/security.session_ttl_hours', { value: 48 });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/cannot exceed 24/);
  });

  it('detects concurrent edits via expectedVersion', async () => {
    const s = await get(admin, 'attendance.weekly_offs');
    expect((await admin.put('/api/v1/tenant/settings/attendance.weekly_offs', { value: [0], expectedVersion: s.version })).statusCode).toBe(200);
    expect((await admin.put('/api/v1/tenant/settings/attendance.weekly_offs', { value: [6], expectedVersion: s.version })).statusCode).toBe(400);
  });

  it('enforces per-setting edit permissions', async () => {
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    expect((await hr.put('/api/v1/tenant/settings/attendance.overtime_enabled', { value: true })).statusCode).toBe(200);
    expect((await hr.put('/api/v1/tenant/settings/security.max_failed_logins', { value: 4 })).statusCode).toBe(403);
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    expect((await emp.get('/api/v1/tenant/settings')).statusCode).toBe(403);
  });

  it('settings of one tenant never affect another', async () => {
    const U = await createTenant();
    const adminU = await Client.login(app, U.host, U.users.admin!.email);
    expect((await get(adminU, 'attendance.weekly_offs')).source).toBe('default');
  });

  it('organization defaults from deployment config appear as the deployment layer and can be overridden', async () => {
    const tz = await get(admin, 'general.timezone');
    expect(tz).toMatchObject({ effective: 'Asia/Kolkata', source: 'deployment' });
    expect((await admin.put('/api/v1/tenant/settings/general.timezone', { value: 'Asia/Dubai' })).statusCode).toBe(200);
    expect(await get(admin, 'general.timezone')).toMatchObject({ effective: 'Asia/Dubai', source: 'tenant', defaultValue: 'Asia/Kolkata' });
  });
});
