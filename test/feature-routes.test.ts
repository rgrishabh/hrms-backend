import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, flags, type TenantFixture } from './helpers.js';
import { FEATURES, FEATURE_MAP, type FeatureDefinition } from '../src/core/features/registry.js';
import type { FeatureRoute } from '../src/core/features/routes.js';

/**
 * Generated from the registry and from the routes an app with everything on really has. For every flag, in both states:
 * off, every route of that module is 404 for an anonymous caller and for an administrator; on, it is not.
 */
const FLAGS = FEATURES.filter((d) => d.envName);
const ID = '00000000-0000-4000-8000-000000000001';
const ALL_ON = Object.fromEntries(FLAGS.map((d) => [d.envName!, 'true']));
const envFor = (on: ReadonlySet<string>) => ({ RATE_LIMIT_PER_MINUTE: '100000', ...Object.fromEntries(FLAGS.map((d) => [d.envName!, String(on.has(d.key))])) });

const dependentsClosure = (key: string): Set<string> => {
  const out = new Set([key]);
  for (let grew = true; grew;) {
    grew = false;
    for (const d of FLAGS)
      if (!out.has(d.key) && d.dependencies.some((x) => out.has(x))) {
        out.add(d.key);
        grew = true;
      }
  }
  return out;
};
const needsClosure = (key: string): Set<string> => {
  const out = new Set<string>();
  const visit = (k: string) => {
    const d = FEATURE_MAP.get(k)!;
    if (d.core) return;
    out.add(k);
    d.dependencies.forEach(visit);
  };
  visit(key);
  return out;
};
const reachable = (r: FeatureRoute, on: ReadonlySet<string>) => r.requires.every((group) => group.some((k) => on.has(k)));
const mentions = (r: FeatureRoute, key: string) => r.requires.some((group) => group.includes(key));
const concrete = (url: string) => url.replace(/:[A-Za-z]+(\([^)]*\))?/g, ID);
const label = (r: FeatureRoute) => `${r.method} ${r.url}`;

let all: FastifyInstance;
let routes: readonly FeatureRoute[];
let T: TenantFixture;
beforeAll(async () => {
  all = await makeApp({ ...ALL_ON, RATE_LIMIT_PER_MINUTE: '100000' });
  routes = all.featureRoutes.filter((r) => r.url.startsWith('/api/'));
  T = await createTenant();
});
afterAll(async () => {
  await all.close();
});

async function statusOf(app: FastifyInstance, r: FeatureRoute, cookie?: { client: Client }) {
  if (cookie) return (await cookie.client.req(r.method as 'GET', concrete(r.url), r.method === 'GET' || r.method === 'DELETE' ? undefined : {})).statusCode;
  return (await app.inject({ method: r.method as 'GET', url: concrete(r.url), headers: { host: T.host }, ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { payload: {} }) }))
    .statusCode;
}

describe('the manifest of routes can be trusted', () => {
  /** Written by hand on purpose: if a module's routes were left out of its gate, the manifest alone would not show it. */
  const PREFIX: Record<string, string[] | null> = {
    auth: null,
    tenant: null,
    org: null,
    employees: null,
    approvals: null,
    notifications: null,
    reports: null,
    dashboard: null,
    config: null,
    public: null,
    mfa: null,
    attendance: ['attendance'],
    leave: ['leave'],
    documents: ['core.documents'],
    expenses: ['expenses'],
    competency: ['training'],
    policies: ['core.policies'],
    recruitment: ['recruitment'],
    lifecycle: ['core.onboarding', 'core.offboarding'],
    payroll: ['payroll'],
    cases: ['grievance', 'posh'],
    performance: ['performance'],
    assets: ['assets'],
    overtime: ['overtime'],
    'field-duty': ['field_duty'],
    travel: ['travel'],
    loans: ['loans', 'salary_advance'],
    accounting: ['accounting_exports'],
    devices: ['attendance.biometric'],
  };

  it('every route under a module prefix is gated by that module, and no prefix is unknown', () => {
    expect(routes.length).toBeGreaterThan(200);
    for (const r of routes) {
      const seg = r.url.split('/')[3]!;
      expect([seg, Object.hasOwn(PREFIX, seg)]).toEqual([seg, true]);
      const need = PREFIX[seg];
      if (need) expect([label(r), r.requires[0]]).toEqual([label(r), need]);
    }
  });

  it('every flag owns routes, except email (no screen of its own) and comp off (a payout choice on the overtime routes)', () => {
    const none = FLAGS.filter((d) => !routes.some((r) => mentions(r, d.key))).map((d) => d.envName);
    expect(none.sort()).toEqual(['FEATURE_COMP_OFF', 'FEATURE_EMAIL_NOTIFICATIONS']);
  });

  it('routes of a narrower feature carry it', () => {
    const need = (method: string, url: string) => routes.find((r) => r.method === method && r.url === url)!.requires.flat();
    expect(need('GET', '/api/v1/attendance/shifts')).toContain('shifts');
    expect(need('POST', '/api/v1/attendance/punch')).toEqual(['attendance', 'attendance.web', 'attendance.mobile']);
    expect(need('GET', '/api/v1/payroll/statutory-rules')).toContain('payroll.statutory');
    expect(need('GET', '/api/v1/competency/methods')).toContain('lab.competency');
    expect(need('GET', '/api/v1/reports/saved')).toContain('reports.advanced');
    expect(need('POST', '/api/v1/notifications/push/subscribe')).toEqual(['notifications.push']);
  });
});

describe.each(FLAGS.map((d): [string, FeatureDefinition] => [d.envName!, d]))('%s', (_name, flag) => {
  it('off: every route of the module is 404, signed in or not', async () => {
    const offKeys = dependentsClosure(flag.key);
    const on = new Set(FLAGS.map((d) => d.key).filter((k) => !offKeys.has(k)));
    const app = await makeApp(envFor(on));
    try {
      const gone = routes.filter((r) => !reachable(r, on));
      const admin = await Client.login(app, T.host, T.users.admin!.email);
      for (const r of gone) {
        expect([label(r), 'anonymous', await statusOf(app, r)]).toEqual([label(r), 'anonymous', 404]);
        expect([label(r), 'admin', await statusOf(app, r, { client: admin })]).toEqual([label(r), 'admin', 404]);
      }
      // And the app really has no such route, rather than a handler that answers 404.
      for (const r of gone) expect([label(r), app.hasRoute({ method: r.method as 'GET', url: r.url })]).toEqual([label(r), false]);
      // Everything else is still there.
      for (const r of routes.filter((x) => reachable(x, on))) expect([label(r), app.hasRoute({ method: r.method as 'GET', url: r.url })]).toEqual([label(r), true]);
    } finally {
      await app.close();
    }
  }, 120_000);

  it('on, with only what it needs: its routes are not 404', async () => {
    const on = needsClosure(flag.key);
    const app = await makeApp(envFor(on));
    try {
      for (const r of routes.filter((x) => mentions(x, flag.key) && reachable(x, on))) {
        expect([label(r), await statusOf(app, r)]).not.toEqual([label(r), 404]);
      }
    } finally {
      await app.close();
    }
  }, 120_000);
});

it('with both web and mobile off, there is no clock-in route', async () => {
  const app = await makeApp({ ...flags('default'), FEATURE_ATTENDANCE_WEB: 'false', FEATURE_ATTENDANCE_MOBILE: 'false' });
  try {
    expect(app.hasRoute({ method: 'POST', url: '/api/v1/attendance/punch' })).toBe(false);
  } finally {
    await app.close();
  }
});
