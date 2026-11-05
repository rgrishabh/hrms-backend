import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../../src/config/env.js';
import { TEST_BRAND } from '../env.js';
import { createTenant, person, serve, WireClient, type TenantFixture } from './wire.js';

/** An office is one address. Found by the load test: 12 punches a minute per address stopped everyone after the twelfth person in, on a working morning. */
describe('people behind one address', () => {
  let app: FastifyInstance;
  let T: TenantFixture;
  const staff: WireClient[] = [];
  beforeAll(async () => {
    ({ app } = await serve({ RATE_LIMIT_PER_MINUTE: '60' }));
    T = await createTenant();
    for (let i = 0; i < 15; i++) {
      const p = await person(T, `staff${i}`, ['employee']);
      staff.push(await WireClient.signIn(app, T.host, p.email));
    }
  }, 60000);
  afterAll(async () => {
    await app.close();
  });

  it('F-127 fifteen people can clock in within a minute', async () => {
    const codes = [];
    for (const [i, c] of staff.entries()) codes.push((await c.post('/api/v1/attendance/punch', { channel: 'web', idempotencyKey: `morning-${i}` })).statusCode);
    expect(
      codes.every((x) => x === 200),
      codes.join(),
    ).toBe(true);
  });

  it('F-127 one person is still limited to twelve', async () => {
    const codes = [];
    for (let i = 0; i < 14; i++) codes.push((await staff[0]!.post('/api/v1/attendance/punch', { channel: 'web', idempotencyKey: `one-${i}` })).statusCode);
    expect(codes).toContain(429);
    expect((await staff[1]!.post('/api/v1/attendance/punch', { channel: 'web', idempotencyKey: 'other-1' })).statusCode).not.toBe(429);
  });

  it('F-128 the general limit counts each person, not the office', async () => {
    const codes = [];
    for (let i = 0; i < 40; i++) for (const c of staff.slice(2, 4)) codes.push((await c.get('/api/v1/notifications/unread-count')).statusCode);
    expect(codes.every((x) => x === 200)).toBe(true);
    let last = 0;
    for (let i = 0; i < 65; i++) last = (await staff[5]!.get('/api/v1/notifications/unread-count')).statusCode;
    expect(last).toBe(429);
  });

  it('a hundred people sign in within a minute from one address, on the default limits', async () => {
    const office = await serve({ AUTH_RATE_LIMIT_PER_MINUTE: '', AUTH_ACCOUNT_RATE_LIMIT_PER_MINUTE: '' });
    const O = await createTenant();
    const people = [];
    for (let i = 0; i < 100; i++) people.push(await person(O, `nine${i}`, ['employee']));
    const started = Date.now();
    const signedIn = [];
    for (const p of people) signedIn.push(await WireClient.signIn(office.app, O.host, p.email));
    expect(signedIn).toHaveLength(100);
    // A minute would reset the budget and prove nothing.
    expect(Date.now() - started).toBeLessThan(60000);
    await office.app.close();
  }, 120000);

  it('the default limit still stops a guesser: fifty wrong passwords from one address, then back-off', async () => {
    const office = await serve({ AUTH_RATE_LIMIT_PER_MINUTE: '', AUTH_ACCOUNT_RATE_LIMIT_PER_MINUTE: '' });
    const O = await createTenant();
    const c = new WireClient(office.app, O.host);
    const codes = [];
    for (let i = 0; i < 53; i++) codes.push((await c.post('/api/v1/auth/login', { email: `spray${i}@${O.host}`, password: 'Winter-Password-1' })).statusCode);
    expect(codes.slice(0, 50).every((x) => x === 401)).toBe(true);
    expect(codes.slice(51).every((x) => x === 429)).toBe(true);
    await office.app.close();
  }, 120000);

  it('the default limit bounds the hashing a flood can ask for', () => {
    expect(
      loadEnv({ ...TEST_BRAND, DATABASE_URL: 'postgres://x@127.0.0.1/x', DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), COOKIE_SECURE: 'false' })
        .AUTH_RATE_LIMIT_PER_MINUTE,
    ).toBe(300);
  });

  it('a second factor behind one address: an office gets through, and one person is still limited', async () => {
    const office = await serve({ AUTH_RATE_LIMIT_PER_MINUTE: '', MFA_AVAILABLE: 'true', MFA_METHODS: 'totp' });
    const O = await createTenant();
    const codes = [];
    for (let i = 0; i < 15; i++) {
      const p = await person(O, `mfa${i}`, ['employee']);
      const c = await WireClient.signIn(office.app, O.host, p.email);
      codes.push((await c.post('/api/v1/auth/mfa/enable', { code: '000000' })).statusCode);
    }
    expect(codes).not.toContain(429);
    const one = await WireClient.signIn(office.app, O.host, O.users.employee!.email);
    const own = [];
    for (let i = 0; i < 12; i++) own.push((await one.post('/api/v1/auth/mfa/enable', { code: '000000' })).statusCode);
    expect(own).toContain(429);
    await office.app.close();
  }, 60000);

  it('sign-in stays limited by address: a valid session does not buy another budget', async () => {
    const limited = await serve({ AUTH_RATE_LIMIT_PER_MINUTE: '3' });
    const X = await createTenant();
    const c = await WireClient.signIn(limited.app, X.host, X.users.employee!.email);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await c.post('/api/v1/auth/login', { email: `someone${i}@${X.host}`, password: 'wrong-guess' })).statusCode);
    expect(codes).toContain(429);
    await limited.app.close();
  });
});
