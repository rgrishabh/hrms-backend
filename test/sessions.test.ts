import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { problem, Client, createTenant, makeApp, ownerQuery, PASSWORD, type TenantFixture } from './helpers.js';

let app: FastifyInstance; let T: TenantFixture;
beforeAll(async () => { app = await makeApp(); T = await createTenant(); });
afterAll(async () => { await app.close(); });
const NEW_PASSWORD = 'marble kettle orbit lantern';

describe('session cookie', () => {
  it('is HttpOnly and SameSite, with the deployment Secure flag, and the browser cookie the same', async () => {
    const secure = await makeApp({ COOKIE_SECURE: 'true' });
    try {
      const r = await new Client(secure, T.host).post('/api/v1/auth/login', { email: T.users.other!.email, password: PASSWORD });
      const [sid, did] = [r.headers['set-cookie']].flat() as string[];
      for (const c of [sid!, did!]) expect(c).toMatch(/HttpOnly/);
      for (const c of [sid!, did!]) expect(c).toMatch(/SameSite=Lax/);
      for (const c of [sid!, did!]) expect(c).toMatch(/Secure/);
      expect(sid!.startsWith('hrms_sid=')).toBe(true);
      expect(did!.startsWith('hrms_did=')).toBe(true);
    } finally { await secure.close(); }
  });

  it('unsafe requests need the CSRF token', async () => {
    const c = await Client.login(app, T.host, T.users.other!.email);
    const csrf = c.csrf; c.csrf = '';
    expect(problem((await c.post('/api/v1/auth/logout'))).code).toBe('csrf_failed');
    c.csrf = 'a'.repeat(64);
    expect(problem((await c.post('/api/v1/auth/logout'))).code).toBe('csrf_failed');
    c.csrf = csrf;
    expect((await c.post('/api/v1/auth/logout')).statusCode).toBe(200);
  });
});

describe('a session in the cookie does not stand in the way of signing in or of a link', () => {
  it('a session waiting for its code, with no CSRF token, can still sign in again or ask for a reset', async () => {
    const a = await makeApp({ MFA_AVAILABLE: 'true', MFA_METHODS: 'totp' });
    try {
      const X = await createTenant(); const email = X.users.employee!.email;
      await ownerQuery(`UPDATE users SET mfa_enabled_at=now(), mfa_method='totp', mfa_secret_enc='x' WHERE id=$1`, [X.users.employee!.id]);
      const c = await Client.login(a, X.host, email);
      expect(problem((await c.get('/api/v1/employees'))).code).toBe('mfa_required');
      c.csrf = '';
      expect((await c.post('/api/v1/auth/password/forgot', { email })).statusCode).toBe(200);
      const old = c.cookie;
      expect((await c.post('/api/v1/auth/login', { email, password: PASSWORD })).statusCode).toBe(200);
      expect(c.cookie).not.toBe(old);
      // Everything else still needs the code and the token.
      expect(problem((await c.get('/api/v1/employees'))).code).toBe('mfa_required');
      c.csrf = '';
      expect(problem((await c.post('/api/v1/auth/logout'))).code).toBe('csrf_failed');
    } finally { await a.close(); }
  });
});

describe('idle and absolute limits', () => {
  it('an idle session ends, activity keeps it going, and the limit comes from the setting', async () => {
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    expect((await admin.put('/api/v1/tenant/settings/security.session_idle_minutes', { value: 20 })).statusCode).toBe(200);
    const c = await Client.login(app, T.host, T.users.manager!.email);
    const [row] = await ownerQuery<{ id: string; idle_timeout_minutes: number }>(`SELECT id, idle_timeout_minutes FROM sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [T.users.manager!.id]);
    expect(row!.idle_timeout_minutes).toBe(20);
    await ownerQuery(`UPDATE sessions SET last_seen_at=now() - interval '19 minutes' WHERE id=$1`, [row!.id]);
    expect((await c.get('/api/v1/auth/me')).statusCode).toBe(200);
    const [touched] = await ownerQuery<{ fresh: boolean }>(`SELECT last_seen_at > now() - interval '1 minute' AS fresh FROM sessions WHERE id=$1`, [row!.id]);
    expect(touched!.fresh).toBe(true);
    await ownerQuery(`UPDATE sessions SET last_seen_at=now() - interval '21 minutes' WHERE id=$1`, [row!.id]);
    expect((await c.get('/api/v1/auth/me')).statusCode).toBe(401);
    await admin.del('/api/v1/tenant/settings/security.session_idle_minutes');
  });

  it('activity does not move the absolute limit', async () => {
    const c = await Client.login(app, T.host, T.users.manager!.email);
    const [row] = await ownerQuery<{ id: string; expires_at: Date }>(`SELECT id, expires_at FROM sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [T.users.manager!.id]);
    await c.get('/api/v1/auth/me');
    const [after] = await ownerQuery<{ expires_at: Date }>(`SELECT expires_at FROM sessions WHERE id=$1`, [row!.id]);
    expect(after!.expires_at.getTime()).toBe(row!.expires_at.getTime());
    await ownerQuery(`UPDATE sessions SET expires_at=now() - interval '1 second' WHERE id=$1`, [row!.id]);
    expect((await c.get('/api/v1/auth/me')).statusCode).toBe(401);
  });
});

describe('list, revoke one, log out everywhere', () => {
  it('lists this user\'s sessions and marks the current one, with no token in sight', async () => {
    const a = await Client.login(app, T.host, T.users.hr!.email);
    await Client.login(app, T.host, T.users.hr!.email);
    const r = await a.req('GET', '/api/v1/auth/sessions');
    const items = r.json().items as { id: string; current: boolean; ip: string }[];
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.filter((x) => x.current)).toHaveLength(1);
    expect(r.body).not.toContain('token_hash');
    expect(r.body).not.toContain('csrf_hash');
  });

  it('revokes one of your own; someone else\'s is 404 and stays alive', async () => {
    const mine = await Client.login(app, T.host, T.users.hr!.email);
    const second = await Client.login(app, T.host, T.users.hr!.email);
    const other = await Client.login(app, T.host, T.users.employee!.email);
    const secondId = (await second.get('/api/v1/auth/sessions')).json().items.find((x: { current: boolean }) => x.current).id as string;
    const otherId = (await other.get('/api/v1/auth/sessions')).json().items.find((x: { current: boolean }) => x.current).id as string;
    expect((await mine.del(`/api/v1/auth/sessions/${otherId}`)).statusCode).toBe(404);
    expect((await other.get('/api/v1/auth/me')).statusCode).toBe(200);
    expect((await mine.del(`/api/v1/auth/sessions/${secondId}`)).statusCode).toBe(200);
    expect((await second.get('/api/v1/auth/me')).statusCode).toBe(401);
    expect((await mine.get('/api/v1/auth/me')).statusCode).toBe(200);
    expect((await mine.del(`/api/v1/auth/sessions/${secondId}`)).statusCode).toBe(404); // already gone
  });

  it('log out everywhere ends them all, this one too', async () => {
    const a = await Client.login(app, T.host, T.users.payroll!.email);
    const b = await Client.login(app, T.host, T.users.payroll!.email);
    expect((await a.post('/api/v1/auth/sessions/revoke-all')).statusCode).toBe(200);
    expect((await a.get('/api/v1/auth/me')).statusCode).toBe(401);
    expect((await b.get('/api/v1/auth/me')).statusCode).toBe(401);
  });
});

describe('rotation', () => {
  it('signing in gives a new token and ends the session the browser came with', async () => {
    const c = await Client.login(app, T.host, T.users.it!.email);
    const before = c.cookie;
    const old = new Client(app, T.host); old.cookie = before;
    const r = await c.post('/api/v1/auth/login', { email: T.users.it!.email, password: PASSWORD });
    expect(r.statusCode).toBe(200);
    expect(c.cookie).not.toBe(before);
    expect((await old.get('/api/v1/auth/me')).statusCode).toBe(401);
    expect((await c.get('/api/v1/auth/me')).statusCode).toBe(200);
  });

  it('a password change rotates this session, with a new CSRF token, and ends the others', async () => {
    const X = await createTenant();
    const a = await Client.login(app, X.host, X.users.employee!.email);
    const b = await Client.login(app, X.host, X.users.employee!.email);
    const [cookie, csrf] = [a.cookie, a.csrf];
    const r = await a.post('/api/v1/auth/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(r.statusCode, r.body).toBe(200);
    expect(a.cookie).not.toBe(cookie);
    expect(a.csrf).not.toBe(csrf);
    expect((await a.get('/api/v1/auth/me')).statusCode).toBe(200);
    expect((await b.get('/api/v1/auth/me')).statusCode).toBe(401);
    const stale = new Client(app, X.host); stale.cookie = cookie;
    expect((await stale.get('/api/v1/auth/me')).statusCode).toBe(401);
    expect((await a.post('/api/v1/auth/logout')).statusCode).toBe(200); // the new CSRF token works
  });

  it('a role or salary level change ends the sessions of that person', async () => {
    const X = await createTenant();
    const emp = await Client.login(app, X.host, X.users.employee!.email);
    const admin = await Client.login(app, X.host, X.users.admin!.email);
    expect((await admin.patch(`/api/v1/tenant/users/${X.users.employee!.id}`, { roles: ['employee', 'reporting_manager'] })).statusCode).toBe(200);
    expect((await emp.get('/api/v1/auth/me')).statusCode).toBe(401);
    const again = await Client.login(app, X.host, X.users.employee!.email);
    expect((await admin.put(`/api/v1/tenant/users/${X.users.employee!.id}/salary-level`, { level: 5 })).statusCode).toBe(200);
    expect((await again.get('/api/v1/auth/me')).statusCode).toBe(401);
  });
});

describe('lockout cannot be turned on a known email', () => {
  const attempt = (a: FastifyInstance, host: string, email: string, ip: string, password = 'wrong-guess-here', cookie?: string) =>
    a.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password }, headers: { host, 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}) } });
  const repeat = async (n: number, fn: (i: number) => Promise<{ statusCode: number }>) => { const out: number[] = []; for (let i = 0; i < n; i++) out.push((await fn(i)).statusCode); return out; };

  let px: FastifyInstance;
  beforeAll(async () => { px = await makeApp({ TRUST_PROXY: '1' }); });
  afterAll(async () => { await px.close(); });

  it('brute force from one address: that address backs off, and the owner elsewhere signs in', async () => {
    const X = await createTenant(); const email = X.users.employee!.email;
    const codes = await repeat(8, () => attempt(px, X.host, email, '203.0.113.5'));
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429, 429]);
    // The right password from the attacker's address waits too: the guess cannot be confirmed.
    const right = await attempt(px, X.host, email, '203.0.113.5', PASSWORD);
    expect(right.statusCode).toBe(429);
    expect(Number(right.headers['retry-after'])).toBeGreaterThan(0);
    expect((await attempt(px, X.host, email, '198.51.100.7', PASSWORD)).statusCode).toBe(200);
  });

  it('a blocked attempt runs no password work', async () => {
    const X = await createTenant(); const email = X.users.other!.email;
    await repeat(5, () => attempt(px, X.host, email, '203.0.113.6'));
    const t = performance.now();
    expect((await attempt(px, X.host, email, '203.0.113.6')).statusCode).toBe(429);
    expect(performance.now() - t).toBeLessThan(60);
  });

  it('a block says nothing about whether the account exists', async () => {
    const X = await createTenant();
    const real = await repeat(6, () => attempt(px, X.host, X.users.manager!.email, '203.0.113.7'));
    const fake = await repeat(6, () => attempt(px, X.host, `nobody@${X.host}`, '203.0.113.8'));
    expect(real).toEqual(fake);
  });

  it('back-off doubles and is capped; the wait has an end', async () => {
    const X = await createTenant(); const email = X.users.hr!.email;
    await repeat(5, () => attempt(px, X.host, email, '203.0.113.9'));
    const [a] = await ownerQuery<{ s: number }>(`SELECT extract(epoch FROM blocked_until - now())::int AS s FROM auth_throttle WHERE tenant_id=$1 AND failures=5 AND blocked_until IS NOT NULL`, [X.id]);
    expect(a!.s).toBeLessThanOrEqual(30);
    await ownerQuery(`UPDATE auth_throttle SET blocked_until=now() - interval '1 second', failures=13 WHERE tenant_id=$1 AND blocked_until IS NOT NULL`, [X.id]);
    expect((await attempt(px, X.host, email, '203.0.113.9')).statusCode).toBe(401);
    const [b] = await ownerQuery<{ s: number }>(`SELECT extract(epoch FROM blocked_until - now())::int AS s FROM auth_throttle WHERE tenant_id=$1 AND failures=14`, [X.id]);
    expect(b!.s).toBeGreaterThan(60);
    expect(b!.s).toBeLessThanOrEqual(900);
  });

  it('credential stuffing: one address across many accounts backs off', async () => {
    const X = await createTenant();
    const codes = await repeat(52, (i) => attempt(px, X.host, `person${i}@${X.host}`, '203.0.113.10'));
    expect(codes.slice(0, 50).every((c) => c === 401)).toBe(true);
    expect(codes[51]).toBe(429);
    expect((await attempt(px, X.host, X.users.employee!.email, '198.51.100.8', PASSWORD)).statusCode).toBe(200);
  });

  it('guesses from many addresses stop a new browser, and not one the account already knows', async () => {
    const X = await createTenant(); const email = X.users.employee!.email;
    const first = await attempt(px, X.host, email, '198.51.100.20', PASSWORD);
    const device = ([first.headers['set-cookie']].flat() as string[]).find((c) => c.startsWith('hrms_did='))!.split(';')[0]!;
    await repeat(31, (i) => attempt(px, X.host, email, `192.0.2.${i + 1}`));
    expect((await attempt(px, X.host, email, '198.51.100.21', PASSWORD)).statusCode).toBe(429);
    expect((await attempt(px, X.host, email, '198.51.100.21', PASSWORD, device)).statusCode).toBe(200);
    // Another account's browser cookie does not help.
    const other = await attempt(px, X.host, X.users.other!.email, '198.51.100.22', PASSWORD);
    const foreign = ([other.headers['set-cookie']].flat() as string[]).find((c) => c.startsWith('hrms_did='))!.split(';')[0]!;
    expect((await attempt(px, X.host, email, '198.51.100.23', PASSWORD, foreign)).statusCode).toBe(429);
  });

  it('flooding a known email from one address does not spend the per-account limit', async () => {
    const a = await makeApp({ TRUST_PROXY: '1', AUTH_ACCOUNT_RATE_LIMIT_PER_MINUTE: '10' });
    try {
      const X = await createTenant(); const email = X.users.employee!.email;
      await repeat(40, () => attempt(a, X.host, email, '203.0.113.11'));
      expect((await attempt(a, X.host, email, '198.51.100.30', PASSWORD)).statusCode).toBe(200);
    } finally { await a.close(); }
  });

  it('an administrator can clear a block, and the account shows as blocked until then', async () => {
    const X = await createTenant(); const email = X.users.it!.email;
    await repeat(5, () => attempt(px, X.host, email, '203.0.113.12'));
    const admin = await Client.login(app, X.host, X.users.admin!.email);
    const row = async () => (await admin.get('/api/v1/tenant/users?pageSize=50')).json().items.find((u: { id: string }) => u.id === X.users.it!.id) as { locked: boolean };
    expect((await row()).locked).toBe(true);
    expect((await admin.patch(`/api/v1/tenant/users/${X.users.it!.id}`, { unlock: true })).statusCode).toBe(200);
    expect((await row()).locked).toBe(false);
    expect((await attempt(px, X.host, email, '203.0.113.12', PASSWORD)).statusCode).toBe(200);
  });

  it('the login does not hold a row or a connection during the hash: concurrent attempts on one account finish together', async () => {
    const X = await createTenant(); const email = X.users.manager!.email;
    const t = performance.now();
    const r = await Promise.all(Array.from({ length: 12 }, (_, i) => attempt(px, X.host, email, `198.51.100.${40 + i}`)));
    expect(r.every((x) => x.statusCode === 401)).toBe(true);
    expect(performance.now() - t).toBeLessThan(5000);
  }, 15000);
});
