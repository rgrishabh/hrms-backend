import type { FastifyInstance } from 'fastify';
import type { SwaggerTransform } from '@fastify/swagger';
import { z, type ZodType } from 'zod';
import { FEATURE_MAP } from '../features/registry.js';
import type { FeatureRoute } from '../features/routes.js';
import { AppError } from './errors.js';
import { PROBLEM_CONTENT_TYPE } from './problem.js';

/** Fields of the RFC 7807 answer, for the document. */
export const ProblemSchema = z.object({
  type: z.string(), title: z.string(), status: z.number().int(), detail: z.string(), instance: z.string(), code: z.string(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })),
}).loose();

const isZod = (s: unknown): s is ZodType => typeof s === 'object' && s !== null && '_zod' in s;

/** Zod to JSON Schema 2020-12, as OpenAPI 3.1 takes it. What the client sends, for input; what it gets, for output. Refinements have no JSON form and are left out. */
export function toJsonSchema(schema: unknown, io: 'input' | 'output'): Record<string, unknown> {
  if (!isZod(schema)) return (schema ?? {}) as Record<string, unknown>;
  const { $schema: _dropped, ...json } = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  return json;
}

/** Reached without a signed-in session. The rest take the session cookie. */
const PUBLIC_ROUTES = new Set(['/api/v1/config/public', '/api/v1/auth/login', '/api/v1/auth/setup', '/api/v1/auth/password/reset', '/api/v1/auth/password/forgot', '/api/v1/devices/events']);
const CONDITIONAL_PERMISSION = /\.has\('([a-z_.]+)'\)/g;

const REVEALS = /\breveal\b|wantsReveal/;
const REVEAL_PARAM = { type: 'string', enum: ['1'], description: 'The only explicit reveal of L4 fields. Audited.' };

const FILE_TYPES: readonly [RegExp, string][] = [
  [/\.csv$/, 'text/csv'], [/\.xlsx$/, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], [/\.pdf$/, 'application/pdf'],
];

/** The env variables a route needs: every group must have one on. Keys with no variable are always on, so they say nothing. */
function featureGroups(requires: readonly (readonly string[])[], url: string): string[][] {
  const groups = requires.map((g) => g.map((k) => FEATURE_MAP.get(k)?.envName ?? null));
  const named = groups.filter((g) => g.every((n) => n !== null)) as string[][];
  if (url.startsWith('/api/v1/auth/mfa')) named.push(['MFA_AVAILABLE']);
  const seen = new Set<string>();
  return named.filter((g) => { const k = [...g].sort().join(); if (seen.has(k)) return false; seen.add(k); return true; });
}

interface RouteDoc { method: string; url: string; config?: { perm?: readonly string[]; permAny?: readonly string[]; feature?: readonly string[] }; handler?: unknown; schema?: Record<string, unknown> }

/**
 * Turns the zod objects on routes into the document. Nothing here runs when serving: `app.swagger()` is only called by `npm run openapi`.
 * `x-feature` keeps routes of switched-off modules in one document: the file describes the product, and an installation answers 404 for what it has off.
 */
export function openApiTransform(featureRoutes: () => readonly FeatureRoute[]): SwaggerTransform {
  return (({ schema, url, route }: { schema: Record<string, unknown> | undefined; url: string; route: RouteDoc }) => {
    const method = [route.method].flat()[0] as string;
    const own = featureRoutes().find((r) => r.method === method && r.url === url);
    const requires = [...(own?.requires ?? []), ...(route.config?.feature ?? []).map((k) => [k])];
    const groups = featureGroups(requires, url);
    const s: Record<string, unknown> = { ...(schema ?? {}) };
    for (const part of ['params', 'body', 'headers'] as const) if (s[part]) s[part] = toJsonSchema(s[part], 'input');
    const query = s['querystring'] ? toJsonSchema(s['querystring'], 'input') : null;
    if (query) s['querystring'] = query;
    if (typeof route.handler === 'function' && REVEALS.test(String(route.handler))) {
      const q = (query ?? { type: 'object', properties: {} }) as { properties?: Record<string, unknown> };
      s['querystring'] = { ...q, properties: { ...q.properties, reveal: REVEAL_PARAM } };
    }
    const declared = (s['response'] ?? {}) as Record<string, unknown>;
    const response: Record<string, unknown> = {};
    for (const [code, r] of Object.entries(declared)) response[code] = isZod(r) ? { description: 'Success', content: { 'application/json': { schema: toJsonSchema(r, 'output') } } } : r;
    const file = FILE_TYPES.find(([re]) => re.test(url));
    if (file && !response['200']) response['200'] = { description: 'A file', content: { [file[1]]: { schema: { type: 'string', format: 'binary' } } } };
    response['default'] = { description: 'An RFC 7807 problem', content: { [PROBLEM_CONTENT_TYPE]: { schema: toJsonSchema(ProblemSchema, 'output') } } };
    s['response'] = response;
    const segments = url.replace(/^\/api\/v1\/?/, '').split('/');
    s['tags'] = s['tags'] ?? [segments[0] || 'root'];
    s['operationId'] = `${method.toLowerCase()} ${url}`;
    const perm = route.config?.perm ?? []; const permAny = route.config?.permAny ?? [];
    if (perm.length) s['x-permissions'] = perm;
    if (permAny.length) s['x-permissions-any'] = permAny;
    // Read off the handler, so that it cannot drift: holding one of these changes what the route does for you, or lets you use it for someone else.
    const conditional = typeof route.handler === 'function' ? [...new Set([...String(route.handler).matchAll(CONDITIONAL_PERMISSION)].map((m) => m[1]!))].filter((p) => !perm.includes(p) && !permAny.includes(p)) : [];
    if (conditional.length) s['x-permissions-conditional'] = conditional;
    if (groups.length) s['x-feature'] = groups;
    s['security'] = PUBLIC_ROUTES.has(url) ? [] : [{ session: [] }];
    return { schema: s, url: url.length > 1 ? url.replace(/\/$/, '') : url };
  }) as unknown as SwaggerTransform;
}

export const OPENAPI_INFO = {
  openapi: '3.1.0',
  info: { title: 'HRMS API', version: 'v1', description: 'Generated from the code. `x-feature`: the switches this route needs, every group with one on; a route whose switch is off answers 404. `x-permissions`: all of these. `x-permissions-any`: any of these. Errors are RFC 7807.' },
  components: { securitySchemes: { session: { type: 'apiKey' as const, in: 'cookie' as const, name: 'hrms_sid' } } },
};

/** Tests only: what a route answers must be what its response schema says, so a schema cannot drift from the code while the suite passes. */
export function registerResponseCheck(app: FastifyInstance) {
  app.addHook('preSerialization', async (req, reply, payload) => {
    const declared = (req.routeOptions.schema?.response as Record<string, unknown> | undefined)?.[String(reply.statusCode)];
    if (!isZod(declared)) return payload;
    // Dates and such are compared as the client gets them.
    const r = declared.safeParse(JSON.parse(JSON.stringify(payload)));
    if (r.success) return payload;
    throw new AppError(500, 'response_schema_mismatch', `${req.method} ${req.routeOptions.url} ${reply.statusCode}: ${r.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  });
}
