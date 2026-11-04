import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, PASSWORD, type TenantFixture } from './helpers.js';

let app: FastifyInstance; let T: TenantFixture;
beforeAll(async () => { app = await makeApp({ AUTH_RATE_LIMIT_PER_MINUTE: '3' }); T = await createTenant(); });
afterAll(async () => { await app.close(); });

describe('login rate limiting', () => {
  it('returns 429 once the per-IP login limit is exceeded', async () => {
    const c = new Client(app, T.host);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await c.post('/api/v1/auth/login', { email: 'nobody@x.test', password: 'wrong' })).statusCode);
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes[4]).toBe(429);
  });
});

describe('F-15 proxy trust and per-account login limits', () => {
  const attempt = (a: FastifyInstance, host: string, email: string, xff: string, password = 'wrong') =>
    a.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password }, headers: { host, 'x-forwarded-for': xff } });

  it.each(['1', 'true'])('TRUST_PROXY=%s: a forged X-Forwarded-For prefix does not escape the per-IP limit', async (trust) => {
    const a = await makeApp({ TRUST_PROXY: trust, AUTH_RATE_LIMIT_PER_MINUTE: '3' });
    const t = await createTenant();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await attempt(a, t.host, 'nobody@x.test', `10.0.0.${i}, 203.0.113.9`)).statusCode);
    expect(codes[4]).toBe(429);
    await a.close();
  });

  it('the audit trail records the address the proxy saw, not the forged one', async () => {
    const a = await makeApp({ TRUST_PROXY: '1' });
    const t = await createTenant();
    await attempt(a, t.host, 'nobody@x.test', '6.6.6.6, 203.0.113.9');
    const [row] = await ownerQuery<{ ip: string }>(`SELECT ip::text FROM audit_logs WHERE tenant_id=$1 AND action='auth.login_failed'`, [t.id]);
    expect(row!.ip).toMatch(/^203\.0\.113\.9/);
    await a.close();
  });

  it('a list of proxy addresses is honoured; off ignores the header', async () => {
    const list = await makeApp({ TRUST_PROXY: '127.0.0.1/32' });
    let t = await createTenant();
    await attempt(list, t.host, 'nobody@x.test', '203.0.113.9');
    let [row] = await ownerQuery<{ ip: string }>(`SELECT ip::text FROM audit_logs WHERE tenant_id=$1 AND action='auth.login_failed'`, [t.id]);
    expect(row!.ip).toMatch(/^203\.0\.113\.9/);
    await list.close();
    const off = await makeApp({ TRUST_PROXY: 'false' });
    t = await createTenant();
    await attempt(off, t.host, 'nobody@x.test', '203.0.113.9');
    [row] = await ownerQuery<{ ip: string }>(`SELECT ip::text FROM audit_logs WHERE tenant_id=$1 AND action='auth.login_failed'`, [t.id]);
    expect(row!.ip).toMatch(/^127\.0\.0\.1/);
    await off.close();
  });

  it('attempts on one account are limited across addresses, without touching others', async () => {
    const a = await makeApp({ TRUST_PROXY: '1', AUTH_RATE_LIMIT_PER_MINUTE: '1000', AUTH_ACCOUNT_RATE_LIMIT_PER_MINUTE: '3' });
    const t = await createTenant();
    const email = t.users.employee!.email;
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await attempt(a, t.host, i % 2 ? email : email.toUpperCase(), `198.51.100.${i}`)).statusCode);
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes[3]).toBe(429);
    expect((await attempt(a, t.host, email, '198.51.100.99', PASSWORD)).statusCode).toBe(429);
    expect((await attempt(a, t.host, t.users.other!.email, '198.51.100.100', PASSWORD)).statusCode).toBe(200);
    const [{ locked }] = (await ownerQuery<{ locked: boolean }>(`SELECT locked_until IS NOT NULL AS locked FROM users WHERE id=$1`, [t.users.employee!.id])) as [{ locked: boolean }];
    expect(locked).toBe(false);
    await a.close();
  });
});
