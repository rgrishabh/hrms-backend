import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PASSWORD } from '../helpers.js';
import { createTenant, ownerQuery, send, serve, WireClient, type TenantFixture } from './wire.js';

/** Sessions are opaque tokens (D5), so there is no JWT to re-sign. These prove that nothing token-shaped is believed, and that a real token dies when it should. */
let app: FastifyInstance;
let port: number;
let T: TenantFixture;
beforeAll(async () => {
  ({ app, port } = await serve());
  T = await createTenant();
}, 60000);
afterAll(async () => {
  await app.close();
});
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const me = (cookie: string, host = T.host) => send(port, 'GET', '/api/v1/auth/me', { host, cookie: `hrms_sid=${cookie}` });
const token = (c: WireClient) => c.cookie.replace('hrms_sid=', '');

describe('forged and tampered tokens', () => {
  it.each([
    ['alg none JWT', () => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: T.users.admin!.id, tenant: T.id, roles: ['owner'] })}.`],
    [
      'HS256 JWT signed with an empty key',
      () => {
        const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: T.users.admin!.id })}`;
        return `${head}.${createHmac('sha256', '').update(head).digest('base64url')}`;
      },
    ],
    ['a user id', () => T.users.admin!.id],
    ['SQL', () => `' OR '1'='1`],
    ['empty', () => ''],
    ['very long', () => 'a'.repeat(4000)],
  ])('%s is not a session', async (_n, make) => {
    expect((await me(make())).statusCode).toBe(401);
  });

  it('a real token with one character changed is not a session', async () => {
    const c = await WireClient.signIn(app, T.host, T.users.employee!.email);
    const t = token(c);
    const flipped = (t[0] === 'a' ? 'b' : 'a') + t.slice(1);
    expect((await me(flipped)).statusCode).toBe(401);
    expect((await me(t)).statusCode).toBe(200);
  });

  it('the database holds a hash of the token, so a read of the table gives no session', async () => {
    const c = await WireClient.signIn(app, T.host, T.users.other!.email);
    const rows = await ownerQuery<{ token_hash: string }>(`SELECT token_hash FROM sessions WHERE user_id=$1 AND revoked_at IS NULL`, [T.users.other!.id]);
    expect(rows.map((r) => r.token_hash)).not.toContain(token(c));
    expect((await me(rows[0]!.token_hash)).statusCode).toBe(401);
  });
});

describe('replay', () => {
  it('after logout', async () => {
    const c = await WireClient.signIn(app, T.host, T.users.employee!.email);
    const t = token(c);
    expect((await c.post('/api/v1/auth/logout')).statusCode).toBe(200);
    expect((await me(t)).statusCode).toBe(401);
  });
  it('after a password change, for the other browser and for the old token of this one', async () => {
    const X = await createTenant();
    const a = await WireClient.signIn(app, X.host, X.users.employee!.email);
    const b = await WireClient.signIn(app, X.host, X.users.employee!.email);
    const [ta, tb] = [token(a), token(b)];
    const r = await a.post('/api/v1/auth/password', { currentPassword: PASSWORD, newPassword: 'Another-Long-Passphrase-77!' });
    expect(r.statusCode, r.body).toBe(200);
    expect((await me(ta, X.host)).statusCode).toBe(401);
    expect((await me(tb, X.host)).statusCode).toBe(401);
    expect((await me(token(a), X.host)).statusCode).toBe(200);
  });
  it('on another organization, even with the matching CSRF token', async () => {
    const X = await createTenant();
    const c = await WireClient.signIn(app, T.host, T.users.hr!.email);
    expect((await me(token(c), X.host)).statusCode).toBe(401);
    const r = await send(
      port,
      'POST',
      '/api/v1/auth/logout',
      { host: X.host, cookie: c.cookie, 'x-csrf-token': c.csrf, 'content-type': 'application/json', 'content-length': 2 },
      '{}',
    );
    expect(r.statusCode).toBeGreaterThanOrEqual(200);
    expect((await me(token(c))).statusCode).toBe(200); // the session on its own organization is untouched
  });
  it('once expired, idle or absolute', async () => {
    const X = await createTenant();
    const c = await WireClient.signIn(app, X.host, X.users.employee!.email);
    const t = token(c);
    await ownerQuery(`UPDATE sessions SET last_seen_at=now() - interval '1 day' WHERE user_id=$1`, [X.users.employee!.id]);
    expect((await me(t, X.host)).statusCode).toBe(401);
    const d = await WireClient.signIn(app, X.host, X.users.other!.email);
    await ownerQuery(`UPDATE sessions SET expires_at=now() - interval '1 second' WHERE user_id=$1`, [X.users.other!.id]);
    expect((await me(token(d), X.host)).statusCode).toBe(401);
  });
  it('a used reset link does not work twice, nor one for another organization', async () => {
    const X = await createTenant();
    const raw = 'r'.repeat(43);
    const { sha256 } = await import('../../src/core/crypto/index.js');
    await ownerQuery(`INSERT INTO admin_setup_tokens (tenant_id, user_id, token_hash, expires_at, purpose) VALUES ($1,$2,$3,now() + interval '30 minutes','reset')`, [
      X.id,
      X.users.other!.id,
      sha256(raw),
    ]);
    const anon = new WireClient(app, T.host);
    const body = { token: raw, newPassword: 'Zebra-Quartz-Lantern-Moss-8!' };
    expect((await anon.post('/api/v1/auth/password/reset', body)).statusCode).toBe(400);
    const here = new WireClient(app, X.host);
    const first = await here.post('/api/v1/auth/password/reset', body);
    expect(first.statusCode, first.body).toBe(200);
    expect((await here.post('/api/v1/auth/password/reset', body)).statusCode).toBe(400);
  });
});

describe('CSRF', () => {
  const unsafe = (c: WireClient, csrf: string | null, headers: Record<string, string> = {}) =>
    send(
      port,
      'POST',
      '/api/v1/notifications/read-all',
      { host: T.host, cookie: c.cookie, 'content-type': 'application/json', 'content-length': 2, ...(csrf ? { 'x-csrf-token': csrf } : {}), ...headers },
      '{}',
    );

  it('no token, a wrong one and one from another session are refused; the right one works', async () => {
    const c = await WireClient.signIn(app, T.host, T.users.employee!.email);
    const other = await WireClient.signIn(app, T.host, T.users.other!.email);
    expect((await unsafe(c, null)).statusCode).toBe(403);
    expect((await unsafe(c, 'x'.repeat(64))).statusCode).toBe(403);
    expect((await unsafe(c, other.csrf)).statusCode).toBe(403);
    expect((await unsafe(c, c.csrf)).statusCode).toBe(200);
  });

  it('every unsafe route of the document refuses a signed-in session with no token', async () => {
    const c = await WireClient.signIn(app, T.host, T.users.admin!.email);
    const exempt = new Set(['/api/v1/auth/login', '/api/v1/auth/password/forgot', '/api/v1/auth/password/reset', '/api/v1/auth/setup', '/api/v1/devices/events']);
    const wrong: string[] = [];
    for (const r of app.featureRoutes.filter((x) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(x.method) && x.url.startsWith('/api/') && !exempt.has(x.url))) {
      const url = r.url.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000').replace(/\/$/, '');
      const res = await send(port, r.method, url, { host: T.host, cookie: c.cookie, 'content-type': 'application/json', 'content-length': 2 }, '{}');
      if (res.statusCode !== 403 || res.json().code !== 'csrf_failed') wrong.push(`${r.method} ${r.url} ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);
  });

  it('a form cannot sign someone in or change anything: no JSON, no parse', async () => {
    const text = JSON.stringify({ email: T.users.employee!.email, password: PASSWORD });
    const r = await send(port, 'POST', '/api/v1/auth/login', { host: T.host, 'content-type': 'text/plain', 'content-length': text.length }, text);
    expect(r.statusCode).toBe(400);
    const form = `email=${encodeURIComponent(T.users.employee!.email)}&password=${encodeURIComponent(PASSWORD)}`;
    const f = await send(port, 'POST', '/api/v1/auth/login', { host: T.host, 'content-type': 'application/x-www-form-urlencoded', 'content-length': form.length }, form);
    expect(f.statusCode).toBe(415);
  });

  it('CORS answers only the configured origin, never with credentials to another', async () => {
    const pre = (origin: string) => send(port, 'OPTIONS', '/api/v1/auth/me', { host: T.host, origin, 'access-control-request-method': 'POST' });
    for (const evil of ['https://evil.test', 'https://localhost.evil.test', 'https://evil.test/localhost', 'null', 'http://localhost.', 'https://localhost@evil.test']) {
      const r = await pre(evil);
      expect(r.headers['access-control-allow-origin'], evil).toBeUndefined();
      expect(r.headers['access-control-allow-credentials'], evil).toBeUndefined();
    }
    expect((await pre('http://localhost')).headers['access-control-allow-origin']).toBe('http://localhost');
  });

  it('the session cookie is HttpOnly and SameSite=Lax; the MFA and password gates hold on the wire', async () => {
    const c = new WireClient(app, T.host);
    const r = await c.req('POST', '/api/v1/auth/login', { email: T.users.employee!.email, password: PASSWORD });
    const cookie = [r.headers['set-cookie'] ?? []].flat().find((x) => String(x).startsWith('hrms_sid='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const X = await createTenant();
    await ownerQuery(`UPDATE users SET must_change_password=true WHERE id=$1`, [X.users.other!.id]);
    const forced = await WireClient.signIn(app, X.host, X.users.other!.email);
    expect((await forced.get('/api/v1/leave/balances')).statusCode).toBe(403);
    // Encoded or padded spellings of an allowed path do not open anything else.
    expect((await forced.get('/api/v1/auth/me/../../leave/balances')).statusCode).toBe(403);
    expect((await forced.get('/api/v1/auth/%6De')).statusCode).toBe(403);
  });
});
