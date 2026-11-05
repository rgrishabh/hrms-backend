import { randomInt, timingSafeEqual } from 'node:crypto';
import type { Db } from '../../db/tx.js';
import type { FieldCipher } from '../crypto/index.js';
import { getMailer } from '../notify/mailer.js';
import { queueSecretEmail } from '../notify/service.js';

/**
 * Email one-time codes. Six digits are few enough to try them all offline, so the hash is keyed with a key the database does not hold.
 * Short-lived, single use, the newest only, a limit per code on guesses, and limits on how often one can be sent. Only ever reached with
 * a valid password or a signed-in session, so nothing here can say whether an email has an account.
 */
export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_SECONDS = 60;
export const OTP_MAX_PER_HOUR = 5;

export type OtpPurpose = 'login' | 'enrol';
export type OtpSend = { state: 'sent' } | { state: 'unavailable' } | { state: 'wait'; retryAfter: number };

const hashOf = (cipher: FieldCipher, userId: string, purpose: OtpPurpose, code: string) => cipher.mac('email-otp', `${userId}:${purpose}:${code}`);

export async function sendEmailOtp(db: Db, cipher: FieldCipher, tenantId: string, userId: string, purpose: OtpPurpose): Promise<OtpSend> {
  if (!getMailer()) return { state: 'unavailable' };
  const recent = (await db.query<{ n: number; since_last: string | null; oldest_age: string | null }>(`SELECT count(*)::int AS n, extract(epoch FROM now() - max(created_at))::text AS since_last, extract(epoch FROM now() - min(created_at))::text AS oldest_age
    FROM email_otps WHERE user_id=$1 AND created_at > now() - interval '1 hour'`, [userId])).rows[0]!;
  if (recent.n >= OTP_MAX_PER_HOUR) return { state: 'wait', retryAfter: Math.max(1, Math.ceil(3600 - Number(recent.oldest_age))) };
  if (recent.since_last !== null && Number(recent.since_last) < OTP_RESEND_SECONDS) return { state: 'wait', retryAfter: Math.ceil(OTP_RESEND_SECONDS - Number(recent.since_last)) };
  await db.query('UPDATE email_otps SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL', [userId]);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const r = await db.query<{ expires_at: Date }>(`INSERT INTO email_otps (tenant_id, user_id, purpose, code_hash, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(mins => ${OTP_TTL_MINUTES})) RETURNING expires_at`,
    [tenantId, userId, purpose, hashOf(cipher, userId, purpose, code)]);
  await queueSecretEmail(db, tenantId, userId, { kind: 'security.email_code', title: 'Your sign-in code',
    body: `Your code is __SECRET__. It works once and expires in ${OTP_TTL_MINUTES} minutes. If you did not try to sign in, change your password.` }, code, r.rows[0]!.expires_at);
  return { state: 'sent' };
}

/** Checks the newest live code. Each wrong try counts, and is kept even if the caller answers with an error: it must commit. */
export async function verifyEmailOtp(db: Db, cipher: FieldCipher, userId: string, purpose: OtpPurpose, code: string): Promise<boolean> {
  const row = (await db.query<{ id: string; code_hash: string; attempts: number }>(`SELECT id, code_hash, attempts FROM email_otps
    WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [userId, purpose])).rows[0];
  if (!row) return false;
  const expected = Buffer.from(row.code_hash, 'hex'); const actual = Buffer.from(hashOf(cipher, userId, purpose, code), 'hex');
  if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
    await db.query('UPDATE email_otps SET consumed_at=now() WHERE id=$1', [row.id]);
    return true;
  }
  await db.query(`UPDATE email_otps SET attempts=attempts+1, consumed_at=CASE WHEN attempts+1 >= ${OTP_MAX_ATTEMPTS} THEN now() END WHERE id=$1`, [row.id]);
  return false;
}
