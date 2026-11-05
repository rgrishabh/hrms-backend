import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import type { HostResolution } from '../tenancy/resolve.js';
import type { SessionUser } from '../auth/session.js';
import { forbidden, notFound, unauthorized, AppError, featureNotConfigured } from './errors.js';
import type { Pool } from '../../db/pool.js';
import { withTenant, type Db } from '../../db/tx.js';
import { assertFeatureUsable, evaluateFeatures } from '../features/state.js';
import type { FieldCipher } from '../crypto/index.js';
import type { Env } from '../../config/env.js';
import type { FeatureRoute } from '../features/routes.js';

export type RouteOptionsRecord = Pick<RouteOptions, 'method' | 'url' | 'schema' | 'config'> & { handler: unknown };

export interface RequestContext {
  requestId: string;
  ip: string;
  host: HostResolution;
  user: SessionUser | null;
}

declare module 'fastify' {
  /** What a route needs, for the OpenAPI document. The handler still enforces it; a test keeps the two the same. */
  interface FastifyContextConfig {
    /** Every one of these permissions. */
    perm?: readonly string[];
    /** Any one of these permissions. */
    permAny?: readonly string[];
    /** Features checked at run time by `requireFeature`, besides what mounts the route. */
    feature?: readonly string[];
  }
  interface FastifyRequest { ctx: RequestContext }
  interface FastifyInstance { deps: AppDeps; featureRoutes: readonly FeatureRoute[] }
}

export interface AppDeps { env: Env; pool: Pool; cipher: FieldCipher; /** Tests: JSON logs go here. */ logStream?: { write(line: string): unknown }; /** Tests: refuse an answer that its declared response schema does not describe. */ verifyResponses?: boolean; /** `npm run openapi`: build the document. Serving does not load the generator. */ openapi?: boolean; onRouteRecorded?: (r: RouteOptionsRecord) => void; /** Tests: keep an injected mailer instead of building one from env. */ mailerOverride?: boolean; storeOverride?: boolean; pushOverride?: boolean; /** Tests: another directory than the fixed /brand mount. */ brandDirOverride?: string }

export interface TenantActor {
  tenantId: string;
  user: SessionUser;
  /** Run in a tenant-scoped transaction (RLS-bound). */
  tx: <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
  has: (p: string) => boolean;
  /** Audit-entry defaults for this request. */
  auditBase: { tenantId: string; actorId: string; requestId: string; ip: string };
  /** `?reveal=1`: the only way L4 fields come back unmasked. */
  reveal: boolean;
  userAgent?: string;
}

/** The device, for audit rows of L4 reads. */
export const readDevice = (req: FastifyRequest) => ({ userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined });

export function requireTenantHost(req: FastifyRequest) {
  if (req.ctx.host.kind !== 'tenant') throw new AppError(404, 'unknown_tenant', 'This address is not linked to an active organization');
  if (req.ctx.host.tenant.status !== 'active') throw new AppError(403, 'tenant_suspended', 'This organization is currently suspended');
  return req.ctx.host.tenant;
}

/** Authenticated user of the tenant resolved from the verified host, optionally with permissions (all required). */
export function tenantActor(req: FastifyRequest, ...perms: string[]): TenantActor {
  const tenant = requireTenantHost(req);
  const user = req.ctx.user;
  if (!user || user.tenantId !== tenant.id) throw unauthorized();
  for (const p of perms) if (!user.permissions.has(p)) throw forbidden();
  const pool = req.server.deps.pool;
  return {
    tenantId: tenant.id, user,
    tx: (fn) => withTenant(pool, tenant.id, fn),
    has: (p) => user.permissions.has(p),
    auditBase: { tenantId: tenant.id, actorId: user.userId, requestId: req.id, ip: req.ctx.ip },
    reveal: (req.query as { reveal?: unknown } | undefined)?.reveal === '1',
    userAgent: readDevice(req).userAgent,
  };
}

/** Like tenantActor but needs any one of the given permissions. */
export function tenantActorAny(req: FastifyRequest, ...perms: string[]): TenantActor {
  const a = tenantActor(req);
  if (!perms.some((p) => a.has(p))) throw forbidden();
  return a;
}

export async function requireFeature(db: Db, tenantId: string, key: string) {
  await assertFeatureUsable(db, tenantId, key);
}

/**
 * Module-wide feature gate: every route of the plugin is refused unless at least one of
 * `keys` is usable for the signed-in user's organization. Routes that belong to a narrower
 * feature (shifts, POSH, statutory rules…) still call `requireFeature` themselves.
 * Requests without a session for this tenant pass through, so handlers answer 401 as before.
 */
export function gateFeatures(app: FastifyInstance, ...keys: [string, ...string[]]) {
  app.addHook('preHandler', async (req) => {
    const host = req.ctx.host; const user = req.ctx.user;
    if (host.kind !== 'tenant' || !user || user.tenantId !== host.tenant.id) return;
    const states = await withTenant(req.server.deps.pool, host.tenant.id, (db) => evaluateFeatures(db, host.tenant.id));
    if (keys.some((k) => states.get(k)?.usable)) return;
    if (!keys.some((k) => states.get(k)?.enabled)) throw notFound();
    throw featureNotConfigured(keys[0], states.get(keys[0])?.blockers.join('; ') ?? '');
  });
}
