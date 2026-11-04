import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withPlatformBypass, withTenant } from '../db/tx.js';
import { hashPassword, verifyPassword, sha256 } from '../core/crypto/index.js';
import { createSession, deriveCsrf, revokeSession, revokeAllSessionsForUser, SESSION_COOKIE } from '../core/auth/session.js';
import { audit } from '../core/audit/audit.js';
import { AppError, badRequest, unauthorized } from '../core/http/errors.js';
import { getSettingValue } from '../core/settings/service.js';
import { allOff, evaluateFeatures } from '../core/features/state.js';
import { requireTenantHost } from '../core/http/context.js';
import { roleGroup, viewsFor, SYSTEM_ROLE_MAP, permissionFeature } from '../core/auth/permissions.js';
import { currentMode } from '../core/policy/mode.js';
import type { PublicConfig } from '../config/installation.js';
import { notifyUsers } from '../core/notify/service.js';

const LoginBody = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()), password: z.string().min(1).max(256) });
const LOCK_MINUTES = 15;
const INVALID = 'Invalid email or password';

/** Paths a user with a pending forced password change may still call. */
export const PASSWORD_CHANGE_ALLOWED = new Set(['/api/v1/auth/me', '/api/v1/auth/password', '/api/v1/auth/logout', '/api/v1/auth/mfa/setup', '/api/v1/auth/mfa/enable']);

async function passwordMinLength(db: import('../db/tx.js').Db, tenantId: string) {
  return getSettingValue<number>(db, tenantId, 'security.password_min_length');
}

export async function authRoutes(app: FastifyInstance, opts: { publicConfig: PublicConfig }) {
  const { pool, env } = app.deps;
  const publicConfig = opts.publicConfig;

  const setCookie = (reply: FastifyReply, token: string, expires: Date) =>
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax', path: '/', expires });

  /**
   * Runtime configuration for the web app: brand, feature flags, mode and MFA from deployment configuration.
   * Public and non-sensitive by construction (see config/installation.ts). Lets one image serve any customer.
   */
  app.get('/config/public', async (req, reply) => {
    requireTenantHost(req);
    reply.header('cache-control', 'no-cache');
    return publicConfig;
  });

  // Per address (route config) and per account (preHandler, once the body is parsed): spreading guesses over many
  // addresses does not get more of them, and the hashing cost of each attempt stays bounded for any one account.
  const accountLimit = app.createRateLimit({ max: env.AUTH_ACCOUNT_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute',
    keyGenerator: (req) => `login:${req.headers.host ?? ''}:${String((req.body as { email?: unknown } | null)?.email ?? '').trim().toLowerCase()}` });
  const perAccount = async (req: FastifyRequest) => {
    const r = await accountLimit(req);
    if (!r.isAllowed && r.isExceeded) throw new AppError(429, 'rate_limited', 'Too many requests. Please slow down.');
  };
  app.post('/auth/login', { config: { rateLimit: { max: env.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } }, preHandler: perAccount }, async (req, reply) => {
    const body = LoginBody.parse(req.body);
    const tenant = requireTenantHost(req);
    const tenantId = tenant.id;
    const result = await withPlatformBypass(pool, async (db) => {
      const r = await db.query<{ id: string; password_hash: string | null; status: string; failed_logins: number; locked: boolean; must_change_password: boolean; mfa_on: boolean }>(
        `SELECT id, password_hash, status, failed_logins, must_change_password, mfa_enabled_at IS NOT NULL AS mfa_on, coalesce(locked_until > now(), false) AS locked
           FROM users WHERE tenant_id = $1 AND email = $2 FOR UPDATE`, [tenantId, body.email]);
      const u = r.rows[0];
      const ok = await verifyPassword(body.password, u?.password_hash ?? null);
      const maxFailed = await getSettingValue<number>(db, tenantId, 'security.max_failed_logins');
      if (!u || !ok || u.status !== 'active' || u.locked) {
        if (u && !ok && !u.locked) {
          const failed = u.failed_logins + 1;
          if (failed >= maxFailed) {
            await db.query(`UPDATE users SET failed_logins = 0, locked_until = now() + make_interval(mins => $2) WHERE id = $1`, [u.id, LOCK_MINUTES]);
          } else {
            await db.query('UPDATE users SET failed_logins = $2 WHERE id = $1', [u.id, failed]);
          }
        }
        await audit(db, { tenantId, actorId: u?.id ?? null, action: 'auth.login_failed', category: 'auth',
          metadata: { email: body.email, reason: !u ? 'unknown_user' : u.locked ? 'locked' : u.status !== 'active' ? 'inactive' : 'bad_password' },
          requestId: req.id, ip: req.ip });
        return null;
      }
      await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
      const ttl = await getSettingValue<number>(db, tenantId, 'security.session_ttl_hours');
      const s = await createSession(db, u.id, tenantId, Math.min(ttl, env.SESSION_TTL_HOURS), req.ip, req.headers['user-agent']);
      await audit(db, { tenantId, actorId: u.id, action: 'auth.login', category: 'auth', targetType: 'session', targetId: s.sessionId, requestId: req.id, ip: req.ip });
      return { ...s, mustChangePassword: u.must_change_password, mfaRequired: u.mfa_on };
    });
    if (!result) throw unauthorized(INVALID);
    setCookie(reply, result.token, result.expiresAt);
    return { csrfToken: result.csrf, expiresAt: result.expiresAt, passwordChangeRequired: result.mustChangePassword, mfaRequired: result.mfaRequired };
  });

  app.post('/auth/logout', async (req, reply) => {
    const u = req.ctx.user;
    if (u) {
      await withPlatformBypass(pool, async (db) => {
        await revokeSession(db, u.sessionId);
        await audit(db, { tenantId: u.tenantId, actorId: u.userId, action: 'auth.logout', category: 'auth', requestId: req.id, ip: req.ip });
      });
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const u = req.ctx.user;
    if (!u || !u.tenantId) throw unauthorized();
    const host = requireTenantHost(req);
    const token = req.cookies[SESSION_COOKIE]!;
    if (u.mfaPending) {
      return { user: { id: u.userId, email: u.email, displayName: u.displayName, employeeId: null }, passwordChangeRequired: u.mustChangePassword,
        mfa: { enabled: true, pending: true, enrollmentRequired: false }, roles: [], permissions: [], mode: currentMode(), views: [], salaryLevel: 0, csrfToken: deriveCsrf(token),
        organization: { id: host.id, name: host.name }, preferences: null, capabilities: {} };
    }
    const { features, timezone, dateFormat, emailNotifications } = await withTenant(pool, u.tenantId, async (db) => ({
      emailNotifications: (await db.query<{ e: boolean }>('SELECT email_notifications AS e FROM users WHERE id=$1', [u.userId])).rows[0]?.e ?? true,
      features: await evaluateFeatures(db, u.tenantId!),
      timezone: await getSettingValue<string>(db, u.tenantId!, 'general.timezone'),
      dateFormat: await getSettingValue<string>(db, u.tenantId!, 'general.date_format'),
    }));
    return {
      user: { id: u.userId, email: u.email, displayName: u.displayName, employeeId: u.employeeId },
      passwordChangeRequired: u.mustChangePassword,
      mfa: { enabled: u.mfaEnabled, pending: u.mfaPending, enrollmentRequired: u.mfaEnrollmentRequired },
      roles: u.roles.map((k) => ({ key: k, name: SYSTEM_ROLE_MAP.get(k)?.name ?? k, group: roleGroup(k) })),
      // One person may hold several roles: these are the views they can switch between.
      mode: currentMode(), views: viewsFor(u.roles, (p) => u.permissions.has(p) && !allOff(permissionFeature(p)), u.employeeId), salaryLevel: u.salaryLevel,
      permissions: [...u.permissions].filter((p) => !allOff(permissionFeature(p))).sort(),
      csrfToken: deriveCsrf(token),
      organization: { id: host.id, name: host.name },
      preferences: { timezone, dateFormat, emailNotifications },
      // Central capability map: the UI decides module visibility from this only.
      capabilities: Object.fromEntries([...features.values()].map((f) => [f.key, f.usable])),
    };
  });

  const PasswordBody = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1).max(256) });
  app.post('/auth/password', { config: { rateLimit: { max: Math.min(5, env.AUTH_RATE_LIMIT_PER_MINUTE), timeWindow: '1 minute' } } }, async (req) => {
    const u = req.ctx.user;
    if (!u || !u.tenantId) throw unauthorized();
    const body = PasswordBody.parse(req.body);
    await withPlatformBypass(pool, async (db) => {
      const minLen = await passwordMinLength(db, u.tenantId!);
      if (body.newPassword.length < minLen) throw badRequest(`Password must be at least ${minLen} characters`);
      if (body.newPassword === body.currentPassword) throw badRequest('The new password must be different from the current one');
      const r = await db.query<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [u.userId]);
      if (!(await verifyPassword(body.currentPassword, r.rows[0]?.password_hash ?? null))) throw badRequest('Current password is incorrect');
      await db.query('UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1', [u.userId, await hashPassword(body.newPassword)]);
      // Changing a password signs out every other session.
      await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [u.userId, u.sessionId]);
      await audit(db, { tenantId: u.tenantId, actorId: u.userId, action: 'auth.password_changed', category: 'security', requestId: req.id, ip: req.ip });
      // Security notice: always in-app; by email unless the user opted out of email notifications.
      await notifyUsers(db, u.tenantId!, [u.userId], { kind: 'security.password_changed', title: 'Your password was changed',
        body: 'If this was not you, contact your administrator immediately. All your other sessions were signed out.', link: '/account', actionLabel: 'Review account' });
    });
    return { ok: true };
  });

  app.put('/auth/preferences', async (req) => {
    const u = req.ctx.user;
    if (!u || !u.tenantId) throw unauthorized();
    const body = z.object({ emailNotifications: z.boolean().optional() }).parse(req.body);
    await withTenant(pool, u.tenantId, async (db) => {
      await db.query('UPDATE users SET email_notifications=coalesce($3, email_notifications), updated_at=now() WHERE tenant_id=$1 AND id=$2',
        [u.tenantId, u.userId, body.emailNotifications ?? null]);
      await audit(db, { tenantId: u.tenantId, actorId: u.userId, action: 'user.preferences_updated', category: 'data', metadata: body, requestId: req.id, ip: req.ip });
    });
    return { ok: true };
  });

  /**
   * Complete a one-time administrator setup link (issued only by the bootstrap
   * command). Single use, expiring, stored hashed. Does not sign the user in.
   */
  const SetupBody = z.object({ token: z.string().min(20).max(200), newPassword: z.string().min(1).max(256) });
  app.post('/auth/setup', { config: { rateLimit: { max: Math.min(10, env.AUTH_RATE_LIMIT_PER_MINUTE), timeWindow: '1 minute' } } }, async (req) => {
    const tenant = requireTenantHost(req);
    const body = SetupBody.parse(req.body);
    const accepted = await withTenant(pool, tenant.id, async (db) => {
      const t = await db.query<{ id: string; user_id: string; email: string }>(
        `SELECT t.id, t.user_id, u.email FROM admin_setup_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.tenant_id = $1 AND t.token_hash = $2 AND t.used_at IS NULL AND t.expires_at > now() FOR UPDATE OF t`, [tenant.id, sha256(body.token)]);
      const row = t.rows[0];
      if (!row) return false;
      const minLen = await passwordMinLength(db, tenant.id);
      if (body.newPassword.length < minLen) throw badRequest(`Password must be at least ${minLen} characters`);
      await db.query('UPDATE admin_setup_tokens SET used_at = now() WHERE id = $1', [row.id]);
      await db.query(`UPDATE users SET password_hash = $2, must_change_password = false, failed_logins = 0, locked_until = NULL, updated_at = now()
        WHERE tenant_id = $1 AND id = $3`, [tenant.id, await hashPassword(body.newPassword), row.user_id]);
      await revokeAllSessionsForUser(db, row.user_id);
      await audit(db, { tenantId: tenant.id, actorId: row.user_id, action: 'auth.setup_completed', category: 'security', targetType: 'user', targetId: row.user_id, requestId: req.id, ip: req.ip });
      return true;
    });
    if (!accepted) {
      // Recorded in its own transaction so the failed attempt is never rolled back out of the audit log.
      await withTenant(pool, tenant.id, (db) => audit(db, { tenantId: tenant.id, actorId: null, action: 'auth.setup_link_rejected', category: 'security', requestId: req.id, ip: req.ip }));
      throw new AppError(400, 'setup_link_invalid', 'This setup link is invalid, already used or expired. Ask your system operator for a new one.');
    }
    return { ok: true };
  });

  app.post('/auth/sessions/revoke-all', async (req, reply) => {
    const u = req.ctx.user;
    if (!u) throw unauthorized();
    await withPlatformBypass(pool, async (db) => {
      await revokeAllSessionsForUser(db, u.userId);
      await audit(db, { tenantId: u.tenantId, actorId: u.userId, action: 'auth.sessions_revoked', category: 'security', requestId: req.id, ip: req.ip });
    });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
