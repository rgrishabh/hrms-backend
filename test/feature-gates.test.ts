import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, type TenantFixture } from './helpers.js';

const ID = '00000000-0000-4000-8000-000000000001';
const code = (r: { json: () => { error?: { code?: string } } }) => r.json().error?.code;

/**
 * Every route of a module is refused while its module is off, not only the
 * routes that remembered to call requireFeature (gateFeatures on the plugin).
 */
describe('module-wide feature gates', () => {
  let off: FastifyInstance; let T: TenantFixture; let admin: Client; let hr: Client;
  // Onboarding on, offboarding off; expenses, assets, payroll, cases, performance off.
  beforeAll(async () => {
    off = await makeApp({ ENABLED_MODULES: 'core.employees,core.onboarding,attendance,leave' });
    T = await createTenant();
    admin = await Client.login(off, T.host, T.users.admin!.email);
    hr = await Client.login(off, T.host, T.users.hr!.email);
  });
  afterAll(async () => { await off.close(); });

  it('refuses routes of a module that is off, before permission or lookup', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/expenses/payables'], ['GET', '/api/v1/expenses/batches'], ['GET', '/api/v1/expenses/reports/ageing'],
      ['POST', `/api/v1/expenses/batches/${ID}/approve`], ['GET', `/api/v1/assets/${ID}/history`], ['GET', '/api/v1/cases/people'],
      ['GET', `/api/v1/performance/reviews/${ID}`], ['POST', `/api/v1/payroll/statutory-rules/${ID}/retire`], ['GET', '/api/v1/documents'],
      ['GET', '/api/v1/recruitment/requisitions'], ['GET', '/api/v1/policies'],
    ] as const) {
      const r = await admin.req(method, url, method === 'POST' ? {} : undefined);
      expect([url, r.statusCode, code(r)]).toEqual([url, 403, 'feature_unavailable']);
    }
  });

  it('a module made of two features stays open for the one that is on, and each route checks its own', async () => {
    expect((await hr.get('/api/v1/lifecycle/checklists')).statusCode).toBe(200);
    expect((await hr.get('/api/v1/lifecycle/tasks/mine')).statusCode).toBe(200);
    expect(code(await admin.get(`/api/v1/lifecycle/separations/${ID}`))).toBe('feature_unavailable');
    expect(code(await admin.post(`/api/v1/lifecycle/separations/${ID}/withdraw`, { reason: 'test' }))).toBe('feature_unavailable');
  });

  it('shift and holiday screens follow their own modules', async () => {
    expect(code(await admin.get('/api/v1/attendance/shifts'))).toBe('feature_unavailable');
    expect(code(await admin.get('/api/v1/attendance/holidays?year=2026'))).toBe('feature_unavailable');
    expect(code(await admin.del(`/api/v1/attendance/holidays/${ID}`))).toBe('feature_unavailable');
    expect((await hr.get('/api/v1/attendance/locks')).statusCode).toBe(200);
  });

  it('without a session the answer is still 401, so module state is not disclosed', async () => {
    const anon = new Client(off, T.host);
    expect((await anon.get('/api/v1/expenses/batches')).statusCode).toBe(401);
    expect((await anon.get('/api/v1/cases/people')).statusCode).toBe(401);
  });
});
