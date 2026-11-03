import { describe, it, expect, afterAll } from 'vitest';
import { makeApp } from './helpers.js';

const appP = makeApp();
afterAll(async () => (await appP).close());

describe('health endpoints', () => {
  it('serves /health and /ready aliases without authentication or host checks', async () => {
    const app = await appP;
    for (const url of ['/health', '/health/live']) {
      const r = await app.inject({ url, headers: { host: 'anything.invalid' } });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ status: 'ok' });
      expect(r.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    }
    const ready = await app.inject({ url: '/ready' });
    const legacy = await app.inject({ url: '/health/ready' });
    expect([200, 503]).toContain(ready.statusCode);
    expect(ready.statusCode).toBe(legacy.statusCode);
    expect(ready.json().status).toMatch(/^(ready|unavailable)$/);
  });
});
