import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, flags, makeApp, ownerQuery } from '../helpers.js';
import { FEATURES } from '../../src/core/features/registry.js';
import { createTenant, type TenantFixture } from '../security/wire.js';

/** Every management mode with the modules all on, on their defaults, and all off. The same questions each time: does it start, what does it offer, and is what it refuses refused the same way. */
const every = FEATURES.filter((d) => d.envName && d.availability !== 'planned').map((d) => d.key);
const SETS: [string, () => Record<string, string>][] = [
  ['everything on', () => flags(every.join(','))],
  ['defaults', () => flags('default')],
  ['everything off', () => flags('')],
];
const MODES = ['single', 'single_hr', 'multi'] as const;

for (const mode of MODES)
  for (const [label, set] of SETS)
    describe(`${mode}, ${label}`, () => {
      let app: FastifyInstance;
      let T: TenantFixture;
      let owner: Client;
      beforeAll(async () => {
        app = await makeApp({ ORG_MANAGEMENT_MODE: mode, ...set() });
        T = await createTenant();
        await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'owner')`, [T.users.admin!.id, T.id]);
        owner = await Client.login(app, T.host, T.users.admin!.email);
      }, 60000);
      afterAll(async () => {
        await app.close();
      });

      it('public config tells the truth about mode and every flag', async () => {
        const cfg = (await owner.get('/api/v1/config/public')).json() as { mode: string; features: Record<string, boolean> };
        expect(cfg.mode).toBe(mode);
        for (const d of FEATURES.filter((x) => x.envName && x.availability !== 'planned'))
          expect(cfg.features[d.envName!], d.envName!).toBe(app.deps.env.enabledFeatures.has(d.key));
      });

      it('the always-on core answers the owner; a route of a module that is off does not exist', async () => {
        for (const u of [
          '/api/v1/auth/me',
          '/api/v1/dashboard',
          '/api/v1/approvals/inbox',
          '/api/v1/notifications',
          '/api/v1/org',
          '/api/v1/employees',
          '/api/v1/reports',
          '/api/v1/tenant/audit',
        ]) {
          const r = await owner.get(u);
          expect(r.statusCode, `${u} ${r.body.slice(0, 200)}`).toBe(200);
        }
        const on = (k: string) => app.deps.env.enabledFeatures.has(k);
        for (const [k, u] of [
          ['payroll', '/api/v1/payroll/runs'],
          ['leave', '/api/v1/leave/types'],
          ['recruitment', '/api/v1/recruitment/requisitions'],
          ['expenses', '/api/v1/expenses/claims'],
          ['loans', '/api/v1/loans/requests'],
        ] as const)
          expect((await owner.get(u)).statusCode === 404, u).toBe(!on(k));
      });

      it('roles on offer fit the mode; role screens exist only in multi', async () => {
        const r = await owner.get('/api/v1/tenant/roles');
        if (mode === 'multi') expect(r.body).toContain('finance_manager');
        else expect(r.statusCode).toBe(404);
        const asFinance = await owner.post('/api/v1/tenant/users', { email: `f${mode}${label.length}@${T.host}`, displayName: 'Finance Person', roles: ['finance_manager'] });
        expect(asFinance.statusCode, asFinance.body).toBe(mode === 'multi' ? 201 : 400);
        const made = await owner.post('/api/v1/tenant/roles', { key: `r${mode}`, name: `Role ${mode}${label}`, permissions: ['employees.directory'] });
        expect(made.statusCode, made.body).toBe(mode === 'multi' ? 201 : 404);
      });

      it('an employee cannot do what the owner can, in any mode', async () => {
        const emp = await Client.login(app, T.host, T.users.employee!.email);
        expect((await emp.get('/api/v1/tenant/audit')).statusCode).toBe(403);
        expect((await emp.get('/api/v1/tenant/users')).statusCode).toBe(403);
      });
    });
