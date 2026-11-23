import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as R from '../core/http/responses.js';
import { z } from 'zod';
import { withPlatformBypass, withTenant, type Db } from '../db/tx.js';
import { hashPassword, randomToken, verifyPassword, needsRehash, sha256 } from '../core/crypto/index.js';
import { assertStrongPassword } from '../core/auth/password-policy.js';
import {
  createSession,
  deriveCsrf,
  rememberDevice,
  revokeOtherSessions,
  revokeSession,
  revokeAllSessionsForUser,
  rotateSession,
  DEVICE_COOKIE,
  SESSION_COOKIE,
} from '../core/auth/session.js';
import { clearLoginAccount, clearLoginPair, loginBlockedFor, loginKeys, recordLoginFailure } from '../core/auth/throttle.js';
import { audit } from '../core/audit/audit.js';
import { AppError, badRequest, notFound, unauthorized } from '../core/http/errors.js';
import { Uuid } from '../core/http/pagination.js';
import { perUserLimit } from '../core/http/limits.js';
import { getSettingValue } from '../core/settings/service.js';
import { allOff, evaluateFeatures } from '../core/features/state.js';
import { requireTenantHost } from '../core/http/context.js';
import { roleGroup, viewsFor, SYSTEM_ROLE_MAP, permissionFeature } from '../core/auth/permissions.js';
import { currentMode } from '../core/policy/mode.js';
import { holdsL4 } from '../core/policy/salary.js';
import { effectiveMethod, mfaPolicyOf } from '../core/auth/mfa.js';
import { sendEmailOtp, type OtpSend } from '../core/auth/email-otp.js';
import { emailLink, findLink, takeLink } from '../core/auth/links.js';
import type { PublicConfig } from '../config/installation.js';
import { notifyUsers } from '../core/notify/service.js';

const LoginBody = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()), password: z.string().min(1).max(256) });
const DEVICE_COOKIE_DAYS = 400;
const FORGOT_MIN_MS = 250;
const INVALID = 'Invalid email or password';

/** Paths a user with a pending forced password change may still call. */
export const PASSWORD_CHANGE_ALLOWED = new Set([
  '/api/v1/auth/me',
  '/api/v1/auth/password',
  '/api/v1/auth/logout',
  '/api/v1/auth/mfa/methods',
  '/api/v1/auth/mfa/setup',
  '/api/v1/auth/mfa/enable',
  '/api/v1/auth/mfa/email/setup',
  '/api/v1/auth/mfa/email/enable',
]);

async function passwordMinLength(db: Db, tenantId: string) {
  return getSettingValue<number>(db, tenantId, 'security.password_min_length');
}

const AuthPreferencesBody = z.object({ emailNotifications: z.boolean().optional() });
const AuthPasswordForgotBody = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()) });
const IdParams = z.object({ id: Uuid });
export async function authRoutes(app: FastifyInstance, opts: { publicConfig: PublicConfig }) {
  const { pool, env, cipher } = app.deps;
  const publicConfig = opts.publicConfig;
  const mfaPolicy = mfaPolicyOf(env);

  const setCookie = (reply: FastifyReply, token: string, expires: Date) =>
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax', path: '/', expires });
  const setDeviceCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(DEVICE_COOKIE, token, { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax', path: '/', maxAge: DEVICE_COOKIE_DAYS * 86400 });
  const sessionLimits = async (db: Db, tenantId: string) => ({
    ttlHours: Math.min(await getSettingValue<number>(db, tenantId, 'security.session_ttl_hours'), env.SESSION_TTL_HOURS),
    idleMinutes: await getSettingValue<number>(db, tenantId, 'security.session_idle_minutes'),
  });

  /**
   * Runtime configuration for the web app: brand, feature flags, mode and MFA from deployment configuration.
   * Public and non-sensitive by construction (see config/installation.ts). Lets one image serve any customer.
   */
  app.get('/config/public', { schema: { response: { 200: R.GetConfigPublic200 } } }, async (req, reply) => {
    requireTenantHost(req);
    reply.header('cache-control', 'no-cache');
    return publicConfig;
  });

  // Per address (route config), then per account: spreading guesses over many addresses does not get more of them, and the hashing cost of
  // each attempt stays bounded for any one account. The account limit is not spent by an address already backing off, or by a browser the
  // account already knows, so it does not hand a stranger a way to keep the owner out.
  const accountLimit = app.createRateLimit({
    max: env.AUTH_ACCOUNT_RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    keyGenerator: (req) =>
      `login:${req.headers.host ?? ''}:${String((req.body as { email?: unknown } | null)?.email ?? '')
        .trim()
        .toLowerCase()}`,
  });
  const perAccount = async (req: FastifyRequest) => {
    const r = await accountLimit(req);
    if (!r.isAllowed && r.isExceeded) throw new AppError(429, 'rate_limited', 'Too many requests. Please slow down.');
  };
  app.post(
    '/auth/login',
    { schema: { response: { 200: R.PostAuthLogin200 }, body: LoginBody }, config: { rateLimit: { max: env.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = LoginBody.parse(req.body);
      const tenant = requireTenantHost(req);
      const tenantId = tenant.id;
      const keys = loginKeys(tenantId, body.email, req.clientAddress);
      const deviceToken = req.cookies[DEVICE_COOKIE];
      const gate = await withPlatformBypass(pool, async (db) => {
        const known =
          !!deviceToken &&
          !!(
            await db.query(`SELECT 1 FROM user_devices d JOIN users u ON u.id=d.user_id WHERE u.tenant_id=$1 AND u.email=$2 AND d.device_hash=$3`, [
              tenantId,
              body.email,
              sha256(deviceToken),
            ])
          ).rowCount;
        return { known, wait: await loginBlockedFor(db, tenantId, keys, known) };
      });
      if (gate.wait) {
        reply.header('retry-after', String(gate.wait));
        throw new AppError(429, 'rate_limited', 'Too many attempts. Wait a moment and try again.');
      }
      if (!gate.known) await perAccount(req);
      // The hash runs with no transaction open: a sign-in costs a worker thread, and never holds a database connection or a row while it does.
      const u = await withPlatformBypass(
        pool,
        async (db) =>
          (
            await db.query<{
              id: string;
              password_hash: string | null;
              status: string;
              must_change_password: boolean;
              mfa_on: boolean;
              mfa_method: string | null;
              display_name: string;
            }>(
              `SELECT id, password_hash, status, must_change_password, display_name, mfa_enabled_at IS NOT NULL AS mfa_on, mfa_method
         FROM users WHERE tenant_id = $1 AND email = $2`,
              [tenantId, body.email],
            )
          ).rows[0],
      );
      const ok = await verifyPassword(body.password, u?.password_hash ?? null);
      const upgraded = ok && u?.password_hash && needsRehash(u.password_hash) ? await hashPassword(body.password) : null;
      const device = deviceToken ?? randomToken(24);
      const result = await withPlatformBypass(pool, async (db) => {
        if (!u || !ok || u.status !== 'active') {
          await recordLoginFailure(db, tenantId, keys, await getSettingValue<number>(db, tenantId, 'security.max_failed_logins'));
          await audit(db, {
            tenantId,
            actorId: u?.id ?? null,
            action: 'auth.login_failed',
            category: 'auth',
            metadata: {
              email: body.email,
              reason: !u ? 'unknown_user' : u.status !== 'active' ? 'inactive' : 'bad_password',
              backingOff: !!(await loginBlockedFor(db, tenantId, keys, false)),
            },
            requestId: req.id,
            ip: req.clientAddress,
          });
          return null;
        }
        await clearLoginPair(db, tenantId, keys);
        await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
        // Only if nobody changed it meanwhile.
        if (upgraded) await db.query('UPDATE users SET password_hash=$2 WHERE id=$1 AND password_hash=$3', [u.id, upgraded, u.password_hash]);
        // Signing in replaces whatever session this browser came with, so a token planted before sign-in is worth nothing after it.
        if (req.ctx.user) await revokeSession(db, req.ctx.user.sessionId);
        const s = await createSession(db, u.id, tenantId, await sessionLimits(db, tenantId), req.clientAddress, req.headers['user-agent']);
        await audit(db, {
          tenantId,
          actorId: u.id,
          action: 'auth.login',
          category: 'auth',
          targetType: 'session',
          targetId: s.sessionId,
          requestId: req.id,
          ip: req.clientAddress,
        });
        const { isNew } = await rememberDevice(db, tenantId, u.id, sha256(device));
        if (isNew) {
          await audit(db, {
            tenantId,
            actorId: u.id,
            action: 'auth.new_device',
            category: 'security',
            targetType: 'session',
            targetId: s.sessionId,
            requestId: req.id,
            ip: req.clientAddress,
            userAgent: req.headers['user-agent'],
          });
          await notifyUsers(db, tenantId, [u.id], {
            kind: 'security.new_device',
            title: 'New sign-in to your account',
            body: `From a browser we have not seen for this account, at address ${req.clientAddress}${req.headers['user-agent'] ? ` (${req.headers['user-agent'].replace(/[^\x20-\x7e]/g, '').slice(0, 120)})` : ''}. If this was not you, change your password now and sign out your other sessions.`,
            link: '/account',
            actionLabel: 'Review account',
          });
        }
        const method = effectiveMethod(mfaPolicy, u.mfa_on, u.mfa_method);
        // Email codes go out now, so the person has one by the time the next screen asks. An old one still pending is left alone by the resend limit.
        const delivery: OtpSend | null = method === 'email' ? await sendEmailOtp(db, cipher, tenantId, u.id, 'login') : null;
        return { ...s, mustChangePassword: u.must_change_password, mfaMethod: method, delivery: delivery?.state ?? null };
      });
      if (!result) throw unauthorized(INVALID);
      setCookie(reply, result.token, result.expiresAt);
      setDeviceCookie(reply, device);
      return {
        csrfToken: result.csrf,
        expiresAt: result.expiresAt,
        passwordChangeRequired: result.mustChangePassword,
        mfaRequired: !!result.mfaMethod,
        mfaMethod: result.mfaMethod,
        // Only for email codes: 'sent', 'wait' (one went out a moment ago), or 'unavailable' (email is down, so a recovery code is the way in).
        mfaDelivery: result.delivery,
      };
    },
  );

  app.post('/auth/logout', { schema: { response: { 200: R.PostAuthLogout200 } } }, async (req, reply) => {
    const u = req.ctx.user;
    if (u) {
      await withPlatformBypass(pool, async (db) => {
        await revokeSession(db, u.sessionId);
        await audit(db, { tenantId: u.tenantId, actorId: u.userId, action: 'auth.logout', category: 'auth', requestId: req.id, ip: req.clientAddress });
      });
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', { schema: { response: { 200: R.GetAuthMe200 } } }, async (req) => {
    const u = req.ctx.user;
    if (!u || !u.tenantId) throw unauthorized();
    const host = requireTenantHost(req);
    const token = req.cookies[SESSION_COOKIE]!;
    if (u.mfaPending) {
      return {
        user: { id: u.userId, email: u.email, displayName: u.displayName, employeeId: null },
        passwordChangeRequired: u.mustChangePassword,
        mfa: { enabled: true, pending: true, enrollmentRequired: false, method: u.mfaMethod, suggested: false },
        roles: [],
        permissions: [],
        mode: currentMode(),
        views: [],
        salaryLevel: 0,
        csrfToken: deriveCsrf(token),
        organization: { id: host.id, name: host.name },
        preferences: null,
        capabilities: {},
      };
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
      // `suggested` is a nudge for people who can read L4 data, and blocks nothing (D45).
      mfa: {
        enabled: u.mfaEnabled,
        pending: u.mfaPending,
        enrollmentRequired: u.mfaEnrollmentRequired,
        method: u.mfaMethod,
        suggested: env.MFA_AVAILABLE && !env.MFA_ENFORCED && !u.mfaEnabled && holdsL4({ has: (p) => u.permissions.has(p) }),
      },
      roles: u.roles.map((k) => ({ key: k, name: SYSTEM_ROLE_MAP.get(k)?.name ?? k, group: roleGroup(k) })),
      // One person may hold several roles: these are the views they can switch between.
      mode: currentMode(),
      views: viewsFor(u.roles, (p) => u.permissions.has(p) && !allOff(permissionFeature(p)), u.employeeId),
      salaryLevel: u.salaryLevel,
      permissions: [...u.permissions].filter((p) => !allOff(permissionFeature(p))).sort(),
      csrfToken: deriveCsrf(token),
      organization: { id: host.id, name: host.name },
      preferences: { timezone, dateFormat, emailNotifications },
      // Central capability map: the UI decides module visibility from this only.
      capabilities: Object.fromEntries([...features.values()].map((f) => [f.key, f.usable])),
    };
  });

  const PasswordBody = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1).max(256) });
  app.post(
    '/auth/password',
    {
      schema: { response: { 200: R.PostAuthPassword200 }, body: PasswordBody },
      config: { rateLimit: { max: Math.min(5, env.AUTH_RATE_LIMIT_PER_MINUTE), timeWindow: '1 minute' } },
      preHandler: perUserLimit(app, 'password', 5),
    },
    async (req, reply) => {
      const u = req.ctx.user;
      if (!u || !u.tenantId) throw unauthorized();
      const body = PasswordBody.parse(req.body);
      const current = await withPlatformBypass(
        pool,
        async (db) => (await db.query<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [u.userId])).rows[0]?.password_hash ?? null,
      );
      const minLen = await withPlatformBypass(pool, (db) => passwordMinLength(db, u.tenantId!));
      assertStrongPassword(body.newPassword, { minLength: minLen, email: u.email, displayName: u.displayName });
      if (body.newPassword === body.currentPassword) throw badRequest('The new password must be different from the current one');
      if (!(await verifyPassword(body.currentPassword, current))) throw badRequest('Current password is incorrect');
      const hash = await hashPassword(body.newPassword);
      const rotated = await withPlatformBypass(pool, async (db) => {
        await db.query('UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1', [u.userId, hash]);
        // Changing a password signs out every other session, and this one gets a new token.
        await revokeOtherSessions(db, u.userId, u.sessionId);
        // A link still in a mailbox would undo this.
        await db.query('UPDATE admin_setup_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [u.userId]);
        await audit(db, { tenantId: u.tenantId, actorId: u.userId, action: 'auth.password_changed', category: 'security', requestId: req.id, ip: req.clientAddress });
        await notifyUsers(db, u.tenantId!, [u.userId], {
          kind: 'security.password_changed',
          title: 'Your password was changed',
          body: 'If this was not you, contact your administrator immediately. All your other sessions were signed out.',
          link: '/account',
          actionLabel: 'Review account',
        });
        return rotateSession(db, u.sessionId);
      });
      setCookie(reply, rotated.token, rotated.expiresAt);
      return { ok: true, csrfToken: rotated.csrf };
    },
  );

  app.put('/auth/preferences', { schema: { response: { 200: R.PutAuthPreferences200 }, body: AuthPreferencesBody } }, async (req) => {
    const u = req.ctx.user;
    if (!u || !u.tenantId) throw unauthorized();
    const body = AuthPreferencesBody.parse(req.body);
    await withTenant(pool, u.tenantId, async (db) => {
      await db.query('UPDATE users SET email_notifications=coalesce($3, email_notifications), updated_at=now() WHERE tenant_id=$1 AND id=$2', [
        u.tenantId,
        u.userId,
        body.emailNotifications ?? null,
      ]);
      await audit(db, { tenantId: u.tenantId, actorId: u.userId, action: 'user.preferences_updated', category: 'data', metadata: body, requestId: req.id, ip: req.clientAddress });
    });
    return { ok: true };
  });

  /** Finishes a link: the password policy, then the hash with no transaction open, then one statement decides who gets the link. Does not sign the user in. */
  const finishLink = async (req: FastifyRequest, body: { token: string; newPassword: string }, purposes: readonly string[], invalid: AppError) => {
    const tenant = requireTenantHost(req);
    const reject = async () => {
      // Recorded on its own: the failed attempt is never rolled back out of the audit log.
      await withTenant(pool, tenant.id, (db) =>
        audit(db, { tenantId: tenant.id, actorId: null, action: 'auth.setup_link_rejected', category: 'security', requestId: req.id, ip: req.clientAddress }),
      );
      return invalid;
    };
    const found = await withTenant(pool, tenant.id, async (db) => {
      const link = await findLink(db, tenant.id, body.token, purposes);
      return link && { link, minLength: await passwordMinLength(db, tenant.id) };
    });
    if (!found) throw await reject();
    const { link, minLength } = found;
    assertStrongPassword(body.newPassword, { minLength, email: link.email, displayName: link.display_name });
    const hash = await hashPassword(body.newPassword);
    const taken = await withTenant(pool, tenant.id, async (db) => {
      if (!(await takeLink(db, link.id))) return false;
      await db.query(`UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE tenant_id = $1 AND id = $3`, [tenant.id, hash, link.user_id]);
      await db.query('UPDATE admin_setup_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [link.user_id]);
      await revokeAllSessionsForUser(db, link.user_id);
      await clearLoginAccount(db, tenant.id, link.email);
      await audit(db, {
        tenantId: tenant.id,
        actorId: link.user_id,
        action: link.purpose === 'reset' ? 'auth.password_reset' : 'auth.setup_completed',
        category: 'security',
        targetType: 'user',
        targetId: link.user_id,
        requestId: req.id,
        ip: req.clientAddress,
      });
      if (link.purpose === 'reset')
        await notifyUsers(db, tenant.id, [link.user_id], {
          kind: 'security.password_changed',
          title: 'Your password was changed',
          body: 'It was reset with a link sent to this address. All your sessions were signed out. If this was not you, contact your administrator immediately.',
          link: '/account',
          actionLabel: 'Review account',
        });
      return true;
    });
    if (!taken) throw await reject();
    return { ok: true };
  };

  const LinkBody = z.object({ token: z.string().min(20).max(200), newPassword: z.string().min(1).max(256) });
  const linkLimit = { rateLimit: { max: Math.min(10, env.AUTH_RATE_LIMIT_PER_MINUTE), timeWindow: '1 minute' } };

  /** A one-time setup link from the bootstrap command, or an invitation. */
  app.post('/auth/setup', { schema: { response: { 200: R.PostAuthSetup200 }, body: LinkBody }, config: linkLimit }, async (req) =>
    finishLink(
      req,
      LinkBody.parse(req.body),
      ['setup', 'invite'],
      new AppError(400, 'setup_link_invalid', 'This setup link is invalid, already used or expired. Ask for a new one.'),
    ),
  );

  app.post('/auth/password/reset', { schema: { response: { 200: R.PostAuthPasswordReset200 }, body: LinkBody }, config: linkLimit }, async (req) =>
    finishLink(req, LinkBody.parse(req.body), ['reset'], new AppError(400, 'reset_link_invalid', 'This link is invalid, already used or expired. Ask for a new one.')),
  );

  /**
   * Always the same answer in about the same time, whether or not the address has an account: the response is held to a fixed minimum, which covers
   * the work of queueing a mail. Sends nothing to a disabled account, past the hourly limit, or without a mail transport, and says nothing about that either.
   */
  app.post(
    '/auth/password/forgot',
    {
      schema: { response: { 200: R.PostAuthPasswordForgot200 }, body: AuthPasswordForgotBody },
      config: { rateLimit: { max: Math.min(5, env.AUTH_RATE_LIMIT_PER_MINUTE), timeWindow: '1 minute' } },
    },
    async (req) => {
      const started = performance.now();
      const { email } = AuthPasswordForgotBody.parse(req.body);
      const tenant = requireTenantHost(req);
      try {
        await withTenant(pool, tenant.id, async (db) => {
          const u = (await db.query<{ id: string }>(`SELECT id FROM users WHERE tenant_id=$1 AND email=$2 AND status='active'`, [tenant.id, email])).rows[0];
          const result = u ? await emailLink(db, tenant.id, u.id, 'reset') : null;
          await audit(db, {
            tenantId: tenant.id,
            actorId: u?.id ?? null,
            action: 'auth.password_reset_requested',
            category: 'security',
            metadata: { result: result ?? 'no_account' },
            requestId: req.id,
            ip: req.clientAddress,
          });
        });
      } catch (e) {
        req.log.error({ err: (e as Error).message }, 'password reset request failed');
      }
      const wait = FORGOT_MIN_MS - (performance.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      return { ok: true };
    },
  );

  /** This user's active sessions, newest first. */
  app.get('/auth/sessions', { schema: { response: { 200: R.GetAuthSessions200 } } }, async (req) => {
    const u = req.ctx.user;
    if (!u) throw unauthorized();
    return withPlatformBypass(pool, async (db) => ({
      items: (
        await db.query(
          `SELECT id, ip, user_agent, created_at, last_seen_at, expires_at, id = $2 AS current, mfa_verified_at IS NOT NULL AS mfa_verified
      FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now() AND last_seen_at > now() - make_interval(mins => idle_timeout_minutes) ORDER BY last_seen_at DESC LIMIT 100`,
          [u.userId, u.sessionId],
        )
      ).rows,
    }));
  });

  /** End one of this user's sessions. Someone else's does not exist. */
  app.delete('/auth/sessions/:id', { schema: { response: { 200: R.DeleteAuthSessionsById200 }, params: IdParams } }, async (req, reply) => {
    const u = req.ctx.user;
    if (!u) throw unauthorized();
    const { id } = IdParams.parse(req.params);
    await withPlatformBypass(pool, async (db) => {
      const r = await db.query('UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL', [id, u.userId]);
      if (!r.rowCount) throw notFound('Session not found');
      await audit(db, {
        tenantId: u.tenantId,
        actorId: u.userId,
        action: 'auth.session_revoked',
        category: 'security',
        targetType: 'session',
        targetId: id,
        requestId: req.id,
        ip: req.clientAddress,
      });
    });
    if (id === u.sessionId) reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  /** Log out everywhere, this browser included. */
  app.post('/auth/sessions/revoke-all', { schema: { response: { 200: R.PostAuthSessionsRevokeAll200 } } }, async (req, reply) => {
    const u = req.ctx.user;
    if (!u) throw unauthorized();
    await withPlatformBypass(pool, async (db) => {
      await revokeAllSessionsForUser(db, u.userId);
      await audit(db, { tenantId: u.tenantId, actorId: u.userId, action: 'auth.sessions_revoked', category: 'security', requestId: req.id, ip: req.clientAddress });
    });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
