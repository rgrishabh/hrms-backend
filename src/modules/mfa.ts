import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as R from '../core/http/responses.js';
import { z } from 'zod';
import { withPlatformBypass, type Db } from '../db/tx.js';
import { AppError, badRequest, conflict, unauthorized } from '../core/http/errors.js';
import { audit } from '../core/audit/audit.js';
import { sha256, verifyPassword } from '../core/crypto/index.js';
import { newTotpSecret, otpauthUri, verifyTotp, newRecoveryCodes } from '../core/auth/totp.js';
import { effectiveMethod, mfaPolicyOf, MFA_USER_LOCK_MINUTES, MFA_USER_MAX_FAILURES, type MfaMethod } from '../core/auth/mfa.js';
import { revokeOtherSessions, rotateSession, SESSION_COOKIE } from '../core/auth/session.js';
import { sendEmailOtp, verifyEmailOtp, type OtpSend } from '../core/auth/email-otp.js';
import { notifyUsers } from '../core/notify/service.js';
import { getMailer } from '../core/notify/mailer.js';
import { perUserLimit } from '../core/http/limits.js';
import type { PublicConfig } from '../config/installation.js';

const MAX_FAILURES = 5;
const Code = z.string().trim().min(6).max(20);
const NO_EMAIL = 'Email codes need email to be set up on this installation, and it is not. Ask your administrator, or use an authenticator app.';

const VerifyBody = z.object({ code: Code });
const DisableBody = z.object({ password: z.string().min(1), code: Code });
/**
 * Two-factor authentication. Mounted only when MFA_AVAILABLE=true, so otherwise every address here is a 404. TOTP secrets are encrypted with
 * the installation's field key, and a code can't be replayed. Recovery codes are stored hashed and work once. Five wrong codes end the session,
 * and ten across sessions stop the second factor answering for a while.
 */
export async function mfaRoutes(app: FastifyInstance, opts: { publicConfig: PublicConfig }) {
  const { pool, cipher, env } = app.deps;
  const issuer = opts.publicConfig.product.name;
  const policy = mfaPolicyOf(env);
  const offers = (m: MfaMethod) => policy.methods.includes(m);
  const guesses = perUserLimit(app, 'mfa-guess', 10);
  const sends = perUserLimit(app, 'mfa-send', 5);

  const actor = (req: FastifyRequest) => {
    const u = req.ctx.user;
    if (!u || !u.tenantId) throw unauthorized();
    return { u, tenantId: u.tenantId, base: { tenantId: u.tenantId, actorId: u.userId, requestId: req.id, ip: req.ctx.ip } };
  };
  const setCookie = (reply: FastifyReply, token: string, expires: Date) =>
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax', path: '/', expires });

  type Mfa = { on: boolean; method: string | null; secret: string | null; hashes: string[]; lastStep: string | null; locked: boolean };
  const loadMfa = async (db: Db, userId: string): Promise<Mfa> => {
    const r = (
      await db.query<{ on: boolean; mfa_method: string | null; mfa_secret_enc: string | null; mfa_recovery_hashes: string[]; mfa_last_step: string | null; locked: boolean }>(
        `SELECT mfa_enabled_at IS NOT NULL AS on, mfa_method, mfa_secret_enc, mfa_recovery_hashes, mfa_last_step, coalesce(mfa_locked_until > now(), false) AS locked FROM users WHERE id=$1 FOR UPDATE`,
        [userId],
      )
    ).rows[0]!;
    return { on: r.on, method: r.mfa_method, secret: r.mfa_secret_enc, hashes: r.mfa_recovery_hashes, lastStep: r.mfa_last_step, locked: r.locked };
  };

  /** A code against this user's method, or a recovery code. Consumes what it accepts, and records the TOTP step. Answers null for anything else. */
  async function checkCode(db: Db, userId: string, m: Mfa, code: string): Promise<MfaMethod | 'recovery' | null> {
    const method = effectiveMethod(policy, m.on, m.method);
    if (method === 'totp' && m.secret) {
      const step = verifyTotp(cipher.decrypt(m.secret), code);
      if (step !== null) {
        if (m.lastStep !== null && step <= Number(m.lastStep)) return null; // replay
        await db.query('UPDATE users SET mfa_last_step=$2 WHERE id=$1', [userId, step]);
        return 'totp';
      }
    }
    // Six digits are a code to spend a guess on; anything else is a recovery code and spends none.
    if (method === 'email' && /^\d{6}$/.test(code) && (await verifyEmailOtp(db, cipher, userId, 'login', code))) return 'email';
    const h = sha256(code.toLowerCase().replace(/\s/g, ''));
    if (m.hashes.includes(h)) {
      await db.query('UPDATE users SET mfa_recovery_hashes = array_remove(mfa_recovery_hashes, $2) WHERE id=$1', [userId, h]);
      return 'recovery';
    }
    return null;
  }
  const noteFailure = (db: Db, userId: string) =>
    db.query(
      `UPDATE users SET mfa_failures = CASE WHEN mfa_failures + 1 >= ${MFA_USER_MAX_FAILURES} THEN 0 ELSE mfa_failures + 1 END,
    mfa_locked_until = CASE WHEN mfa_failures + 1 >= ${MFA_USER_MAX_FAILURES} THEN now() + make_interval(mins => ${MFA_USER_LOCK_MINUTES}) ELSE mfa_locked_until END WHERE id=$1`,
      [userId],
    );
  const noteSuccess = (db: Db, userId: string) => db.query('UPDATE users SET mfa_failures=0, mfa_locked_until=NULL WHERE id=$1', [userId]);
  const lockedError = () => new AppError(429, 'mfa_locked', `Too many incorrect codes. Try again in ${MFA_USER_LOCK_MINUTES} minutes, or ask your administrator.`);
  const invalidCode = (hint = 'Check your code and try again.') => new AppError(400, 'mfa_invalid', `That code is not valid. ${hint}`);

  /** What this deployment offers, and whether each can be used right now: the enrolment screen says so before anyone tries. */
  app.get('/methods', { schema: { response: { 200: R.GetAuthMfaMethods200 } } }, async (req) => {
    const { u } = actor(req);
    const left = await withPlatformBypass(
      pool,
      async (db) => (await db.query<{ n: number }>('SELECT cardinality(mfa_recovery_hashes) AS n FROM users WHERE id=$1', [u.userId])).rows[0]!.n,
    );
    return {
      enabled: u.mfaEnabled,
      method: u.mfaMethod,
      recoveryCodesLeft: u.mfaEnabled ? left : 0,
      enforced: policy.enforced,
      methods: policy.methods.map((method) => (method === 'email' && !getMailer() ? { method, usable: false, reason: NO_EMAIL } : { method, usable: true })),
    };
  });

  app.post(
    '/verify',
    {
      schema: { response: { 200: R.PostAuthMfaVerify200 }, body: VerifyBody },
      config: { rateLimit: { max: env.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } },
      preHandler: guesses,
    },
    async (req, reply) => {
      const { u, tenantId, base } = actor(req);
      const { code } = VerifyBody.parse(req.body);
      if (!u.mfaPending) throw conflict('This session does not need a code');
      const result = await withPlatformBypass(pool, async (db) => {
        const m = await loadMfa(db, u.userId);
        if (m.locked) return { ok: false as const, locked: true };
        const kind = await checkCode(db, u.userId, m, code);
        if (kind) {
          await noteSuccess(db, u.userId);
          await db.query('UPDATE sessions SET mfa_verified_at=now(), mfa_failures=0 WHERE id=$1', [u.sessionId]);
          await audit(db, { ...base, action: 'auth.mfa_verified', category: 'auth', metadata: { method: kind } });
          if (kind === 'recovery') {
            const left = (await db.query<{ n: number }>('SELECT cardinality(mfa_recovery_hashes) AS n FROM users WHERE id=$1', [u.userId])).rows[0]!.n;
            await notifyUsers(db, tenantId, [u.userId], {
              kind: 'security.recovery_code_used',
              title: 'A recovery code was used to sign in',
              body: `${left} recovery code(s) left. If this was not you, contact your administrator.`,
              link: '/account',
              actionLabel: 'Review account',
            });
          }
          // A second factor raises what this session can do: new token.
          return { ok: true as const, method: kind, rotated: await rotateSession(db, u.sessionId) };
        }
        await noteFailure(db, u.userId);
        const f = (await db.query<{ mfa_failures: number }>('UPDATE sessions SET mfa_failures=mfa_failures+1 WHERE id=$1 RETURNING mfa_failures', [u.sessionId])).rows[0]!
          .mfa_failures;
        await audit(db, { ...base, action: 'auth.mfa_failed', category: 'auth', metadata: { failures: f } });
        if (f >= MAX_FAILURES) await db.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [u.sessionId]);
        return { ok: false as const, ended: f >= MAX_FAILURES };
      });
      if (!result.ok) {
        if ('locked' in result) throw lockedError();
        if (result.ended) {
          reply.clearCookie(SESSION_COOKIE, { path: '/' });
          throw unauthorized('Too many incorrect codes. Sign in again.');
        }
        throw invalidCode(u.mfaMethod === 'email' ? 'Check the latest email we sent you.' : 'Check your authenticator app and try again.');
      }
      setCookie(reply, result.rotated.token, result.rotated.expiresAt);
      return { ok: true, method: result.method, csrfToken: result.rotated.csrf };
    },
  );

  /** Turning it on: recovery codes, other sessions end, and this one gets a new token. */
  const enable = async (
    db: Db,
    u: { userId: string; sessionId: string },
    tenantId: string,
    base: { tenantId: string; actorId: string; requestId: string; ip: string },
    method: MfaMethod,
    set: { secret?: string; step?: number },
  ) => {
    const codes = newRecoveryCodes();
    await db.query(
      `UPDATE users SET mfa_method=$2, mfa_secret_enc=$3, mfa_pending_secret_enc=NULL, mfa_enabled_at=now(), mfa_last_step=$4, mfa_recovery_hashes=$5, mfa_failures=0, mfa_locked_until=NULL WHERE id=$1`,
      [u.userId, method, set.secret ?? null, set.step ?? null, codes.map((c) => sha256(c))],
    );
    await db.query('UPDATE sessions SET mfa_verified_at=now() WHERE id=$1', [u.sessionId]);
    await revokeOtherSessions(db, u.userId, u.sessionId);
    await audit(db, { ...base, action: 'auth.mfa_enabled', category: 'security', metadata: { method } });
    await notifyUsers(db, tenantId, [u.userId], {
      kind: 'security.mfa_enabled',
      title: 'Two-factor authentication was turned on',
      body: 'If this was not you, contact your administrator immediately. Your other sessions were signed out.',
      link: '/account',
    });
    return { codes, rotated: await rotateSession(db, u.sessionId) };
  };
  const assertNotEnrolled = (m: Mfa) => {
    if (effectiveMethod(policy, m.on, m.method)) throw conflict('Two-factor authentication is already on');
  };
  const waitOr = (reply: FastifyReply, s: OtpSend) => {
    if (s.state === 'unavailable') throw new AppError(409, 'feature_not_configured', NO_EMAIL);
    if (s.state === 'wait') {
      reply.header('retry-after', String(s.retryAfter));
      throw new AppError(429, 'rate_limited', `Please wait ${s.retryAfter} seconds before asking for another code.`);
    }
  };

  if (offers('totp')) {
    app.post('/setup', { schema: { response: { 200: R.PostAuthMfaSetup200 } } }, async (req) => {
      const { u, base } = actor(req);
      return withPlatformBypass(pool, async (db) => {
        assertNotEnrolled(await loadMfa(db, u.userId));
        const secret = newTotpSecret();
        await db.query('UPDATE users SET mfa_pending_secret_enc=$2 WHERE id=$1', [u.userId, cipher.encrypt(secret)]);
        await audit(db, { ...base, action: 'auth.mfa_setup_started', category: 'security' });
        return { secret, otpauthUri: otpauthUri(secret, u.email, issuer) };
      });
    });

    app.post(
      '/enable',
      {
        schema: { response: { 200: R.PostAuthMfaEnable200 }, body: VerifyBody },
        config: { rateLimit: { max: env.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } },
        preHandler: guesses,
      },
      async (req, reply) => {
        const { u, tenantId, base } = actor(req);
        const { code } = VerifyBody.parse(req.body);
        const { codes, rotated } = await withPlatformBypass(pool, async (db) => {
          assertNotEnrolled(await loadMfa(db, u.userId));
          const p = (await db.query<{ p: string | null }>('SELECT mfa_pending_secret_enc AS p FROM users WHERE id=$1', [u.userId])).rows[0]!.p;
          if (!p) throw badRequest('Start the setup first');
          const secret = cipher.decrypt(p);
          const step = verifyTotp(secret, code);
          if (step === null) throw invalidCode('Check the time on your phone and try again.');
          return enable(db, u, tenantId, base, 'totp', { secret: cipher.encrypt(secret), step });
        });
        setCookie(reply, rotated.token, rotated.expiresAt);
        return { recoveryCodes: codes, csrfToken: rotated.csrf };
      },
    );
  }

  if (offers('email')) {
    /** Sends a code to the account's address, to prove it receives mail before relying on it. */
    app.post(
      '/email/setup',
      { schema: { response: { 200: R.PostAuthMfaEmailSetup200 } }, config: { rateLimit: { max: env.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } }, preHandler: sends },
      async (req, reply) => {
        const { u, tenantId, base } = actor(req);
        const s = await withPlatformBypass(pool, async (db) => {
          assertNotEnrolled(await loadMfa(db, u.userId));
          const sent = await sendEmailOtp(db, cipher, tenantId, u.userId, 'enrol');
          if (sent.state === 'sent') await audit(db, { ...base, action: 'auth.mfa_setup_started', category: 'security', metadata: { method: 'email' } });
          return sent;
        });
        waitOr(reply, s);
        return { sent: true };
      },
    );

    app.post(
      '/email/enable',
      {
        schema: { response: { 200: R.PostAuthMfaEmailEnable200 }, body: VerifyBody },
        config: { rateLimit: { max: env.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } },
        preHandler: guesses,
      },
      async (req, reply) => {
        const { u, tenantId, base } = actor(req);
        const { code } = VerifyBody.parse(req.body);
        // A wrong code is kept: the guess must count, so the answer comes after the commit.
        const out = await withPlatformBypass(pool, async (db) => {
          assertNotEnrolled(await loadMfa(db, u.userId));
          if (!(await verifyEmailOtp(db, cipher, u.userId, 'enrol', code))) return null;
          return enable(db, u, tenantId, base, 'email', {});
        });
        if (!out) throw invalidCode('Check the latest email we sent you.');
        setCookie(reply, out.rotated.token, out.rotated.expiresAt);
        return { recoveryCodes: out.codes, csrfToken: out.rotated.csrf };
      },
    );

    /** Another code, for a sign-in in progress or for turning this off. */
    app.post('/email/send', { schema: {}, config: { rateLimit: { max: env.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } }, preHandler: sends }, async (req, reply) => {
      const { u, tenantId } = actor(req);
      if (u.mfaMethod !== 'email') throw conflict('This account does not use email codes');
      waitOr(reply, await withPlatformBypass(pool, (db) => sendEmailOtp(db, cipher, tenantId, u.userId, 'login')));
      return { sent: true };
    });
  }

  app.post('/recovery-codes', { schema: { body: VerifyBody }, config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, preHandler: sends }, async (req) => {
    const { u, base } = actor(req);
    const { code } = VerifyBody.parse(req.body);
    const out = await withPlatformBypass(pool, async (db) => {
      const m = await loadMfa(db, u.userId);
      if (m.locked) return 'locked' as const;
      const kind = await checkCode(db, u.userId, m, code);
      if (kind !== 'totp' && kind !== 'email') {
        await noteFailure(db, u.userId);
        return null;
      }
      await noteSuccess(db, u.userId);
      const codes = newRecoveryCodes();
      await db.query('UPDATE users SET mfa_recovery_hashes=$2 WHERE id=$1', [u.userId, codes.map((c) => sha256(c))]);
      await audit(db, { ...base, action: 'auth.mfa_recovery_codes_regenerated', category: 'security' });
      return codes;
    });
    if (out === 'locked') throw lockedError();
    if (!out) throw invalidCode('Enter a current code, not a recovery code.');
    return { recoveryCodes: out };
  });

  app.post(
    '/disable',
    { schema: { response: { 200: R.PostAuthMfaDisable200 }, body: DisableBody }, config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, preHandler: sends },
    async (req, reply) => {
      const { u, tenantId, base } = actor(req);
      const body = DisableBody.parse(req.body);
      if (policy.enforced) throw new AppError(403, 'mfa_required_by_deployment', 'Two-factor authentication is required on this installation; it cannot be turned off.');
      const hash = await withPlatformBypass(
        pool,
        async (db) => (await db.query<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id=$1', [u.userId])).rows[0]?.password_hash ?? null,
      );
      if (!(await verifyPassword(body.password, hash))) throw badRequest('Password is incorrect');
      const out = await withPlatformBypass(pool, async (db) => {
        const m = await loadMfa(db, u.userId);
        if (m.locked) return 'locked' as const;
        if (!(await checkCode(db, u.userId, m, body.code))) {
          await noteFailure(db, u.userId);
          return null;
        }
        await db.query(
          `UPDATE users SET mfa_secret_enc=NULL, mfa_pending_secret_enc=NULL, mfa_enabled_at=NULL, mfa_method=NULL, mfa_recovery_hashes='{}', mfa_last_step=NULL, mfa_failures=0, mfa_locked_until=NULL WHERE id=$1`,
          [u.userId],
        );
        await revokeOtherSessions(db, u.userId, u.sessionId);
        await audit(db, { ...base, action: 'auth.mfa_disabled', category: 'security' });
        await notifyUsers(db, tenantId, [u.userId], {
          kind: 'security.mfa_disabled',
          title: 'Two-factor authentication was turned off',
          body: 'If this was not you, contact your administrator immediately. Your other sessions were signed out.',
          link: '/account',
        });
        return rotateSession(db, u.sessionId);
      });
      if (out === 'locked') throw lockedError();
      if (!out) throw invalidCode();
      setCookie(reply, out.token, out.expiresAt);
      return { ok: true, csrfToken: out.csrf };
    },
  );
}
