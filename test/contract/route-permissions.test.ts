import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, createTenant, makeApp, ownerQuery, type TenantFixture } from '../helpers.js';
import { ALL_ON } from '../security/wire.js';

/**
 * The route half of the permission matrix: permission-matrix.test.ts follows data through a few paths in depth, this visits every route once.
 * Each permission a route declares is tried for real: someone with nothing is refused, someone with exactly that is let past the check.
 */
interface Op {
  'x-permissions'?: string[];
  'x-permissions-any'?: string[];
  security?: unknown[];
}
const doc = JSON.parse(readFileSync('openapi.json', 'utf8')) as { paths: Record<string, Record<string, Op>> };
const ZERO = '00000000-0000-4000-8000-000000000000';
/** Keys that exist, so that a route's own 404 for an unknown key does not stand in for its check. */
const concrete = (p: string) =>
  p
    .replace('/reports/{key}', '/reports/headcount')
    .replace('/tenant/settings/{key}', '/tenant/settings/security.session_idle_minutes')
    .replace('/tenant/jobs/{key}', '/tenant/jobs/attendance.close_day')
    .replace(/\{[^}]+\}/g, ZERO);
const ops = Object.entries(doc.paths).flatMap(([p, v]) =>
  Object.entries(v)
    .filter(([m]) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
    .map(([m, op]) => ({ method: m.toUpperCase() as 'GET', path: p, url: concrete(p), op })),
);
let app: FastifyInstance;
let T: TenantFixture;
beforeAll(async () => {
  app = await makeApp({ ...ALL_ON, RATE_LIMIT_PER_MINUTE: '100000', MFA_AVAILABLE: 'true' });
  T = await createTenant();
}, 60000);
afterAll(async () => {
  await app.close();
});

const bodyFor = (m: string) => (m === 'GET' || m === 'DELETE' ? undefined : {});
let n = 0;
async function holder(perms: string[]) {
  const key = `custom:m${++n}`;
  await ownerQuery(`INSERT INTO tenant_roles (tenant_id, key, name, permissions) VALUES ($1,$2,$3,$4)`, [T.id, key, `Matrix ${n}`, perms]);
  const email = `m${n}@${T.host}`;
  const hash = (await ownerQuery<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id=$1`, [T.users.other!.id]))[0]!.password_hash;
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,'Matrix',$3) RETURNING id`, [T.id, email, hash]);
  await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,$3)`, [u!.id, T.id, key]);
  return Client.login(app, T.host, email);
}

describe('every route', () => {
  it('without a session answers 401 unless the document says it is public', async () => {
    const anon = new Client(app, T.host);
    const wrong: string[] = [];
    // Logging out with no session is a harmless success.
    for (const o of ops.filter((x) => x.op.security?.length && x.path.startsWith('/api/') && x.path !== '/api/v1/auth/logout')) {
      const r = await anon.req(o.method, o.url, bodyFor(o.method));
      if (r.statusCode !== 401) wrong.push(`${o.method} ${o.path} ${r.statusCode}`);
    }
    expect(wrong).toEqual([]);
  }, 120000);

  it('with a declared permission refuses someone holding nothing', async () => {
    const nobody = await holder(['employees.directory']);
    const wrong: string[] = [];
    let tried = 0;
    for (const o of ops.filter((x) => x.op['x-permissions']?.length || x.op['x-permissions-any']?.length)) {
      tried++;
      const r = await nobody.req(o.method, o.url, bodyFor(o.method));
      const need = [...(o.op['x-permissions'] ?? []), ...(o.op['x-permissions-any'] ?? [])];
      if (need.includes('employees.directory')) continue;
      // A module waiting for setup says so before it looks at who is asking, and says nothing else.
      const unset = r.statusCode === 409 && (r.json() as { code?: string }).code === 'feature_not_configured';
      if (![403, 404].includes(r.statusCode) && !unset) wrong.push(`${o.method} ${o.path} ${r.statusCode}`);
    }
    expect(tried).toBeGreaterThan(200);
    expect(wrong).toEqual([]);
  }, 120000);

  it('holding exactly the declared permission gets past that check', async () => {
    const sets = new Map<string, typeof ops>();
    for (const o of ops) {
      const all = o.op['x-permissions'];
      const any = o.op['x-permissions-any'];
      const need = all?.length ? all : any?.length ? [any[0]!] : null;
      if (!need) continue;
      const k = [...need].sort().join(',');
      sets.set(k, [...(sets.get(k) ?? []), o]);
    }
    const wrong: string[] = [];
    for (const [k, list] of sets) {
      const c = await holder(k.split(','));
      for (const o of list) {
        const r = await c.req(o.method, o.url, bodyFor(o.method));
        const code = r.statusCode === 403 ? (r.json() as { code?: string }).code : null;
        // A level or ownership rule on top is its own 403, with a reason: only a bare permission refusal means the document is wrong.
        if (code === 'forbidden' && /permission/i.test((r.json() as { detail?: string }).detail ?? '')) wrong.push(`${o.method} ${o.path} with ${k}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 240000);
});
