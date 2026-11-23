import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, ownerQuery } from '../helpers.js';
import { DEMO_PASSWORD, demoWorld, idsOf, tableFor } from '../contract/demo-world.js';

/**
 * Hostile values in every path, query and body field the document describes, by an owner who can reach everything, against a populated organization with real ids.
 * The answer is a refusal or plain success: never a crash, and never database text. Data stays as it was.
 */
interface JsonSchema {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  default?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  format?: string;
  pattern?: string;
  minLength?: number;
  minimum?: number;
}
interface Operation {
  parameters?: { in: string; name: string }[];
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
}
type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const doc = JSON.parse(readFileSync('openapi.json', 'utf8')) as { paths: Record<string, Record<string, Operation>> };
const ZERO = '00000000-0000-4000-8000-000000000000';
const STRINGS: [string, string][] = [
  ['sqli', `' OR '1'='1' --`],
  ['stacked', `'; DROP TABLE employees; --`],
  ['union', `' UNION SELECT password_hash FROM users --`],
  ['nul', 'a\u0000b'],
  ['surrogate', 'a\ud800b'],
  ['traversal', '../../../../etc/passwd'],
  ['xss', '<script>alert(1)</script>'],
  ['operator', '{"$ne":null}'],
  ['format', '%s%n%x'],
];
const VALUES: [string, Json][] = [
  ...STRINGS,
  ['long', 'x'.repeat(70000)],
  ['object', { $ne: null }],
  ['array', ['x']],
  ['huge', 1e300],
  ['negative', -1e15],
  ['fraction', 1.5],
  ['earliest', '0001-01-01'],
  ['latest', '9999-12-31'],
  ['boolean', true],
];

function sample(s: JsonSchema | undefined): Json {
  if (!s) return 'x';
  if (s.const !== undefined) return s.const as Json;
  if (s.enum) return s.enum[0] as Json;
  if (s.default !== undefined) return s.default as Json;
  const alt = s.anyOf ?? s.oneOf;
  if (alt) return sample(alt.find((x) => x.type !== 'null') ?? alt[0]);
  switch (s.type) {
    case 'object':
      return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, sample(v)]));
    case 'array':
      return [sample(s.items)];
    case 'integer':
    case 'number':
      return Math.max(s.minimum ?? 1, 1);
    case 'boolean':
      return false;
    case 'string':
      if (s.format === 'uuid' || s.pattern?.includes('[0-9a-fA-F]{8}')) return ZERO;
      if (s.format === 'email') return 'x@example.test';
      if (s.format === 'date' || s.pattern?.includes('\\d{4}-\\d{2}-\\d{2}')) return '2030-01-15';
      if (s.pattern?.includes('\\d{4}-')) return '2030-01';
      return 'abcdefgh'.padEnd(s.minLength ?? 8, 'x');
    default:
      return 'x';
  }
}
const leaves = (v: Json, at: (string | number)[] = []): (string | number)[][] =>
  v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => leaves(x, [...at, Array.isArray(v) ? Number(k) : k])) : [at];
const withValue = (o: Json, at: (string | number)[], val: Json): Json => {
  const copy = JSON.parse(JSON.stringify(o)) as Json;
  let x = copy as Record<string | number, Json>;
  for (const k of at.slice(0, -1)) x = x[k] as Record<string | number, Json>;
  x[at[at.length - 1]!] = val;
  return copy;
};
const DB_TEXT = /syntax error|pg_catalog|relation "|column "|violates|SQLSTATE|at character|node_modules|\.ts:\d+|ECONNREFUSED/;
/** These end the attacker's own session, or change who they are, so the rest of the sweep would stop meaning anything. */
const LEAVE_OUT = /auth\/(logout|sessions|password$|mfa)|tenant\/users\/\{id\}$|tenant\/jobs/;

let w: Awaited<ReturnType<typeof demoWorld>>;
beforeAll(async () => {
  w = await demoWorld({ RATE_LIMIT_PER_MINUTE: '100000' });
}, 120000);
afterAll(async () => {
  await w.app.close();
});

describe('hostile input everywhere', () => {
  it('no route crashes or quotes the database, and nothing is dropped', async () => {
    const admin = w.logins.find((l) => l.startsWith('admin@'))!;
    const c = await Client.login(w.app, w.host, admin, DEMO_PASSWORD);
    const before = (await ownerQuery<{ n: string }>(`SELECT count(*) AS n FROM users WHERE tenant_id=$1`, [w.tid]))[0]!.n;
    const crashed = new Set<string>();
    const quoted = new Set<string>();
    let calls = 0;
    const fire = async (name: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: Json) => {
      const r = await c.req(method, url, body as never);
      calls++;
      if (r.statusCode >= 500 && !r.body.includes('response_schema_mismatch')) crashed.add(`${name} ${r.statusCode}`);
      if (DB_TEXT.test(r.body) && r.statusCode >= 400) quoted.add(name);
      return r;
    };
    for (const [path, ops] of Object.entries(doc.paths)) {
      if (LEAVE_OUT.test(path)) continue;
      // A real id reaches deeper than a made-up one.
      const route = path.replace(/\{([^}]+)\}/g, ':$1');
      const ids: Record<string, string> = {};
      for (const m of route.matchAll(/:([A-Za-z]+)/g)) {
        const t = tableFor(route, m[1]!);
        ids[m[1]!] = (t && (await idsOf(t, w.tid, 1))[0]) || ZERO;
      }
      const concrete = path.replace(/\{([^}]+)\}/g, (_, p: string) => ids[p] ?? ZERO);
      for (const [m, op] of Object.entries(ops)) {
        const method = m.toUpperCase() as 'GET';
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) continue;
        const noBody = method === 'GET' || method === 'DELETE' ? undefined : ({} as Json);
        for (const p of op.parameters ?? []) {
          for (const [label, val] of STRINGS) {
            if (label === 'surrogate') continue;
            if (p.in === 'path')
              await fire(
                `${m} ${path} path:${p.name} ${label}`,
                method,
                path.replace(`{${p.name}}`, encodeURIComponent(val)).replace(/\{([^}]+)\}/g, (_, q: string) => ids[q] ?? ZERO),
                noBody,
              );
            if (p.in === 'query' && method === 'GET') await fire(`${m} ${path} query:${p.name} ${label}`, method, `${concrete}?${p.name}=${encodeURIComponent(val)}`);
          }
          if (p.in === 'query' && method === 'GET') await fire(`${m} ${path} query:${p.name} repeated`, method, `${concrete}?${p.name}[$ne]=1&${p.name}=a&${p.name}=b`);
        }
        const schema = op.requestBody?.content?.['application/json']?.schema;
        if (schema && method !== 'GET') {
          const base = sample(schema);
          for (const at of leaves(base)) {
            if (!at.length) continue;
            for (const [label, val] of VALUES) await fire(`${m} ${path} body:${at.join('.')} ${label}`, method, concrete, withValue(base, at, val));
          }
        }
      }
    }
    expect(calls).toBeGreaterThan(10000);
    expect([...crashed]).toEqual([]);
    expect([...quoted]).toEqual([]);
    expect((await ownerQuery<{ n: string }>(`SELECT count(*) AS n FROM users WHERE tenant_id=$1`, [w.tid]))[0]!.n).toBe(before);
    expect((await c.get('/api/v1/auth/me')).statusCode).toBe(200);
  }, 300000);
});

describe('operator and shape injection on sign-in', () => {
  it.each<[string, Json]>([
    ['object as password', { email: 'a@b.test', password: { $ne: null } }],
    ['object as email', { email: { $gt: '' }, password: 'x' }],
    ['array as email', { email: ['a@b.test'], password: 'x' }],
    ['SQL as email', { email: `' OR 1=1 --@x.test`, password: 'x' }],
    ['null', { email: null, password: null }],
  ])('%s signs nobody in', async (_n, body) => {
    const c = new Client(w.app, w.host);
    const r = await c.req('POST', '/api/v1/auth/login', body);
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
    expect(r.headers['set-cookie'] ?? '').not.toContain('hrms_sid');
  });
  it('__proto__ and constructor in a body are refused before any handler', async () => {
    const c = await Client.login(w.app, w.host, w.logins[0]!, DEMO_PASSWORD);
    const hostile = await c.req('POST', '/api/v1/notifications/read-all', '{"__proto__":{"isAdmin":true}}', { 'content-type': 'application/json' });
    expect(hostile.statusCode).toBe(400);
    const ctor = await c.req('POST', '/api/v1/notifications/read-all', '{"constructor":{"prototype":{"isAdmin":true}}}', { 'content-type': 'application/json' });
    expect(ctor.statusCode).toBe(400);
    expect(({} as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });
  it('a broken JSON body is 400 and says nothing of the parser', async () => {
    const c = await Client.login(w.app, w.host, w.logins[0]!, DEMO_PASSWORD);
    const r = await c.req('POST', '/api/v1/notifications/read-all', '{"a":', { 'content-type': 'application/json' });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toMatch(/Unexpected|JSON\.parse|position/);
  });
});
