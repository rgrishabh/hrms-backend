import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture } from './helpers.js';
import { cached, invalidate } from '../src/core/cache/index.js';
import { withTenant } from '../src/db/tx.js';
import { resolveSetting, writeSetting } from '../src/core/settings/service.js';

/**
 * Against a real Redis, whose address comes from TEST_REDIS_URL. Skipped only when that is unset. The rest of the suite runs
 * with no Redis at all, which is the other half of "correct without it". Start one with:
 *   redis-server --port 56399 --save "" --appendonly no
 *   TEST_REDIS_URL=redis://127.0.0.1:56399 npx vitest run test/cache-redis.test.ts
 */
const REDIS = process.env.TEST_REDIS_URL;
const setting = async (c: Client, key: string) => (await c.get('/api/v1/tenant/settings')).json().items.find((s: { key: string }) => s.key === key);
const KEY = 'attendance.min_punch_gap_seconds';

describe.skipIf(!REDIS)('with Redis', () => {
  let a: FastifyInstance; let b: FastifyInstance; let T: TenantFixture; let adminA: Client; let adminB: Client; let raw: Redis;
  beforeAll(async () => {
    raw = new Redis(REDIS!);
    await raw.flushdb();
    a = await makeApp({ REDIS_URL: REDIS! });
    b = await makeApp({ REDIS_URL: REDIS! });
    T = await createTenant();
    adminA = await Client.login(a, T.host, T.users.admin!.email);
    adminB = await Client.login(b, T.host, T.users.admin!.email);
    await new Promise((r) => setTimeout(r, 200)); // both apps' clients have connected
  });
  afterAll(async () => { await a.close(); await b.close(); raw.disconnect(); });

  it('a setting is read from the cache after the first read', async () => {
    expect((await setting(adminA, KEY)).effective).toBe(60);
    expect((await raw.keys(`hrms:${T.id}:settings:*`)).length).toBeGreaterThan(0);
    // Behind the app's back: only a cache would keep answering the old value.
    await ownerQuery(`INSERT INTO tenant_settings (tenant_id, setting_key, scope_type, setting_value) VALUES ($1,$2,'tenant','90')`, [T.id, KEY]);
    expect((await setting(adminA, KEY)).effective).toBe(60);
    await ownerQuery(`DELETE FROM tenant_settings WHERE tenant_id=$1 AND setting_key=$2`, [T.id, KEY]);
  });

  it('a write through the app shows at once, on this instance and on another', async () => {
    expect((await setting(adminB, KEY)).effective).toBe(60);
    expect((await adminA.put(`/api/v1/tenant/settings/${KEY}`, { value: 120 })).statusCode).toBe(200);
    expect((await setting(adminA, KEY)).effective).toBe(120);
    expect((await setting(adminB, KEY)).effective).toBe(120);
    expect((await adminB.del(`/api/v1/tenant/settings/${KEY}`)).statusCode).toBe(200);
    expect((await setting(adminA, KEY)).effective).toBe(60);
    expect((await setting(adminB, KEY)).effective).toBe(60);
  });

  it('a transaction reads its own write; others do not until it commits, and a rollback changes nothing', async () => {
    const pool = a.deps.pool;
    await withTenant(pool, T.id, (db) => resolveSetting(db, T.id, KEY));
    await withTenant(pool, T.id, async (db) => {
      await writeSetting(db, T.id, { key: KEY, value: 200, scope: 'tenant' }, T.users.admin!.id);
      expect((await resolveSetting(db, T.id, KEY)).value).toBe(200);
      expect((await withTenant(pool, T.id, (other) => resolveSetting(other, T.id, KEY))).value).toBe(60);
    });
    expect((await withTenant(pool, T.id, (db) => resolveSetting(db, T.id, KEY))).value).toBe(200);

    await expect(withTenant(pool, T.id, async (db) => {
      await writeSetting(db, T.id, { key: KEY, value: 300, scope: 'tenant' }, T.users.admin!.id);
      throw new Error('rolled back');
    })).rejects.toThrow('rolled back');
    expect((await withTenant(pool, T.id, (db) => resolveSetting(db, T.id, KEY))).value).toBe(200);
    // The connection goes back to the pool clean: its next transaction uses the cache again.
    await withTenant(pool, T.id, (db) => db.query(`DELETE FROM tenant_settings WHERE tenant_id=$1 AND setting_key=$2`, [T.id, KEY]));
  });

  it('a reader that loaded before the commit cannot put the old value back', async () => {
    const pool = a.deps.pool;
    const seen = await withTenant(pool, T.id, async (db) => {
      const gate = cached(db, T.id, 'org', 'race', async () => {
        // The load is under way when another transaction commits a change.
        await withTenant(pool, T.id, async (w) => { invalidate(w, T.id, 'org'); });
        return 'old';
      });
      return gate;
    });
    expect(seen).toBe('old');
    const after = await withTenant(pool, T.id, (db) => cached(db, T.id, 'org', 'race', async () => 'new'));
    expect(after).toBe('new');
  });

  it('organization lookups are cached and follow writes', async () => {
    const before = (await adminA.get('/api/v1/org')).json();
    expect(before.departments.map((d: { code: string }) => d.code)).toEqual(['LAB']);
    expect((await raw.keys(`hrms:${T.id}:org:*`)).length).toBeGreaterThan(0);
    await ownerQuery(`INSERT INTO departments (tenant_id, code, name) VALUES ($1,'SNEAK','Sneaked in')`, [T.id]);
    expect((await adminA.get('/api/v1/org')).json().departments).toHaveLength(1);
    expect((await adminA.post('/api/v1/org/departments', { code: 'QA', name: 'Quality' })).statusCode).toBe(201);
    expect((await adminB.get('/api/v1/org')).json().departments.map((d: { code: string }) => d.code).sort()).toEqual(['LAB', 'QA', 'SNEAK']);
  });

  it('keys are per organization', async () => {
    const U = await createTenant();
    const other = await Client.login(a, U.host, U.users.admin!.email);
    await adminA.put(`/api/v1/tenant/settings/${KEY}`, { value: 150 });
    expect((await setting(adminA, KEY)).effective).toBe(150);
    expect((await setting(other, KEY)).effective).toBe(60);
  });
});

describe('with a Redis that is down', () => {
  it('every read and write still works, correctly, from the database', async () => {
    const app = await makeApp({ REDIS_URL: 'redis://127.0.0.1:9' });
    const T = await createTenant();
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    expect((await setting(admin, KEY)).effective).toBe(60);
    expect((await admin.put(`/api/v1/tenant/settings/${KEY}`, { value: 75 })).statusCode).toBe(200);
    expect((await setting(admin, KEY)).effective).toBe(75);
    await ownerQuery(`UPDATE tenant_settings SET setting_value='80' WHERE tenant_id=$1 AND setting_key=$2`, [T.id, KEY]);
    expect((await setting(admin, KEY)).effective).toBe(80); // no cache in the way
    expect((await admin.get('/api/v1/org')).json().departments).toHaveLength(1);
    await app.close();
  });
});

describe('REDIS_URL', () => {
  it('must be a Redis URL, and is optional', async () => {
    await expect(makeApp({ REDIS_URL: 'http://cache:6379' })).rejects.toThrow(/REDIS_URL/);
    const app = await makeApp({ REDIS_URL: '' });
    await app.close();
  });
});
