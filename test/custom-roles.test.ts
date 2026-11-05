import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { problem, makeApp, createTenant, Client, ownerQuery, type TenantFixture, flags } from './helpers.js';

// The organization's own roles: defined within the grant limits, applied at once, never a way around MFA.
let app: FastifyInstance; let T: TenantFixture;
let admin: Client; let it_: Client;
const login = (k: string) => Client.login(app, T.host, T.users[k]!.email);
const me = async (c: Client) => (await c.get('/api/v1/auth/me')).json();
const roles = async (c: Client) => (await c.get('/api/v1/tenant/roles')).json();

beforeAll(async () => {
  app = await makeApp({ ...flags('default,leave,training') });
  T = await createTenant();
  admin = await login('admin'); it_ = await login('it');
});
afterAll(async () => { await app.close(); });

describe('custom roles', () => {
  let key = '';
  it('an administrator defines a role; holders get exactly its permissions', async () => {
    const r = await admin.post('/api/v1/tenant/roles', { name: 'Lab coordinator', description: 'Keeps training records for the floor',
      permissions: ['training.manage', 'leave.team.read', 'training.manage'] });
    expect(r.statusCode).toBe(201);
    key = r.json().key;
    expect(key).toBe('custom:lab_coordinator');
    const listed = (await roles(admin)).custom.find((x: { key: string }) => x.key === key);
    expect(listed).toMatchObject({ name: 'Lab coordinator', permissions: ['leave.team.read', 'training.manage'], users: 0, updated_by_name: 'admin' });

    expect((await admin.patch(`/api/v1/tenant/users/${T.users.other!.id}`, { roles: ['employee', key] })).statusCode).toBe(200);
    const other = await login('other');
    const perms: string[] = (await me(other)).permissions;
    expect(perms).toContain('training.manage');
    expect(perms).not.toContain('employees.read');
    expect((await roles(admin)).custom.find((x: { key: string }) => x.key === key).users).toBe(1);

    // Taking a permission away signs holders out, so it applies at once.
    const p = await admin.patch(`/api/v1/tenant/roles/${key}`, { permissions: ['leave.team.read'] });
    expect(p.json()).toEqual({ ok: true, holdersSignedOut: 1 });
    expect((await other.get('/api/v1/auth/me')).statusCode).toBe(401);
    expect((await me(await login('other'))).permissions).not.toContain('training.manage');
    // A rename alone changes nothing for holders.
    expect((await admin.patch(`/api/v1/tenant/roles/${key}`, { name: 'Floor coordinator' })).json().holdersSignedOut).toBe(0);
  });

  it('refuses built-in names, duplicates, unknown permissions and built-in roles', async () => {
    let r = await admin.post('/api/v1/tenant/roles', { name: 'hr administrator', permissions: ['leave.read'] });
    expect(r.statusCode).toBe(409);
    r = await admin.post('/api/v1/tenant/roles', { name: 'FLOOR COORDINATOR', permissions: ['leave.read'] });
    expect(problem(r).detail).toMatch(/already exists/);
    r = await admin.post('/api/v1/tenant/roles', { name: 'Odd', permissions: ['leave.fly'] });
    expect(r.statusCode).toBe(400);
    expect((await admin.patch('/api/v1/tenant/roles/hr_admin', { name: 'X' })).statusCode).toBe(400);
    expect((await admin.del('/api/v1/tenant/roles/tenant_admin')).statusCode).toBe(400);
  });

  it('someone with users.manage but not an administrator works only within their own permissions', async () => {
    let r = await it_.post('/api/v1/tenant/roles', { name: 'Payroll peek', permissions: ['payroll.read'] });
    expect(r.statusCode).toBe(403);
    expect(problem(r).detail).toMatch(/View payroll runs/);
    r = await it_.post('/api/v1/tenant/roles', { name: 'Asset desk', permissions: ['assets.manage', 'org.read'] });
    expect(r.statusCode).toBe(201);
    expect((await it_.patch(`/api/v1/tenant/roles/${key}`, { name: 'Mine now' })).statusCode).toBe(403);   // carries leave.team.read, which IT lacks
    expect((await it_.patch(`/api/v1/tenant/roles/${r.json().key}`, { permissions: ['assets.manage', 'payroll.read'] })).statusCode).toBe(403);
    const view = await roles(it_);
    expect(view.canManage).toBe(true);
    expect(view.maxPermissions).toContain('assets.manage');
    expect(view.maxPermissions).not.toContain('payroll.read');
    expect((await roles(admin)).maxPermissions).toBeNull();
  });

  it('a role in use cannot be deleted', async () => {
    const r = await admin.del(`/api/v1/tenant/roles/${key}`);
    expect(r.statusCode).toBe(409);
    expect(problem(r).detail).toMatch(/1 person has this role/);
    await admin.patch(`/api/v1/tenant/users/${T.users.other!.id}`, { roles: ['employee'] });
    expect((await admin.del(`/api/v1/tenant/roles/${key}`)).statusCode).toBe(200);
    expect((await roles(admin)).custom.some((x: { key: string }) => x.key === key)).toBe(false);
    const log = (await admin.get('/api/v1/tenant/audit?action=role.')).json().items.map((x: { action: string }) => x.action);
    expect(log).toEqual(expect.arrayContaining(['role.created', 'role.updated', 'role.deleted']));
  });
});
