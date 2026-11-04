import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { resolveHost } from './core/tenancy/resolve.js';
import { loadSession, SESSION_COOKIE } from './core/auth/session.js';
import { sha256, safeEqualHex } from './core/crypto/index.js';
import { AppError } from './core/http/errors.js';
import type { AppDeps } from './core/http/context.js';
import { setDeploymentDefaults, setDeploymentLimits } from './core/settings/service.js';
import { resolveEnabledModules, setEnabledModules } from './core/features/state.js';
import { authRoutes, PASSWORD_CHANGE_ALLOWED } from './modules/auth.js';
import { setMfaFloor, MFA_PENDING_ALLOWED, MFA_ENROLL_ALLOWED } from './core/auth/mfa.js';
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
import { assetRoutes } from './modules/assets/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { dashboardRoutes } from './modules/dashboard/routes.js';
import { createStore, setStore, getStore } from './core/storage/index.js';
import { setStorageConfigured } from './core/features/state.js';
import { setEmailBrand } from './core/notify/service.js';
import { createMailer, setMailer, getMailer } from './core/notify/mailer.js';
import { setEmailTransportConfigured } from './core/features/state.js';
import { registerWeb, registerBrandingAssets, spaCsp, API_CSP, ASSET_CSP } from './core/http/web.js';
import { buildPublicConfig } from './config/installation.js';
import { migrationStatus } from './db/migrate.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { env } = deps;
  // Deployment configuration is validated here; invalid module sets stop the process.
  setEnabledModules(resolveEnabledModules(env.ENABLED_MODULES));
  setDeploymentLimits({ sessionTtlHours: env.SESSION_TTL_HOURS });
  setMfaFloor(env.MFA_ENFORCEMENT);
  setDeploymentDefaults({ 'general.timezone': env.ORGANIZATION_TIMEZONE, 'general.date_format': env.ORGANIZATION_DATE_FORMAT });
  const publicConfig = buildPublicConfig(env);
  setEmailBrand({ brandName: publicConfig.brand.name, productName: publicConfig.product.name, primaryColor: publicConfig.brand.primaryColor,
    supportEmail: publicConfig.brand.supportEmail, appUrl: env.APP_URL });

  const SPA_CSP = spaCsp([publicConfig.brand.logoUrl, publicConfig.brand.faviconUrl]);

  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : {
      level: env.LOG_LEVEL,
      // Never log credentials or session material.
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-device-key"]', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
    },
    trustProxy: env.TRUST_PROXY,
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
  });
  app.decorate('deps', deps);
  if (!deps.mailerOverride) setMailer(createMailer(env, app.log));
  setEmailTransportConfigured(!!getMailer());
  if (!deps.storeOverride) setStore(createStore(env));
  setStorageConfigured(!!getStore());
  app.decorateRequest('ctx', null as never);

  await app.register(cookie);
  // CSP is set per response: strict 'none' for API/JSON, sandboxed for branding files, same-origin for the SPA.
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-origin' } });
  app.addHook('onSend', async (req, reply) => {
    const u = req.url;
    reply.header('content-security-policy', u.startsWith('/api/') || u.startsWith('/health') || u === '/ready' ? API_CSP : u.startsWith('/branding/') ? ASSET_CSP : SPA_CSP);
  });
  await app.register(rateLimit, { global: true, max: env.RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: env.STORAGE_MAX_FILE_MB * 1024 * 1024, files: 1, fields: 10, parts: 12, fieldSize: 10_000 } });

  // Liveness/readiness are host-agnostic and unauthenticated; they reveal no internals.
  // `/health` and `/ready` are aliases for orchestrators and the deployment smoke tests.
  const live = async () => ({ status: 'ok' });
  let warnedNewerSchema = false;
  app.get('/health/live', live);
  app.get('/health', live);
  const ready = async (_req: unknown, reply: import('fastify').FastifyReply) => {
    try {
      const m = await migrationStatus(deps.pool);
      // Pending migrations: this build needs a newer schema -> not ready. Unknown (newer) migrations are
      // expected after a rollback to the previous release; migrations are expand/contract, so serve.
      if (m.pending.length) return reply.code(503).send({ status: 'unavailable' });
      if (m.unknown.length && !warnedNewerSchema) { warnedNewerSchema = true; app.log.warn({ unknown: m.unknown }, 'database schema is newer than this build (rollback?)'); }
      const org = await deps.pool.query<{ ok: boolean }>('SELECT EXISTS (SELECT 1 FROM tenants) AS ok');
      if (!org.rows[0]!.ok) return reply.code(503).send({ status: 'unavailable' });
      return { status: 'ready' };
    } catch { return reply.code(503).send({ status: 'unavailable' }); }
  };
  app.get('/health/ready', ready);
  app.get('/ready', ready);

  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/health') || req.url === '/ready') return;
    if (!req.url.startsWith('/api/')) { req.ctx = { requestId: req.id, ip: req.ip, host: { kind: 'unknown', host: '' }, user: null }; return; }
    const host = await resolveHost(deps.pool, req.headers.host);
    req.ctx = { requestId: req.id, ip: req.ip, host, user: null };
    const token = req.cookies[SESSION_COOKIE];
    if (token && host.kind === 'tenant') {
      req.ctx.user = await loadSession(deps.pool, token, host.tenant.id);
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
        throw new AppError(403, 'mfa_required', 'Enter the code from your authenticator app to continue.');
      }
      if (req.ctx.user?.mfaEnrollmentRequired && !MFA_ENROLL_ALLOWED.has(path)) {
        throw new AppError(403, 'mfa_enrollment_required', 'Your role requires two-factor authentication. Set it up to continue.');
      }
      // Forced password change (bootstrap admin, admin resets): nothing else until it is done.
      if (req.ctx.user?.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(path)) {
        throw new AppError(403, 'password_change_required', 'You must change your password before continuing.');
      }
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'validation_failed', message: 'Some fields are invalid',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    }
    const e = err as { statusCode?: number; code?: string; message: string; constraint?: string };
    if (e.statusCode === 429) return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many requests. Please slow down.' } });
    if (e.code === '23505') {
      return reply.code(409).send({ error: { code: 'duplicate', message: 'A record with these details already exists', details: { constraint: e.constraint } } });
    }
    if (e.code === '23503') return reply.code(400).send({ error: { code: 'invalid_reference', message: 'A referenced record does not exist' } });
    if (e.code === '23514') return reply.code(400).send({ error: { code: 'constraint_violation', message: 'The values violate a data rule', details: { constraint: e.constraint } } });
    if (e.statusCode && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: e.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong. Reference: ' + req.id } });
  });

  await app.register(authRoutes, { prefix: '/api/v1', publicConfig });
  await app.register(mfaRoutes, { prefix: '/api/v1/auth/mfa', publicConfig });
  await app.register(tenantAdminRoutes, { prefix: '/api/v1/tenant', publicConfig });
  await app.register(orgRoutes, { prefix: '/api/v1/org' });
  await app.register(employeeRoutes, { prefix: '/api/v1/employees' });
  await app.register(attendanceRoutes, { prefix: '/api/v1/attendance' });
  await app.register(approvalRoutes, { prefix: '/api/v1/approvals' });
  await app.register(leaveRoutes, { prefix: '/api/v1/leave' });
  await app.register(notificationRoutes, { prefix: '/api/v1/notifications' });
  await app.register(documentRoutes, { prefix: '/api/v1/documents' });
  await app.register(expenseRoutes, { prefix: '/api/v1/expenses' });
  await app.register(competencyRoutes, { prefix: '/api/v1/competency' });
  await app.register(policyRoutes, { prefix: '/api/v1/policies' });
  await app.register(recruitmentRoutes, { prefix: '/api/v1/recruitment' });
  await app.register(lifecycleRoutes, { prefix: '/api/v1/lifecycle' });
  await app.register(payrollRoutes, { prefix: '/api/v1/payroll' });
  await app.register(caseRoutes, { prefix: '/api/v1/cases' });
  await app.register(performanceRoutes, { prefix: '/api/v1/performance' });
  await app.register(assetRoutes, { prefix: '/api/v1/assets' });
  await app.register(overtimeRoutes, { prefix: '/api/v1/overtime' });
  await app.register(fieldDutyRoutes, { prefix: '/api/v1/field-duty' });
  await app.register(travelRoutes, { prefix: '/api/v1/travel' });
  await app.register(reportRoutes, { prefix: '/api/v1/reports' });
  await app.register(dashboardRoutes, { prefix: '/api/v1/dashboard' });
  await app.register(deviceIngestRoutes, { prefix: '/api/v1/devices' });
  const branding = env.BRANDING_DIR ? registerBrandingAssets(env.BRANDING_DIR, [env.BRAND_LOGO_URL, env.BRAND_FAVICON_URL]) : null;
  registerWeb(app, env.WEB_DIST_DIR ?? null, publicConfig, branding);

  return app;
}
