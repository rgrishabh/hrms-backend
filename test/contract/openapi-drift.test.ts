import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { OpenAPIV3_1 } from 'openapi-types';
import { buildSpec } from '../../src/core/http/openapi-spec.js';
import { makeApp } from '../helpers.js';
import { ALL_ON } from '../security/wire.js';

/** The frontend generates its client from the committed openapi.json, so the file has to be what the code says and what a running app serves. `npm run openapi` writes it. */
const committed = JSON.parse(readFileSync('openapi.json', 'utf8')) as OpenAPIV3_1.Document;
let live: FastifyInstance;
let generated: OpenAPIV3_1.Document;
beforeAll(async () => {
  ({ document: generated } = await buildSpec());
  live = await makeApp({ ...ALL_ON, MFA_AVAILABLE: 'true', MFA_METHODS: 'totp,email' });
}, 60000);
afterAll(async () => {
  await live.close();
});

const docKey = (url: string) =>
  url
    .replace(/\/$/, '')
    .replace(/\(.*?\)/g, '')
    .replace(/:([A-Za-z0-9_]+)/g, '{$1}');
const ops = (d: OpenAPIV3_1.Document) =>
  Object.entries(d.paths ?? {})
    .flatMap(([p, v]) =>
      Object.keys(v as object)
        .filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
        .map((m) => `${m.toUpperCase()} ${p}`),
    )
    .sort();

describe('openapi.json', () => {
  it('is byte for byte what the code generates: run `npm run openapi` and commit', () => {
    expect(readFileSync('openapi.json', 'utf8')).toBe(`${JSON.stringify(generated, null, 2)}\n`);
  });

  it('lists every route a running app with every switch on has, and no route it lacks', () => {
    const running = [
      ...new Set(live.featureRoutes.filter((r) => r.url.startsWith('/api/') || r.url.startsWith('/health') || r.url === '/ready').map((r) => `${r.method} ${docKey(r.url)}`)),
    ].sort();
    expect(running).toEqual(ops(committed).filter((o) => !o.includes('/metrics')));
  });

  it('names every path parameter a route takes', () => {
    for (const [p, v] of Object.entries(committed.paths ?? {})) {
      const names = [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      for (const [m, op] of Object.entries(v as Record<string, OpenAPIV3_1.OperationObject>)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(m)) continue;
        const declared = ((op.parameters ?? []) as OpenAPIV3_1.ParameterObject[]).filter((x) => x.in === 'path').map((x) => x.name);
        expect(declared.sort(), `${m} ${p}`).toEqual([...names].sort());
      }
    }
  });
});
