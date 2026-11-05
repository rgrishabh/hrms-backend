import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
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
