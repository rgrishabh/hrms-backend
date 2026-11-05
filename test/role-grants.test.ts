import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, createTenant, makeApp, ownerQuery, type TenantFixture } from './helpers.js';

/** "No one can set someone else's level equal to or above their own." A role grant is one way of setting a level (D40). */
let app: FastifyInstance;
let T: TenantFixture;
let owner: Client;
let admin: Client;
let itAdmin: Client;
const uid = (k: string) => T.users[k]!.id;

beforeAll(async () => {
  app = await makeApp();
  T = await createTenant();
  const [u] = await ownerQuery<{ id: string }>(
    `INSERT INTO users (tenant_id, email, display_name, password_hash) SELECT tenant_id, $2, 'Owner', password_hash FROM users WHERE id=$1 RETURNING id`,
    [uid('admin'), `owner@${T.host}`],
  );
  await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'owner')`, [u!.id, T.id]);
  T.users.owner = { id: u!.id, email: `owner@${T.host}` };
  owner = await Client.login(app, T.host, `owner@${T.host}`);
  admin = await Client.login(app, T.host, T.users.admin!.email);
  itAdmin = await Client.login(app, T.host, T.users.it!.email);
});
afterAll(async () => {
  await app.close();
});

describe('role grants against the salary hierarchy', () => {
  it('an administrator cannot appoint a peer administrator', async () => {
    const r = await admin.patch(`/api/v1/tenant/users/${uid('other')}`, { roles: ['tenant_admin', 'employee'] });
    expect(r.statusCode, r.body).toBe(403);
    expect(await ownerQuery(`SELECT 1 FROM user_roles WHERE user_id=$1 AND role_key='tenant_admin'`, [uid('other')])).toHaveLength(0);
  });

  it('a new account cannot be created at or above the creator', async () => {
    expect((await admin.post('/api/v1/tenant/users', { email: `peer@${T.host}`, displayName: 'Peer', roles: ['tenant_admin'] })).statusCode).toBe(403);
    expect((await itAdmin.post('/api/v1/tenant/users', { email: `itpeer@${T.host}`, displayName: 'Peer', roles: ['it_admin'] })).statusCode).toBe(403);
  });

  it('nobody appoints an equal: an owner cannot appoint another owner in the app', async () => {
    expect((await owner.patch(`/api/v1/tenant/users/${uid('other')}`, { roles: ['owner', 'employee'] })).statusCode).toBe(403);
  });

  it('someone strictly above can appoint an administrator', async () => {
    const r = await owner.patch(`/api/v1/tenant/users/${uid('other')}`, { roles: ['tenant_admin', 'employee'] });
    expect(r.statusCode, r.body).toBe(200);
    await owner.patch(`/api/v1/tenant/users/${uid('other')}`, { roles: ['employee'] });
  });

  it('the effective level counts, not just the floor: a removal that lifts a ceiling over a high stored level is a raise', async () => {
    await ownerQuery(`INSERT INTO tenant_roles (tenant_id, key, name, permissions) VALUES ($1,'custom:clerk','Clerk','{}')`, [T.id]);
    await ownerQuery(`UPDATE user_roles SET role_key='custom:clerk' WHERE user_id=$1`, [uid('other')]);
    await ownerQuery(`UPDATE users SET salary_access_level=85 WHERE id=$1`, [uid('other')]);
    try {
      // A custom role caps at 59, under IT's 60. Dropping it leaves the default ceiling of 89, so the stored 85 takes effect.
      const r = await itAdmin.patch(`/api/v1/tenant/users/${uid('other')}`, { roles: ['employee'] });
      expect(r.statusCode, r.body).toBe(403);
      expect((await owner.patch(`/api/v1/tenant/users/${uid('other')}`, { roles: ['employee'] })).statusCode).toBe(200);
    } finally {
      await ownerQuery(`UPDATE users SET salary_access_level=0 WHERE id=$1`, [uid('other')]);
    }
  });

  it('nobody raises their own level through a role', async () => {
    expect((await admin.patch(`/api/v1/tenant/users/${uid('admin')}`, { roles: ['owner', 'tenant_admin', 'employee'] })).statusCode).toBe(403);
    expect((await itAdmin.patch(`/api/v1/tenant/users/${uid('it')}`, { roles: ['it_admin', 'tenant_admin'] })).statusCode).toBe(403);
  });

  it('nobody changes the roles or status of someone at or above them', async () => {
    const peer = await createTenant();
    const [p] = await ownerQuery<{ id: string }>(
      `INSERT INTO users (tenant_id, email, display_name, password_hash) SELECT tenant_id, $2, 'Second', password_hash FROM users WHERE id=$1 RETURNING id`,
      [peer.users.admin!.id, `second@${peer.host}`],
    );
    await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'tenant_admin')`, [p!.id, peer.id]);
    const a = await Client.login(app, peer.host, peer.users.admin!.email);
    for (const body of [{ status: 'disabled' }, { roles: ['employee'] }, { resetMfa: true }]) {
      expect((await a.patch(`/api/v1/tenant/users/${p!.id}`, body)).statusCode, JSON.stringify(body)).toBe(403);
    }
    expect((await admin.patch(`/api/v1/tenant/users/${uid('owner')}`, { status: 'disabled' })).statusCode).toBe(403);
    expect((await admin.patch(`/api/v1/tenant/users/${uid('owner')}`, { roles: ['employee'] })).statusCode).toBe(403);
  });
});

describe('nobody is locked out', () => {
  it('the last owner cannot be removed, and an owner can step down only with another in place', async () => {
    const r = await owner.patch(`/api/v1/tenant/users/${uid('owner')}`, { roles: ['employee'] });
    expect(r.statusCode).toBe(409);
    expect((await owner.patch(`/api/v1/tenant/users/${uid('owner')}`, { status: 'disabled' })).statusCode).toBe(409);
    expect(await ownerQuery(`SELECT 1 FROM user_roles WHERE user_id=$1 AND role_key='owner'`, [uid('owner')])).toHaveLength(1);
  });

  it('with only administrators in a legacy installation, the last of them stays', async () => {
    const X = await createTenant();
    const a = await Client.login(app, X.host, X.users.admin!.email);
    expect((await a.patch(`/api/v1/tenant/users/${X.users.admin!.id}`, { roles: ['employee'] })).statusCode).toBe(409);
  });

  it('ending the access of the last owner keeps the installation reachable', async () => {
    const X = await createTenant();
    const [u] = await ownerQuery<{ id: string }>(
      `INSERT INTO users (tenant_id, email, display_name, password_hash) SELECT tenant_id, $2, 'Owner', password_hash FROM users WHERE id=$1 RETURNING id`,
      [X.users.admin!.id, `owner@${X.host}`],
    );
    await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'owner')`, [u!.id, X.id]);
    await ownerQuery(`UPDATE employees SET user_id=$1 WHERE tenant_id=$2 AND id=$3`, [u!.id, X.id, X.users.other!.employeeId]);
    const { endAccess } = await import('../src/modules/lifecycle/service.js');
    const { withTenant } = await import('../src/db/tx.js');
    expect(await withTenant(app.deps.pool, X.id, (db) => endAccess(db, X.id, X.users.other!.employeeId!))).toBe(false);
    const [row] = await ownerQuery<{ status: string }>(`SELECT status FROM users WHERE id=$1`, [u!.id]);
    expect(row!.status).toBe('active');
    expect(await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='user.end_access_refused_last_owner'`, [X.id])).toHaveLength(1);
  });
});
