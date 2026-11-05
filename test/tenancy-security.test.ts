import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, PASSWORD, type TenantFixture } from './helpers.js';

let app: FastifyInstance;
let A: TenantFixture; let B: TenantFixture;

beforeAll(async () => { app = await makeApp(); A = await createTenant(); B = await createTenant(); });
afterAll(async () => { await app.close(); });

describe('tenant resolution', () => {
  it('rejects requests for unknown hosts', async () => {
    const c = new Client(app, 'evil.example.com');
    const r = await c.post('/api/v1/auth/login', { email: A.users.admin!.email, password: PASSWORD });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('unknown_tenant');
  });

  it('does not resolve a registered but unverified/inactive domain', async () => {
    await ownerQuery(`INSERT INTO tenant_domains (tenant_id, hostname, verification_token) VALUES ($1,$2,'tok')`, [A.id, `pending-${A.host}`]);
    const r = await new Client(app, `pending-${A.host}`).get('/api/v1/public/config');
    expect(r.statusCode).toBe(404);
  });


  it('rejects a malformed Host header', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/public/config', headers: { host: 'bad host!!' } });
    expect(r.statusCode).toBe(404);
  });
});

describe('cross-tenant isolation', () => {
  it("does not let tenant A's user log in on tenant B's domain", async () => {
    const r = await new Client(app, B.host).post('/api/v1/auth/login', { email: A.users.admin!.email, password: PASSWORD });
    expect(r.statusCode).toBe(401);
  });

  it("rejects tenant A's session cookie replayed against tenant B's host", async () => {
    const a = await Client.login(app, A.host, A.users.hr!.email);
    const replay = new Client(app, B.host);
    replay.cookie = a.cookie; replay.csrf = a.csrf;
    expect((await replay.get('/api/v1/employees')).statusCode).toBe(401);
    expect((await replay.get('/api/v1/auth/me')).statusCode).toBe(401);
  });

  it("returns 404 for another tenant's employee by id, even for HR admins", async () => {
    const hrA = await Client.login(app, A.host, A.users.hr!.email);
    const bEmployee = B.users.employee!.employeeId!;
    expect((await hrA.get(`/api/v1/employees/${bEmployee}`)).statusCode).toBe(404);
    expect((await hrA.get(`/api/v1/attendance/employees/${bEmployee}?from=2026-01-01&to=2026-01-31`)).statusCode).toBe(404);
    const list = (await hrA.get('/api/v1/employees?pageSize=100')).json();
    expect(list.items.every((e: { id: string }) => e.id !== bEmployee)).toBe(true);
  });

  it("cannot reference another tenant's branch when creating an employee", async () => {
    const hrA = await Client.login(app, A.host, A.users.hr!.email);
    const r = await hrA.post('/api/v1/employees', { employee: { employeeCode: 'X1', firstName: 'Cross', legalEntityId: B.legalEntityId, branchId: B.branchId, dateOfJoining: '2025-01-01' } });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
  });

  it("does not show another tenant's audit entries", async () => {
    const adminB = await Client.login(app, B.host, B.users.admin!.email);
    const r = (await adminB.get('/api/v1/tenant/audit?pageSize=100')).json();
    const tenantIds = await ownerQuery<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM audit_logs WHERE id = ANY($1)`, [r.items.map((x: { id: string }) => x.id)]);
    expect(tenantIds.every((t) => t.tenant_id === B.id)).toBe(true);
  });


});

describe('deployment-controlled configuration cannot be changed in the app', () => {
  it('has no endpoints to register domains, change branding or toggle modules', async () => {
    const admin = await Client.login(app, A.host, A.users.admin!.email);
    expect((await admin.post('/api/v1/tenant/domains', { hostname: 'evil.example.com' })).statusCode).toBe(404);
    expect((await admin.put('/api/v1/tenant/branding', { displayName: 'X', primaryColor: '#000000', secondaryColor: '#000000' })).statusCode).toBe(404);
    expect((await admin.put('/api/v1/tenant/modules/attendance', { enabled: false })).statusCode).toBe(404);
    expect((await admin.get('/api/v1/platform/tenants')).statusCode).toBe(404);
  });

  it('a suspended organization cannot sign in and its sessions are rejected', async () => {
    const T = await createTenant();
    const u = await Client.login(app, T.host, T.users.employee!.email);
    await ownerQuery(`UPDATE tenants SET status='suspended' WHERE id=$1`, [T.id]);
    expect((await u.get('/api/v1/auth/me')).statusCode).toBe(403);
    expect((await new Client(app, T.host).post('/api/v1/auth/login', { email: T.users.employee!.email, password: PASSWORD })).statusCode).toBe(403);
  });
});

describe('authentication & session security', () => {
  it('requires the CSRF token on state-changing requests', async () => {
    const c = await Client.login(app, A.host, A.users.admin!.email);
    const csrf = c.csrf; c.csrf = '';
    const r = await c.put('/api/v1/tenant/settings/general.date_format', { value: 'YYYY-MM-DD' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('csrf_failed');
    c.csrf = csrf;
    expect((await c.put('/api/v1/tenant/settings/general.date_format', { value: 'YYYY-MM-DD' })).statusCode).toBe(200);
  });

  it('backs off after repeated failures from one address and records audit events', async () => {
    const T = await createTenant();
    const c = new Client(app, T.host);
    for (let i = 0; i < 5; i++) expect((await c.post('/api/v1/auth/login', { email: T.users.other!.email, password: 'wrong-password' })).statusCode).toBe(401);
    // Correct password is refused from this address while it waits. test/sessions.test.ts covers everyone else getting in.
    expect((await c.post('/api/v1/auth/login', { email: T.users.other!.email, password: PASSWORD })).statusCode).toBe(429);
    const logs = await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='auth.login_failed'`, [T.id]);
    expect(logs.length).toBe(5);
  });

  it('logout revokes the session server-side', async () => {
    const c = await Client.login(app, A.host, A.users.employee!.email);
    const cookie = c.cookie;
    await c.post('/api/v1/auth/logout');
    const replay = new Client(app, A.host); replay.cookie = cookie;
    expect((await replay.get('/api/v1/auth/me')).statusCode).toBe(401);
  });

  it('disabling a user revokes their active sessions immediately', async () => {
    const T = await createTenant();
    const victim = await Client.login(app, T.host, T.users.other!.email);
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    expect((await admin.patch(`/api/v1/tenant/users/${T.users.other!.id}`, { status: 'disabled' })).statusCode).toBe(200);
    expect((await victim.get('/api/v1/auth/me')).statusCode).toBe(401);
  });

  it('admins cannot assign unknown roles or remove the last administrator', async () => {
    const T = await createTenant();
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    expect((await admin.patch(`/api/v1/tenant/users/${T.users.hr!.id}`, { roles: ['platform_super_admin'] })).statusCode).toBe(400);
    expect((await admin.patch(`/api/v1/tenant/users/${T.users.admin!.id}`, { roles: ['employee'] })).statusCode).toBe(409);
  });

  it('user management cannot be used to escalate: only an administrator grants roles beyond their own', async () => {
    const T = await createTenant();
    const it = T.users.it!; // IT administrator: has users.manage, not HR or payroll permissions
    const itAdmin = await Client.login(app, T.host, it.email);
    const user = (email: string, roles: string[]) => itAdmin.post('/api/v1/tenant/users', { email, displayName: 'New Person', roles });
    // not to themselves, not to a new account, not by removing someone else's
    for (const roles of [['it_admin', 'hr_admin'], ['it_admin', 'tenant_admin'], ['it_admin', 'payroll_manager']])
      expect((await itAdmin.patch(`/api/v1/tenant/users/${it!.id}`, { roles })).statusCode).toBe(403);
    expect((await user(`x1@${T.host}`, ['hr_admin'])).statusCode).toBe(403);
    expect((await user(`x2@${T.host}`, ['tenant_admin'])).statusCode).toBe(403);
    // accounts holding permissions the IT administrator lacks are off limits (disable, MFA reset, role change)
    for (const body of [{ status: 'disabled' }, { resetMfa: true }, { roles: ['employee'] }])
      expect((await itAdmin.patch(`/api/v1/tenant/users/${T.users.hr!.id}`, body)).statusCode).toBe(403);
    expect((await itAdmin.patch(`/api/v1/tenant/users/${T.users.admin!.id}`, { status: 'disabled' })).statusCode).toBe(403);
    const [{ n }] = (await ownerQuery<{ n: number }>(`SELECT count(*)::int AS n FROM user_roles WHERE user_id=$1`, [it!.id])) as [{ n: number }];
    expect(n).toBe(1);
    // ordinary accounts are still theirs to run
    const ok = await user(`staff@${T.host}`, ['employee']);
    expect(ok.statusCode).toBe(201);
    expect((await itAdmin.patch(`/api/v1/tenant/users/${ok.json().id}`, { status: 'disabled' })).statusCode).toBe(200);
    // an administrator can grant any role
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    expect((await admin.patch(`/api/v1/tenant/users/${ok.json().id}`, { roles: ['hr_admin'] })).statusCode).toBe(200);
    // the role list tells each of them which roles they may grant, matching what the server enforces
    const grantable = async (c: Client) => (await c.get('/api/v1/tenant/roles')).json().system
      .filter((r: { grantable: boolean }) => r.grantable).map((r: { key: string }) => r.key) as string[];
    const itMay = await grantable(itAdmin);
    expect(itMay).toEqual(expect.arrayContaining(['employee']));
    for (const k of ['it_admin', 'hr_admin', 'tenant_admin', 'payroll_manager']) expect(itMay).not.toContain(k);
    // Nobody grants a role at or above their own level, an administrator included (D40).
    expect(await grantable(admin)).toContain('hr_admin');
    expect(await grantable(admin)).not.toContain('tenant_admin');
  });

  it('never returns password hashes or session tokens in user listings', async () => {
    const admin = await Client.login(app, A.host, A.users.admin!.email);
    const body = (await admin.get('/api/v1/tenant/users')).body;
    expect(body).not.toContain('scrypt$');
    expect(body).not.toContain('argon2id$');
    expect(body).not.toContain('password');
  });

  it('sets security headers', async () => {
    const r = await new Client(app, A.host).get('/api/v1/public/config');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
  });
});
