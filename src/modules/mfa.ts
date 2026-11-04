import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withPlatformBypass, withTenant, type Db } from '../db/tx.js';
import { AppError, badRequest, conflict, forbidden, unauthorized } from '../core/http/errors.js';
import { audit } from '../core/audit/audit.js';
import { sha256, verifyPassword } from '../core/crypto/index.js';
import { newTotpSecret, otpauthUri, verifyTotp, newRecoveryCodes } from '../core/auth/totp.js';
import { effectiveMfaLevel, mfaRequiredFor } from '../core/auth/mfa.js';
import { SESSION_COOKIE } from '../core/auth/session.js';
import { notifyUsers } from '../core/notify/service.js';
import type { PublicConfig } from '../config/installation.js';

const MAX_FAILURES = 5;
const Code = z.string().trim().min(6).max(20);

/**
 * Two-factor authentication (TOTP). Secrets are encrypted with the installation's
 * field key; recovery codes are stored hashed and work once. A code can't be replayed
 * (the last accepted time step is stored). Five wrong codes end the session.
 */
export async function mfaRoutes(app: FastifyInstance, opts: { publicConfig: PublicConfig }) {
  const { pool, cipher } = app.deps;
  const issuer = opts.publicConfig.brand.shortName;

  const actor = (req: FastifyRequest) => {
    const u = req.ctx.user;
    if (!u || !u.tenantId) throw unauthorized();
    return { u, tenantId: u.tenantId, base: { tenantId: u.tenantId, actorId: u.userId, requestId: req.id, ip: req.ctx.ip } };
  };

  /** TOTP or recovery code against the user's ENABLED secret. Consumes recovery codes; records the TOTP step. */
  async function checkCode(db: Db, userId: string, code: string): Promise<'totp' | 'recovery' | null> {
    const r = (await db.query<{ mfa_secret_enc: string | null; mfa_recovery_hashes: string[]; mfa_last_step: string | null }>(
      'SELECT mfa_secret_enc, mfa_recovery_hashes, mfa_last_step FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
    if (!r?.mfa_secret_enc) return null;
    const step = verifyTotp(cipher.decrypt(r.mfa_secret_enc), code);
    if (step !== null) {
      if (r.mfa_last_step !== null && step <= Number(r.mfa_last_step)) return null; // replay
      await db.query('UPDATE users SET mfa_last_step=$2 WHERE id=$1', [userId, step]);
      return 'totp';
    }
    const h = sha256(code.toLowerCase().replace(/\s/g, ''));
    if (r.mfa_recovery_hashes.includes(h)) {
      await db.query('UPDATE users SET mfa_recovery_hashes = array_remove(mfa_recovery_hashes, $2) WHERE id=$1', [userId, h]);
      return 'recovery';
    }
    return null;
  }

  app.post('/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { u, tenantId, base } = actor(req);
    const { code } = z.object({ code: Code }).parse(req.body);
    if (!u.mfaPending) throw conflict('This session does not need a code');
    const result = await withPlatformBypass(pool, async (db) => {
      const kind = await checkCode(db, u.userId, code);
      if (kind) {
        await db.query('UPDATE sessions SET mfa_verified_at=now(), mfa_failures=0 WHERE id=$1', [u.sessionId]);
        await audit(db, { ...base, action: 'auth.mfa_verified', category: 'auth', metadata: { method: kind } });
        if (kind === 'recovery') {
          const left = (await db.query<{ n: number }>('SELECT cardinality(mfa_recovery_hashes) AS n FROM users WHERE id=$1', [u.userId])).rows[0]!.n;
          await notifyUsers(db, tenantId, [u.userId], { kind: 'security.recovery_code_used', title: 'A recovery code was used to sign in',
            body: `${left} recovery code(s) left. If this was not you, contact your administrator.`, link: '/account', actionLabel: 'Review account' });
        }
        return { ok: true as const, method: kind };
      }
      const f = (await db.query<{ mfa_failures: number }>('UPDATE sessions SET mfa_failures=mfa_failures+1 WHERE id=$1 RETURNING mfa_failures', [u.sessionId])).rows[0]!.mfa_failures;
      await audit(db, { ...base, action: 'auth.mfa_failed', category: 'auth', metadata: { failures: f } });
      if (f >= MAX_FAILURES) await db.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [u.sessionId]);
      return { ok: false as const, ended: f >= MAX_FAILURES };
    });
    if (!result.ok) {
      if (result.ended) { reply.clearCookie(SESSION_COOKIE, { path: '/' }); throw unauthorized('Too many incorrect codes. Sign in again.'); }
      throw new AppError(400, 'mfa_invalid', 'That code is not valid. Check your authenticator app and try again.');
    }
    return result;
  });

  app.post('/setup', async (req) => {
    const { u, base } = actor(req);
    return withPlatformBypass(pool, async (db) => {
      if ((await db.query('SELECT 1 FROM users WHERE id=$1 AND mfa_enabled_at IS NOT NULL', [u.userId])).rowCount) throw conflict('Two-factor authentication is already on');
      const secret = newTotpSecret();
      await db.query('UPDATE users SET mfa_pending_secret_enc=$2 WHERE id=$1', [u.userId, cipher.encrypt(secret)]);
      await audit(db, { ...base, action: 'auth.mfa_setup_started', category: 'security' });
      return { secret, otpauthUri: otpauthUri(secret, u.email, issuer) };
    });
  });

  app.post('/enable', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { u, tenantId, base } = actor(req);
    const { code } = z.object({ code: Code }).parse(req.body);
    return withPlatformBypass(pool, async (db) => {
      const r = (await db.query<{ p: string | null; on: boolean }>('SELECT mfa_pending_secret_enc AS p, mfa_enabled_at IS NOT NULL AS on FROM users WHERE id=$1 FOR UPDATE', [u.userId])).rows[0]!;
      if (r.on) throw conflict('Two-factor authentication is already on');
      if (!r.p) throw badRequest('Start the setup first');
      const secret = cipher.decrypt(r.p);
      const step = verifyTotp(secret, code);
      if (step === null) throw new AppError(400, 'mfa_invalid', 'That code is not valid. Check the time on your phone and try again.');
      const codes = newRecoveryCodes();
      await db.query(`UPDATE users SET mfa_secret_enc=$2, mfa_pending_secret_enc=NULL, mfa_enabled_at=now(), mfa_last_step=$3, mfa_recovery_hashes=$4 WHERE id=$1`,
        [u.userId, cipher.encrypt(secret), step, codes.map((c) => sha256(c))]);
      await db.query('UPDATE sessions SET mfa_verified_at=now() WHERE id=$1', [u.sessionId]);
      // Other sessions of this user must now present a code too (they were created without one).
      await audit(db, { ...base, action: 'auth.mfa_enabled', category: 'security' });
      await notifyUsers(db, tenantId, [u.userId], { kind: 'security.mfa_enabled', title: 'Two-factor authentication was turned on', body: 'If this was not you, contact your administrator immediately.', link: '/account' });
      return { recoveryCodes: codes };
    });
  });

  app.post('/recovery-codes', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const { u, base } = actor(req);
    const { code } = z.object({ code: Code }).parse(req.body);
    return withPlatformBypass(pool, async (db) => {
      if ((await checkCode(db, u.userId, code)) !== 'totp') throw new AppError(400, 'mfa_invalid', 'Enter a current code from your authenticator app');
      const codes = newRecoveryCodes();
      await db.query('UPDATE users SET mfa_recovery_hashes=$2 WHERE id=$1', [u.userId, codes.map((c) => sha256(c))]);
      await audit(db, { ...base, action: 'auth.mfa_recovery_codes_regenerated', category: 'security' });
      return { recoveryCodes: codes };
    });
  });

  app.post('/disable', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const { u, tenantId, base } = actor(req);
    const body = z.object({ password: z.string().min(1), code: Code }).parse(req.body);
    return withTenant(pool, tenantId, async (db) => {
      if (mfaRequiredFor(u.roles, u.permissions, await effectiveMfaLevel(db, tenantId))) throw forbidden('Your role requires two-factor authentication; it cannot be turned off');
      const pw = (await db.query<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE tenant_id=$1 AND id=$2', [tenantId, u.userId])).rows[0];
      if (!(await verifyPassword(body.password, pw?.password_hash ?? null))) throw badRequest('Password is incorrect');
      if (!(await checkCode(db, u.userId, body.code))) throw new AppError(400, 'mfa_invalid', 'That code is not valid');
      await db.query(`UPDATE users SET mfa_secret_enc=NULL, mfa_pending_secret_enc=NULL, mfa_enabled_at=NULL, mfa_recovery_hashes='{}', mfa_last_step=NULL WHERE tenant_id=$1 AND id=$2`, [tenantId, u.userId]);
      await audit(db, { ...base, action: 'auth.mfa_disabled', category: 'security' });
      await notifyUsers(db, tenantId, [u.userId], { kind: 'security.mfa_disabled', title: 'Two-factor authentication was turned off', body: 'If this was not you, contact your administrator immediately.', link: '/account' });
      return { ok: true };
    });
  });
}
