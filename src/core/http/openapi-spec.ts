import type { OpenAPIV3_1 } from 'openapi-types';
import type { RouteOptions } from 'fastify';
import { buildApp } from '../../app.js';
import { loadEnv } from '../../config/env.js';
import { FEATURES } from '../features/registry.js';
import { FieldCipher } from '../crypto/index.js';
import { createPool } from '../../db/pool.js';

/** Every switch on, so that one document describes the product. Brand values are placeholders and do not reach it. */
const SPEC_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://spec@127.0.0.1:1/spec',
  COOKIE_SECURE: 'false',
  MFA_AVAILABLE: 'true',
  MFA_METHODS: 'totp,email',
  ORG_MANAGEMENT_MODE: 'multi',
  BRAND_NAME: 'x',
  BRAND_PRODUCT_NAME: 'x',
  BRAND_PRIMARY_COLOR: '#000000',
  BRAND_SUPPORT_EMAIL: 'x@x.test',
  BRAND_EMAIL_FROM: 'x@x.test',
  BRAND_DOMAIN: 'localhost',
  BRAND_LOCALE: 'en-IN',
  BRAND_TIMEZONE: 'Asia/Kolkata',
  BRAND_CURRENCY: 'INR',
  BRAND_DATE_FORMAT: 'DD/MM/YYYY',
  BRAND_FINANCIAL_YEAR_START: '04-01',
  BRAND_COUNTRY: 'IN',
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  ...Object.fromEntries(FEATURES.filter((d) => d.envName && d.availability !== 'planned').map((d) => [d.envName!, 'true'])),
};

export type RouteRecord = Pick<RouteOptions, 'method' | 'url' | 'schema' | 'config'> & { handler: unknown };

export async function buildSpec(): Promise<{ document: OpenAPIV3_1.Document; routes: RouteRecord[] }> {
  const env = loadEnv(SPEC_ENV);
  const pool = createPool(env.DATABASE_URL, 1);
  const routes: RouteRecord[] = [];
  const app = await buildApp({ env, pool, cipher: new FieldCipher(env.DATA_ENCRYPTION_KEY!), openapi: true, onRouteRecorded: (r) => routes.push(r) });
  await app.ready();
  const document = app.swagger() as OpenAPIV3_1.Document;
  await app.close();
  await pool.end();
  // A plugin's root is registered with and without the trailing slash: one route.
  const seen = new Set<string>();
  const unique = routes
    .filter((r) => r.url.startsWith('/api/'))
    .filter((r) => {
      const k = `${String(r.method)} ${r.url.replace(/\/$/, '')}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  return { document, routes: unique };
}

const hasZod = (s: unknown) => typeof s === 'object' && s !== null && '_zod' in s;

/** What the document honestly covers. `binary` routes answer a file and have no JSON shape to declare. */
export function specCoverage(routes: readonly RouteRecord[]) {
  const withResponse = routes.filter((r) => Object.values((r.schema?.response ?? {}) as Record<string, unknown>).some(hasZod));
  const binary = routes.filter((r) => /\.(csv|xlsx|pdf)$/.test(r.url));
  return {
    total: routes.length,
    withRequest: routes.filter((r) => r.schema !== undefined).length,
    withResponse: withResponse.length,
    binary: binary.length,
    withoutResponse: routes.filter((r) => !withResponse.includes(r) && !binary.includes(r)).map((r) => `${String(r.method)} ${r.url}`),
  };
}
