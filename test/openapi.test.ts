import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { OpenAPIV3_1 } from 'openapi-types';
import { buildSpec, specCoverage, type RouteRecord } from '../src/core/http/openapi-spec.js';
import { FEATURES } from '../src/core/features/registry.js';
import { Client, createTenant, makeApp, problem, type TenantFixture } from './helpers.js';

let doc: OpenAPIV3_1.Document; let routes: RouteRecord[];
beforeAll(async () => { ({ document: doc, routes } = await buildSpec()); }, 60000);

type Op = OpenAPIV3_1.OperationObject & Record<string, unknown>;
const pathOf = (url: string) => url.replace(/\/$/, '').replace(/\(.*?\)/g, '').replace(/:([A-Za-z0-9_]+)/g, '{$1}');
const opOf = (r: RouteRecord): Op | undefined => (doc.paths?.[pathOf(r.url)] as Record<string, Op> | undefined)?.[String(r.method).toLowerCase()];
const schemaOf = (r: RouteRecord) => (r.schema ?? {}) as Record<string, unknown>;

/** The source files that declare routes. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : []; });
}

describe('the document', () => {
  it('is built with no database and describes every route', () => {
    expect(routes.length).toBeGreaterThan(300);
    for (const r of routes) expect(opOf(r), `${String(r.method)} ${r.url}`).toBeTruthy();
  });

  it('no route lacks a schema, and every input a handler reads is declared', () => {
    const missing: string[] = [];
    for (const r of routes) {
      const s = schemaOf(r); const h = String(r.handler); const name = `${String(r.method)} ${r.url}`;
      if (r.schema === undefined) missing.push(`${name}: no schema`);
      if (/:[a-zA-Z]/.test(r.url) && !s['params']) missing.push(`${name}: params`);
      if (/\.parse\(req\.query|req\.query\b(?! as \{ reveal)/.test(h) && !s['querystring']) missing.push(`${name}: query`);
      if (/parse\(req\.body|parse\(fields|req\.body\b/.test(h) && !s['body']) missing.push(`${name}: body`);
    }
    expect(missing).toEqual([]);
  });

  it('every path parameter is in the document', () => {
    for (const r of routes) {
      const names = [...r.url.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
      const declared = ((opOf(r)?.parameters ?? []) as OpenAPIV3_1.ParameterObject[]).filter((p) => p.in === 'path').map((p) => p.name);
      for (const n of names) expect(declared, `${r.url} ${n}`).toContain(n);
    }
  });

  it('schemas are hoisted: no handler builds one inline, so the object documented is the object that parses', () => {
    const inline: string[] = [];
    for (const f of [...sources('src/modules'), ...sources('src/core/workflow')]) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (/\bz\.\w+\(.*\)\.(safeP|p)arse\(req\.(params|query|body)/.test(line)) inline.push(`${f}:${i + 1}`); });
    }
    expect(inline).toEqual([]);
  });

  it('a permission in the metadata is the one the handler asks for', () => {
    const wrong: string[] = [];
    for (const r of routes) {
      const h = String(r.handler); const cfg = (r.config ?? {}) as { perm?: readonly string[]; permAny?: readonly string[] };
      const asked = [...h.matchAll(/tenantActor\(req,\s*([^)]*)\)/g)].flatMap((m) => [...m[1]!.matchAll(/'([a-z_.]+)'/g)].map((x) => x[1]!));
      const askedAny = [...h.matchAll(/tenantActorAny\(req,\s*([^)]*)\)/g)].flatMap((m) => [...m[1]!.matchAll(/'([a-z_.]+)'/g)].map((x) => x[1]!));
      for (const p of asked) if (!cfg.perm?.includes(p)) wrong.push(`${String(r.method)} ${r.url} needs ${p}`);
      for (const p of askedAny) if (!cfg.permAny?.includes(p)) wrong.push(`${String(r.method)} ${r.url} needs one of ${p}`);
    }
    expect(wrong).toEqual([]);
  });

  it('routes of switched-off modules are included, marked x-feature', () => {
    const features = new Set(routes.flatMap((r) => ((opOf(r)?.['x-feature'] ?? []) as string[][]).flat()));
    // Everything the default installation leaves off still has its routes in the one document.
    for (const k of ['FEATURE_PAYROLL', 'FEATURE_LOANS', 'FEATURE_RECRUITMENT', 'FEATURE_GRIEVANCE', 'FEATURE_ASSET_MANAGEMENT', 'MFA_AVAILABLE']) expect(features).toContain(k);
    const named = new Set(FEATURES.map((f) => f.envName)); named.add('MFA_AVAILABLE');
    for (const f of features) expect(named).toContain(f);
    expect(doc.paths?.['/api/v1/payroll/runs']?.get).toMatchObject({ 'x-feature': [['FEATURE_PAYROLL']] });
  });

  it('errors are documented as RFC 7807, and the document has no installation in it', () => {
    const op = doc.paths?.['/api/v1/assets/{id}/issue']?.post as Op;
    const def = op.responses?.['default'] as OpenAPIV3_1.ResponseObject;
    expect(Object.keys(def.content ?? {})).toEqual(['application/problem+json']);
    expect(JSON.stringify(doc)).not.toMatch(/postgres:\/\/|x@x\.test/);
  });

  it('coverage is what it says', () => {
    const c = specCoverage(routes);
    expect(c.withRequest).toBe(c.total);
    expect(c.withResponse + c.binary + c.withoutResponse.length).toBeGreaterThanOrEqual(c.total);
  });
});

describe('a schema does not change the order of refusals', () => {
  let app: FastifyInstance; let T: TenantFixture;
  beforeAll(async () => { app = await makeApp(); T = await createTenant(); });
  afterAll(() => app.close());

  it('401 without a session, 403 without the permission, then 400', async () => {
    const bad = { code: '' };
    const anon = await app.inject({ method: 'POST', url: '/api/v1/org/departments', headers: { host: T.host, 'content-type': 'application/json' }, payload: bad });
    expect(anon.statusCode).toBe(401);
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    expect((await emp.post('/api/v1/org/departments', bad)).statusCode).toBe(403);
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    const r = await admin.post('/api/v1/org/departments', bad);
    expect([r.statusCode, problem(r).code]).toEqual([400, 'validation_failed']);
    expect(problem(r).errors.length).toBeGreaterThan(0);
  });

  it('parsing still applies its transforms: the value the handler gets is parsed, not the raw body', async () => {
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    const r = await admin.post('/api/v1/org/departments', { code: 'TRIM', name: '  Spaced  ' });
    expect(r.statusCode).toBe(201);
    const list = (await admin.get('/api/v1/org')).json() as { departments: { code: string; name: string }[] };
    expect(list.departments.find((d) => d.code === 'TRIM')?.name).toBe('Spaced');
  });
});
