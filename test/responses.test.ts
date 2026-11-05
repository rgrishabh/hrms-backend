import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, createTenant, flags, makeApp, type TenantFixture } from './helpers.js';

/**
 * Self-service lists the suite otherwise only reaches refused. makeApp turns on the response check, so reaching them here also proves what their schemas say.
 */
describe('self-service lists answer what they declare', () => {
  let app: FastifyInstance;
  let T: TenantFixture;
  let emp: Client;
  beforeAll(async () => {
    app = await makeApp({ ...flags('default,expenses,leave') });
    T = await createTenant();
    emp = await Client.login(app, T.host, T.users.employee!.email);
  });
  afterAll(() => app.close());

  it.each([
    '/api/v1/leave/requests',
    '/api/v1/leave/requests?scope=mine',
    '/api/v1/expenses/claims',
    '/api/v1/attendance/me/today',
    '/api/v1/notifications',
    '/api/v1/approvals/mine',
    '/api/v1/approvals/inbox',
    '/api/v1/employees/me',
    '/api/v1/dashboard',
  ])('%s', async (url) => {
    const r = await emp.get(url);
    expect(r.statusCode, r.body).toBe(200);
  });
});
