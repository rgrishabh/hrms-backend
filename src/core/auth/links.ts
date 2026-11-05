import type { Db } from '../../db/tx.js';
import { randomToken, sha256 } from '../crypto/index.js';
import { getMailer } from '../notify/mailer.js';
import { queueSecretEmail, SECRET_PLACEHOLDER } from '../notify/service.js';

/**
 * Invitation and password reset links, on the table the bootstrap setup link already uses (`admin_setup_tokens`). By email only: the raw token
 * exists in the outgoing mail and nowhere else, single use, short-lived, and stored hashed. A new link ends the last one of its kind. The token
 * sits in the URL fragment so it never reaches a server log.
 */
export const RESET_TTL_MINUTES = 30;
export const INVITE_TTL_HOURS = 72;
export const LINKS_PER_HOUR = 3;

export type LinkPurpose = 'invite' | 'reset';
export type LinkResult = 'sent' | 'unavailable' | 'limited';

export async function emailLink(db: Db, tenantId: string, userId: string, purpose: LinkPurpose): Promise<LinkResult> {
  if (!getMailer()) return 'unavailable';
  const recent = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM admin_setup_tokens WHERE user_id=$1 AND purpose=$2 AND created_at > now() - interval '1 hour'`, [userId, purpose]);
  if (recent.rows[0]!.n >= LINKS_PER_HOUR) return 'limited';
  await db.query('UPDATE admin_setup_tokens SET used_at=now() WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL', [userId, purpose]);
  const token = randomToken(32);
  const ttl = purpose === 'reset' ? `make_interval(mins => ${RESET_TTL_MINUTES})` : `make_interval(hours => ${INVITE_TTL_HOURS})`;
  const r = await db.query<{ expires_at: Date }>(`INSERT INTO admin_setup_tokens (tenant_id, user_id, token_hash, expires_at, purpose) VALUES ($1,$2,$3, now() + ${ttl}, $4) RETURNING expires_at`,
    [tenantId, userId, sha256(token), purpose]);
  await queueSecretEmail(db, tenantId, userId, purpose === 'reset'
    ? { kind: 'security.password_reset', title: 'Reset your password', body: `Use the button below to choose a new password. The link works once and expires in ${RESET_TTL_MINUTES} minutes. If you did not ask for this, ignore this email; your password has not changed.`,
        link: `/reset-password#token=${SECRET_PLACEHOLDER}`, actionLabel: 'Choose a new password' }
    : { kind: 'security.invite', title: 'You have been invited', body: `Use the button below to choose your password and sign in. The link works once and expires in ${INVITE_TTL_HOURS} hours.`,
        link: `/setup#token=${SECRET_PLACEHOLDER}`, actionLabel: 'Choose your password' }, token, r.rows[0]!.expires_at);
  return 'sent';
}

export interface LiveLink { id: string; user_id: string; email: string; display_name: string; purpose: string }

/** Finds a link that still works. Taking it is a separate step, `takeLink`, so that hashing the new password holds no transaction open. */
export async function findLink(db: Db, tenantId: string, token: string, purposes: readonly string[]): Promise<LiveLink | null> {
  const r = await db.query<LiveLink>(`SELECT t.id, t.user_id, u.email, u.display_name, t.purpose FROM admin_setup_tokens t JOIN users u ON u.id=t.user_id
    WHERE t.tenant_id=$1 AND t.token_hash=$2 AND t.purpose = ANY($3) AND t.used_at IS NULL AND t.expires_at > now() AND u.status='active'`, [tenantId, sha256(token), purposes]);
  return r.rows[0] ?? null;
}

/** One statement, so of two people presenting the same link at once, exactly one gets true. */
export async function takeLink(db: Db, id: string): Promise<boolean> {
  return !!(await db.query('UPDATE admin_setup_tokens SET used_at=now() WHERE id=$1 AND used_at IS NULL AND expires_at > now()', [id])).rowCount;
}
