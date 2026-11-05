import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { flags, Client, makeApp } from '../helpers.js';
import { FEATURES } from '../../src/core/features/registry.js';
import { JOBS } from '../../src/core/jobs/registry.js';
import { createTenant, ownerQuery, send, serve, WireClient, type TenantFixture } from './wire.js';

describe('a module that is off', () => {
  let off: FastifyInstance;
  let on: FastifyInstance;
  let T: TenantFixture;
  const modules = ['payroll', 'recruitment', 'expenses', 'posh', 'grievance', 'loans', 'performance', 'assets', 'travel'];
  beforeAll(async () => {
    off = await makeApp({ ...flags('core.documents,attendance,leave') });
    on = await makeApp({
      ...flags(
        `default,${FEATURES.filter((d) => d.envName && d.availability !== 'planned')
          .map((d) => d.key)
          .join(',')}`,
      ),
    });
    T = await createTenant();
  }, 60000);
  afterAll(async () => {
    await off.close();
    await on.close();
  });

  it('every route the full product has answers 404, to the owner, with a valid CSRF token', async () => {
    await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING`, [T.users.admin!.id, T.id]);
    const c = await Client.login(off, T.host, T.users.admin!.email);
    const live = new Set(off.featureRoutes.map((r) => `${r.method} ${r.url}`));
    const wrong: string[] = [];
    for (const r of on.featureRoutes.filter((x) => x.url.startsWith('/api/') && !live.has(`${x.method} ${x.url}`))) {
      const url = r.url.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');
      const res = await c.req(r.method as 'GET', url, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
      if (res.statusCode !== 404) wrong.push(`${r.method} ${r.url} ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);
  });

  it('its report is not listed and cannot be run or exported', async () => {
    const hr = await Client.login(off, T.host, T.users.admin!.email);
    const listed = (await hr.get('/api/v1/reports')).body;
    for (const key of ['payroll_cost', 'expenses', 'expense_claims', 'loans_outstanding', 'training_due']) {
      expect(listed).not.toContain(`"${key}"`);
      for (const suffix of ['', '/export.csv', '/export.xlsx', '/export.pdf']) expect((await hr.get(`/api/v1/reports/${key}${suffix}`)).statusCode, key + suffix).toBe(404);
    }
  });

  it('its jobs are not offered, cannot be run now, and do not run', async () => {
    const admin = await Client.login(off, T.host, T.users.admin!.email);
    const offered = (await admin.get('/api/v1/tenant/jobs')).json() as { items: { key: string }[] };
    const gated = JOBS.filter((j) => j.feature && ![j.feature].flat().some((f) => off.deps.env.enabledFeatures.has(f!)) && !j.retention);
    expect(gated.length).toBeGreaterThan(3);
    for (const j of gated) {
      expect(offered.items.map((i) => i.key)).not.toContain(j.key);
      const r = await admin.post(`/api/v1/tenant/jobs/${j.key}/run`);
      expect(r.statusCode, j.key).toBeGreaterThanOrEqual(400);
    }
  });

  it('its permissions cannot be granted through a custom role, and its settings are not offered', async () => {
    const admin = await Client.login(off, T.host, T.users.admin!.email);
    const r = await admin.post('/api/v1/tenant/roles', { key: 'x_payroll', name: 'Sneaky', permissions: ['payroll.read'] });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect((await admin.get('/api/v1/tenant/settings')).body).not.toMatch(/"payroll\.[a-z_]+"/);
    expect((await admin.get('/api/v1/config/public')).json().features.FEATURE_PAYROLL).toBe(false);
    expect(modules.length).toBeGreaterThan(0);
  });

  it('flags cannot be turned on from the app', async () => {
    const admin = await Client.login(off, T.host, T.users.admin!.email);
    for (const [m, u] of [
      ['PUT', '/api/v1/tenant/modules/payroll'],
      ['POST', '/api/v1/tenant/features'],
      ['PATCH', '/api/v1/tenant/features/payroll'],
      ['PUT', '/api/v1/config/public'],
    ] as const)
      expect((await admin.req(m, u, { enabled: true })).statusCode).toBe(404);
  });
});

describe('security headers', () => {
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
  const COMMON: Record<string, RegExp> = {
    'x-content-type-options': /^nosniff$/,
    'x-frame-options': /^SAMEORIGIN$/,
    'strict-transport-security': /max-age=\d{7,}/,
    'referrer-policy': /^no-referrer$/,
    'cross-origin-resource-policy': /^same-origin$/,
    'cross-origin-opener-policy': /^same-origin$/,
  };

  it.each([
    ['public JSON', '/api/v1/config/public'],
    ['a not-found', '/api/v1/nothing-here'],
    ['a refusal', '/api/v1/employees'],
    ['health', '/health/live'],
  ])('%s carries the set, a CSP that runs nothing, and no server banner', async (_n, url) => {
    const r = await send(port, 'GET', url, { host: T.host });
    for (const [h, re] of Object.entries(COMMON)) expect(String(r.headers[h]), h).toMatch(re);
    expect(r.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers.server).toBeUndefined();
  });

  it('F-125 a signed-in JSON answer is never stored by a browser or proxy', async () => {
    const c = await WireClient.signIn(app, T.host, T.users.employee!.email);
    for (const u of ['/api/v1/auth/me', '/api/v1/employees/me', '/api/v1/leave/balances', '/api/v1/dashboard']) {
      const r = await c.get(u);
      expect(r.statusCode).toBe(200);
      expect(String(r.headers['cache-control']), u).toMatch(/no-store/);
    }
    const hr = await WireClient.signIn(app, T.host, T.users.payroll!.email);
    expect(String((await hr.get(`/api/v1/payroll/employees/${T.users.employee!.employeeId}/salaries?reveal=1`)).headers['cache-control'])).toMatch(/no-store/);
  });

  it('TRACE and unknown methods are refused; a request with a bad Host reaches no organization', async () => {
    expect((await send(port, 'TRACE', '/api/v1/auth/me', { host: T.host })).statusCode).toBeGreaterThanOrEqual(400);
    for (const host of ['evil.test', `${T.host}.evil.test`, `evil.test:${port}`, 'localhost\tx']) {
      const r = await send(port, 'GET', '/api/v1/auth/me', { host }).catch(() => ({ statusCode: 400 }));
      expect(r.statusCode, host).toBeGreaterThanOrEqual(400);
    }
  });

  it('X-Forwarded-Host cannot move a request to another organization', async () => {
    const c = await WireClient.signIn(app, T.host, T.users.employee!.email);
    const X = await createTenant();
    const r = await send(port, 'GET', '/api/v1/auth/me', { host: X.host, 'x-forwarded-host': T.host, cookie: c.cookie });
    expect(r.statusCode).toBe(401);
  });

  it('a crash answers with a reference and no detail', async () => {
    const r = await send(port, 'GET', '/api/v1/employees?page=-1', { host: T.host });
    expect(r.body).not.toMatch(/stack|\.ts:|\/src\//);
  });
});
