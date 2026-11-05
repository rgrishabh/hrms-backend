import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { resolveHost } from './core/tenancy/resolve.js';
import { loadSession, SESSION_COOKIE } from './core/auth/session.js';
import { sha256, safeEqualHex } from './core/crypto/index.js';
import { AppError } from './core/http/errors.js';
import { problemErrorHandler } from './core/http/problem.js';
import { OPENAPI_INFO, openApiTransform, registerResponseCheck } from './core/http/openapi.js';
import { registerMetrics } from './core/http/metrics.js';
import { registerTelemetry } from './core/telemetry.js';
import { isExportRoute, perUserLimit } from './core/http/limits.js';
import type { AppDeps } from './core/http/context.js';
import { initRuntime } from './core/runtime.js';
import { withFeatures } from './core/features/state.js';
import { withMemo } from './core/memo.js';
import { withMode } from './core/policy/mode.js';
import { LOG_REDACT_PATHS, logSerializers } from './core/logging.js';
import type { FeatureRoute } from './core/features/routes.js';
import { authRoutes, PASSWORD_CHANGE_ALLOWED } from './modules/auth.js';
import { MFA_PENDING_ALLOWED, MFA_ENROLL_ALLOWED, SESSIONLESS_PATHS, mfaPolicyOf } from './core/auth/mfa.js';
import { tenantAdminRoutes } from './modules/tenant/routes.js';
import { orgRoutes } from './modules/org/routes.js';
import { employeeRoutes } from './modules/employees/routes.js';
import { attendanceRoutes } from './modules/attendance/routes.js';
import { deviceIngestRoutes } from './modules/attendance/device-routes.js';
import { approvalRoutes } from './core/workflow/routes.js';
import { leaveRoutes } from './modules/leave/routes.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { documentRoutes } from './modules/documents/routes.js';
import { mfaRoutes } from './modules/mfa.js';
import { expenseRoutes } from './modules/expenses/routes.js';
import { competencyRoutes } from './modules/competency/routes.js';
import { policyRoutes } from './modules/policies/routes.js';
import { recruitmentRoutes } from './modules/recruitment/routes.js';
import { lifecycleRoutes } from './modules/lifecycle/routes.js';
import { payrollRoutes } from './modules/payroll/routes.js';
import { caseRoutes } from './modules/cases/routes.js';
import { performanceRoutes } from './modules/performance/routes.js';
import { overtimeRoutes } from './modules/overtime/routes.js';
import { fieldDutyRoutes } from './modules/field-duty/routes.js';
import { travelRoutes } from './modules/travel/routes.js';
import { loanRoutes } from './modules/loans/routes.js';
import { accountingRoutes } from './modules/accounting/routes.js';
import { assetRoutes } from './modules/assets/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { dashboardRoutes } from './modules/dashboard/routes.js';
import { BRAND_MOUNT, registerWeb, registerBrandAssets, spaCsp, API_CSP, ASSET_CSP } from './core/http/web.js';
import { allowedCorsOrigin } from './config/env.js';
import { migrationStatus } from './db/migrate.js';
import { createPool, readUrl } from './db/pool.js';

const READINESS_TIMEOUT_MS = 2000;
const PASSIVE_PATHS = new Set(['/api/v1/notifications/unread-count']);
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { env } = deps;
  const app = Fastify({
    logger:
      env.NODE_ENV === 'test' && !deps.logStream
        ? false
        : {
            level: env.LOG_LEVEL,
            // Never log credentials or session material.
            redact: LOG_REDACT_PATHS,
            serializers: logSerializers,
            ...(deps.logStream ? { stream: deps.logStream } : {}),
          },
    // Fastify treats a bare number as "trust nothing", so a hop count is expressed as a function: believe that many hops.
    trustProxy:
      typeof env.TRUST_PROXY === 'number'
        ? (
            (hops: number) => (_addr: string, hop: number) =>
              hop < hops
          )(env.TRUST_PROXY)
        : env.TRUST_PROXY,
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
  });
  // Reports and heavy reads, when there is a replica. Same role and database name, so RLS and grants are the primary's.
  if (env.DB_READ_HOST) {
    const readPool = createPool(readUrl(env.DATABASE_URL, env.DB_READ_HOST), env.DATABASE_POOL_MAX);
    deps = { ...deps, readPool };
    app.addHook('onClose', () => readPool.end());
  }
  app.decorate('deps', deps);
  // Deployment configuration is validated here; an invalid module set stops the process.
  const runtime = initRuntime(env, app.log, deps);
  const { publicConfig, features } = runtime;
  app.addHook('onClose', () => runtime.close());
  // Each app's requests see its own feature set. Reading the body leaves the async context, hence the second hook.
  const memos = new WeakMap<object, Map<string, unknown>>();
  const memoOf = (req: object) => {
    const m = memos.get(req) ?? new Map<string, unknown>();
    memos.set(req, m);
    return m;
  };
  const inScope = (req: object, done: () => void) => withMemo(memoOf(req), () => withFeatures(features, () => withMode(env.ORG_MANAGEMENT_MODE, done)));
  app.addHook('onRequest', (req, _reply, done) => {
    inScope(req, done);
  });
  app.addHook('preValidation', (req, _reply, done) => {
    inScope(req, done);
  });
  // What each route needs, for the test that goes through every flag.
  const featureRoutes: FeatureRoute[] = [];
  let mounting: readonly string[] | null = null;
  app.decorate('featureRoutes', featureRoutes);
  // Exports carry many people's data and cost the most, so each gets a tighter limit, per address and per user, wherever it is declared.
  // Before the rate limit plugin registers, so that its own hook sees the config.
  const exportsPerUser = () => perUserLimit(app, 'export', env.EXPORT_RATE_LIMIT_PER_MINUTE);
  let exportLimit: ReturnType<typeof exportsPerUser> | null = null;
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      deps.onRouteRecorded?.({ method, url: r.url, schema: r.schema, config: r.config, handler: r.handler });
      featureRoutes.push({ method, url: r.url, requires: [...(mounting ? [mounting] : []), ...(r.config?.features ? [r.config.features] : [])] });
      if (isExportRoute(method, r.url)) {
        r.config = { ...r.config, rateLimit: { max: env.EXPORT_RATE_LIMIT_PER_MINUTE * 4, timeWindow: '1 minute' } };
        exportLimit ??= exportsPerUser();
        r.preHandler = [...[r.preHandler ?? []].flat(), exportLimit];
      }
    }
  });
  const mfaPolicy = mfaPolicyOf(env);
  const SPA_CSP = spaCsp([publicConfig.brand.logoUrl, publicConfig.brand.logoDarkUrl, publicConfig.brand.faviconUrl]);
  app.decorateRequest('ctx', null as never);
  // A route's schema is documentation: its handler parses with the same object, after the permission check, so 401 and 403 still come before 400 (D51).
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));

  if (deps.openapi) {
    const { default: swagger } = await import('@fastify/swagger');
    await app.register(swagger, { openapi: OPENAPI_INFO, transform: openApiTransform(() => featureRoutes), hideUntagged: false });
  }
  await app.register(cookie);
  // BRAND_DOMAIN is the only origin allowed to call the API from a browser, with cookies. Same-origin requests need none of this.
  await app.register(cors, {
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'x-csrf-token'],
    maxAge: 600,
    origin: (origin, cb) => {
      cb(null, !!origin && allowedCorsOrigin(env, origin));
    },
  });
  // CSP is set per response: strict 'none' for API/JSON, sandboxed for branding files, same-origin for the SPA.
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-origin' } });
  app.addHook('onSend', async (req, reply) => {
    const u = req.url;
    // The reference a problem's `instance` and every log line carry.
    reply.header('x-request-id', req.id);
    reply.header(
      'content-security-policy',
      u.startsWith('/api/') || u.startsWith('/health') || u === '/ready' || u === '/metrics' ? API_CSP : u.startsWith('/brand/') ? ASSET_CSP : SPA_CSP,
    );
  });
  await app.register(rateLimit, { global: true, max: env.RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: env.STORAGE_MAX_FILE_MB * 1024 * 1024, files: 1, fields: 10, parts: 12, fieldSize: 10_000 } });

  // Liveness/readiness are host-agnostic and unauthenticated; they reveal no internals.
  // `/health` and `/ready` are aliases for orchestrators and the deployment smoke tests.
  const noLimit = { schema: {}, config: { rateLimit: false as const } };
  registerMetrics(app, env.METRICS_TOKEN, deps.pool);
  registerTelemetry(app, env.OTEL_EXPORTER_OTLP_ENDPOINT, env.BRAND_PRODUCT_NAME, app.log);
  if (deps.verifyResponses) registerResponseCheck(app);
  const live = async () => ({ status: 'ok' });
  let warnedNewerSchema = false;
  app.get('/health/live', noLimit, live);
  app.get('/health', noLimit, live);
  const ready = async (_req: unknown, reply: import('fastify').FastifyReply) => {
    // A probe must answer before the orchestrator's own timeout, also when every connection is busy.
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_r, reject) => {
      timer = setTimeout(() => {
        reject(new Error('readiness timed out'));
      }, READINESS_TIMEOUT_MS);
    });
    try {
      const check = async () => {
        const status = await migrationStatus(deps.pool);
        const org = await deps.pool.query<{ ok: boolean }>('SELECT EXISTS (SELECT 1 FROM tenants) AS ok');
        return { m: status, hasOrg: org.rows[0]!.ok };
      };
      const { m, hasOrg } = await Promise.race([check(), late]);
      // Pending migrations: this build needs a newer schema -> not ready. Unknown (newer) migrations are
      // expected after a rollback to the previous release; migrations are expand/contract, so serve.
      if (m.pending.length) return reply.code(503).send({ status: 'unavailable' });
      if (m.unknown.length && !warnedNewerSchema) {
        warnedNewerSchema = true;
        app.log.warn({ unknown: m.unknown }, 'database schema is newer than this build (rollback?)');
      }
      if (!hasOrg) return reply.code(503).send({ status: 'unavailable' });
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    } finally {
      clearTimeout(timer);
    }
  };
  app.get('/health/ready', noLimit, ready);
  app.get('/ready', noLimit, ready);

  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/health') || req.url === '/ready' || req.url === '/metrics') {
      req.ctx = { requestId: req.id, ip: req.ip, host: { kind: 'unknown', host: '' }, user: null };
      return;
    }
    if (!req.url.startsWith('/api/')) {
      req.ctx = { requestId: req.id, ip: req.ip, host: { kind: 'unknown', host: '' }, user: null };
      return;
    }
    const host = await resolveHost(deps.pool, req.headers.host);
    req.ctx = { requestId: req.id, ip: req.ip, host, user: null };
    const token = req.cookies[SESSION_COOKIE];
    if (token && host.kind === 'tenant') {
      // A browser left open polls for notifications. That is not someone using it, and must not keep the session from idling out.
      req.ctx.user = await loadSession(deps.pool, token, host.tenant.id, mfaPolicy, { passive: req.method === 'GET' && PASSIVE_PATHS.has(req.url.split('?')[0]!) });
      if (SESSIONLESS_PATHS.has(req.url.split('?')[0]!)) return;
      // CSRF: any state-changing request authenticated by cookie must carry the session-bound token.
      if (req.ctx.user && UNSAFE.has(req.method)) {
        const header = req.headers['x-csrf-token'];
        if (typeof header !== 'string' || !safeEqualHex(sha256(header), req.ctx.user.csrfHash)) {
          throw new AppError(403, 'csrf_failed', 'Security token missing or invalid. Reload the page and try again.');
        }
      }
      const path = req.url.split('?')[0]!;
      // Second factor first: a session with MFA enrolled is useless until the code is verified.
      if (req.ctx.user?.mfaPending && !MFA_PENDING_ALLOWED.has(path)) {
        throw new AppError(403, 'mfa_required', 'Enter your two-factor code to continue.');
      }
      if (req.ctx.user?.mfaEnrollmentRequired && !MFA_ENROLL_ALLOWED.has(path)) {
        throw new AppError(403, 'mfa_enrollment_required', 'This installation requires two-factor authentication. Set it up to continue.');
      }
      // Forced password change (bootstrap password mode): nothing else until it is done.
      if (req.ctx.user?.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(path)) {
        throw new AppError(403, 'password_change_required', 'You must change your password before continuing.');
      }
    }
  });

  app.setErrorHandler(problemErrorHandler);

  // Always on: no flag in the registry.
  await app.register(authRoutes, { prefix: '/api/v1', publicConfig });
  // MFA_AVAILABLE=false: none of it exists.
  if (env.MFA_AVAILABLE) await app.register(mfaRoutes, { prefix: '/api/v1/auth/mfa', publicConfig });
  await app.register(tenantAdminRoutes, { prefix: '/api/v1/tenant', publicConfig });
  await app.register(orgRoutes, { prefix: '/api/v1/org' });
  await app.register(employeeRoutes, { prefix: '/api/v1/employees' });
  await app.register(approvalRoutes, { prefix: '/api/v1/approvals' });
  await app.register(notificationRoutes, { prefix: '/api/v1/notifications' });
  await app.register(reportRoutes, { prefix: '/api/v1/reports' });
  await app.register(dashboardRoutes, { prefix: '/api/v1/dashboard' });

  // A module that is off is never mounted, so its routes answer 404 like any address that does not exist.
  const modules: readonly [readonly [string, ...string[]], FastifyPluginAsync, string][] = [
    [['attendance'], attendanceRoutes, 'attendance'],
    [['leave'], leaveRoutes, 'leave'],
    [['core.documents'], documentRoutes, 'documents'],
    [['expenses'], expenseRoutes, 'expenses'],
    [['training'], competencyRoutes, 'competency'],
    [['core.policies'], policyRoutes, 'policies'],
    [['recruitment'], recruitmentRoutes, 'recruitment'],
    [['core.onboarding', 'core.offboarding'], lifecycleRoutes, 'lifecycle'],
    [['payroll'], payrollRoutes, 'payroll'],
    [['grievance', 'posh'], caseRoutes, 'cases'],
    [['performance'], performanceRoutes, 'performance'],
    [['assets'], assetRoutes, 'assets'],
    [['overtime'], overtimeRoutes, 'overtime'],
    [['field_duty'], fieldDutyRoutes, 'field-duty'],
    [['travel'], travelRoutes, 'travel'],
    [['loans', 'salary_advance'], loanRoutes, 'loans'],
    [['accounting_exports'], accountingRoutes, 'accounting'],
    [['attendance.biometric'], deviceIngestRoutes, 'devices'],
  ];
  for (const [keys, plugin, path] of modules) {
    if (!keys.some((k) => features.has(k))) continue;
    mounting = keys;
    await app.register(plugin, { prefix: `/api/v1/${path}` });
    mounting = null;
  }
  const brandFiles = registerBrandAssets(deps.brandDirOverride ?? BRAND_MOUNT, [env.BRAND_LOGO_URL, env.BRAND_LOGO_DARK_URL, env.BRAND_FAVICON_URL]);
  registerWeb(app, env.WEB_DIST_DIR ?? null, publicConfig, brandFiles);

  return app;
}
