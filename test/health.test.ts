import { describe, it, expect, afterAll } from 'vitest';
import { makeApp } from './helpers.js';

const appP = makeApp();
afterAll(async () => (await appP).close());

describe('health endpoints', () => {
  it('says which build is running: what the deployment waits for, and nothing else', async () => {
    const tagged = await makeApp({ APP_VERSION: 'v1.2.3' });
    const r = await tagged.inject({ url: '/health', headers: { host: 'anything.invalid' } });
    await tagged.close();
    expect(r.json()).toEqual({ status: 'ok', version: 'v1.2.3' });
    // scripts/k8s-wait-release.sh in hrms-deployment reads it with this, off the raw body.
    expect(/"version":"([^"]*)"/.exec(r.body)?.[1]).toBe('v1.2.3');
  });

  it('serves /health and /ready aliases without authentication or host checks', async () => {
    const app = await appP;
    for (const url of ['/health', '/health/live']) {
      const r = await app.inject({ url, headers: { host: 'anything.invalid' } });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ status: 'ok', version: 'dev' });
      expect(r.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    }
    const ready = await app.inject({ url: '/ready' });
    const legacy = await app.inject({ url: '/health/ready' });
    expect([200, 503]).toContain(ready.statusCode);
    expect(ready.statusCode).toBe(legacy.statusCode);
    expect(ready.json().status).toMatch(/^(ready|unavailable)$/);
  });
});
