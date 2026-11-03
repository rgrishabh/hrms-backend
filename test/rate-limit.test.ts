import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, type TenantFixture } from './helpers.js';

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
