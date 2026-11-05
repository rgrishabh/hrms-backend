import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PASSWORD } from '../helpers.js';
import { base32Decode, hotp } from '../../src/core/auth/totp.js';
import { createTenant, ownerQuery, send, serve, WireClient } from './wire.js';

const totp = (secret: string, now: number) => hotp(base32Decode(secret), Math.floor(now / 30000));
let app: FastifyInstance;
let port: number;
beforeAll(async () => {
  ({ app, port } = await serve({ MFA_AVAILABLE: 'true', MFA_METHODS: 'totp', AUTH_RATE_LIMIT_PER_MINUTE: '10000', AUTH_ACCOUNT_RATE_LIMIT_PER_MINUTE: '10000' }));
}, 60000);
afterAll(async () => {
  await app.close();
});
const login = (host: string, email: string, password: string, headers: Record<string, string> = {}) => {
  const body = JSON.stringify({ email, password });
  return send(port, 'POST', '/api/v1/auth/login', { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers }, body);
};

describe('password guessing', () => {
  it('five wrong answers, then 429 with Retry-After, also for the right password', async () => {
    const T = await createTenant();
    const email = T.users.employee!.email;
    for (let i = 0; i < 5; i++) expect((await login(T.host, email, `wrong-${i}`)).statusCode).toBe(401);
    const blocked = await login(T.host, email, PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it.each([
    ['capitals', (e: string) => e.toUpperCase()],
    ['spaces', (e: string) => ` ${e} `],
  ])('spelling the address with %s counts on the same back-off', async (_n, spell) => {
    const T = await createTenant();
    const email = T.users.employee!.email;
    for (let i = 0; i < 3; i++) await login(T.host, email, `wrong-${i}`);
    for (let i = 3; i < 5; i++) await login(T.host, spell(email), `wrong-${i}`);
    expect((await login(T.host, email, PASSWORD)).statusCode).toBe(429);
  });

  it('a forged X-Forwarded-For is not a new address (TRUST_PROXY off)', async () => {
    const T = await createTenant();
    const email = T.users.employee!.email;
    for (let i = 0; i < 5; i++) await login(T.host, email, `wrong-${i}`, { 'x-forwarded-for': `10.9.8.${i}` });
    expect((await login(T.host, email, PASSWORD, { 'x-forwarded-for': '10.9.8.77' })).statusCode).toBe(429);
  });

  it('an unknown address and a known one answer alike', async () => {
    const T = await createTenant();
    const known = await login(T.host, T.users.other!.email, 'wrong-password');
    const unknown = await login(T.host, `nobody@${T.host}`, 'wrong-password');
    expect(unknown.statusCode).toBe(known.statusCode);
    const strip = (s: string) => s.replace(/urn:uuid:[0-9a-f-]+/g, '');
    expect(strip(unknown.body)).toBe(strip(known.body));
  });

  it('spraying one password over many accounts hits the limit per address', async () => {
    const T = await createTenant();
    let blocked = 0;
    for (let i = 0; i < 55; i++) if ((await login(T.host, `sprayed${i}@${T.host}`, 'Spring2026!')).statusCode === 429) blocked++;
    expect(blocked).toBeGreaterThan(0);
  });
});

describe('second factor guessing', () => {
  it('five wrong codes end the session; ten across sessions stop even the right code', async () => {
    const T = await createTenant();
    const email = T.users.employee!.email;
    const c = await WireClient.signIn(app, T.host, email);
    const setup = (await c.post('/api/v1/auth/mfa/setup')).json();
    const r = await c.post('/api/v1/auth/mfa/enable', { code: totp(setup.secret, Date.now()) });
    expect(r.statusCode, r.body).toBe(200);
    let s = await WireClient.signIn(app, T.host, email);
    const wrong = (cl: WireClient) => cl.post('/api/v1/auth/mfa/verify', { code: '000000' });
    expect((await s.get('/api/v1/leave/balances')).statusCode).toBe(403);
    for (let i = 0; i < 5; i++) await wrong(s);
    expect((await s.get('/api/v1/auth/me')).statusCode).toBe(401);
    s = await WireClient.signIn(app, T.host, email);
    for (let i = 0; i < 5; i++) await wrong(s);
    s = await WireClient.signIn(app, T.host, email);
    const locked = await s.post('/api/v1/auth/mfa/verify', { code: totp(setup.secret, Date.now()) });
    expect(locked.statusCode).toBe(429);
    await ownerQuery(`UPDATE users SET mfa_locked_until=NULL, mfa_failures=0 WHERE id=$1`, [T.users.employee!.id]);
  });
});

describe('real limits, on their defaults', () => {
  it('the per-address limit answers 429 and the global one exists', async () => {
    const limited = await serve({ AUTH_RATE_LIMIT_PER_MINUTE: '3', RATE_LIMIT_PER_MINUTE: '60' });
    const T = await createTenant();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const body = JSON.stringify({ email: 'a@x.test', password: 'x' });
      codes.push((await send(limited.port, 'POST', '/api/v1/auth/login', { host: T.host, 'content-type': 'application/json', 'content-length': body.length }, body)).statusCode);
    }
    expect(codes.at(-1)).toBe(429);
    let last = 0;
    for (let i = 0; i < 65; i++) last = (await send(limited.port, 'GET', '/api/v1/config/public', { host: T.host })).statusCode;
    expect(last).toBe(429);
    await limited.app.close();
  });
  it('exports are limited per user, across addresses', async () => {
    const limited = await serve({ EXPORT_RATE_LIMIT_PER_MINUTE: '2' });
    const T = await createTenant();
    const hr = await WireClient.signIn(limited.app, T.host, T.users.hr!.email);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await hr.get('/api/v1/reports/headcount/export.csv')).statusCode);
    expect(codes).toEqual([200, 200, 429, 429]);
    await limited.app.close();
  });
  it('password reset requests are limited per address, whatever the account', async () => {
    const T = await createTenant();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      const body = JSON.stringify({ email: `x${i}@${T.host}` });
      codes.push((await send(port, 'POST', '/api/v1/auth/password/forgot', { host: T.host, 'content-type': 'application/json', 'content-length': body.length }, body)).statusCode);
    }
    expect(codes).toContain(429);
  });
});
