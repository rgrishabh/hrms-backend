import type { Db } from '../../db/tx.js';
import { sha256 } from '../crypto/index.js';

/**
 * Sign-in back-off. The old lockout counted failures per account, so anyone who knew an email could keep its owner out for free. Failures now
 * count by who is failing (D44):
 *  - the account from one address: the attacker's address backs off, and the owner elsewhere signs in;
 *  - one address across accounts: credential stuffing;
 *  - the account from everywhere: distributed guessing. This one does not stop a browser the account has signed in from before.
 * Keys are hashes of what was typed, whether or not such an account exists, so a refusal says nothing about the account. Counted in the
 * database, so several instances share it.
 */
const IP_THRESHOLD = 50;
const ACCOUNT_THRESHOLD = 30;
const FIRST_BLOCK_SECONDS = 30;
const MAX_BLOCK_SECONDS = 900;
const FORGET_AFTER_MINUTES = 30;

export interface LoginKeys { pair: string; ip: string; account: string; subject: string }
export function loginKeys(tenantId: string, email: string, ip: string): LoginKeys {
  const subject = sha256(`${tenantId}|${email}`);
  return { subject, pair: sha256(`pair|${subject}|${ip}`), ip: sha256(`ip|${tenantId}|${ip}`), account: sha256(`account|${subject}`) };
}

/** Seconds to wait, or null. Runs before any password work, so a refused attempt costs almost nothing. */
export async function loginBlockedFor(db: Db, tenantId: string, k: LoginKeys, knownDevice: boolean): Promise<number | null> {
  const keys = knownDevice ? [k.pair, k.ip] : [k.pair, k.ip, k.account];
  const r = await db.query<{ s: string | null }>(`SELECT ceil(max(extract(epoch FROM blocked_until - now())))::text AS s FROM auth_throttle WHERE tenant_id=$1 AND key_hash = ANY($2) AND blocked_until > now()`, [tenantId, keys]);
  return r.rows[0]?.s ? Number(r.rows[0].s) : null;
}

/** Each failure counts in all three. Past its threshold a counter blocks, doubling from 30 seconds to 15 minutes. */
export async function recordLoginFailure(db: Db, tenantId: string, k: LoginKeys, pairThreshold: number) {
  for (const [key, subject, threshold] of [[k.pair, k.subject, pairThreshold], [k.ip, null, IP_THRESHOLD], [k.account, k.subject, ACCOUNT_THRESHOLD]] as const) {
    await db.query(`INSERT INTO auth_throttle AS t (tenant_id, key_hash, subject_hash, failures, blocked_until, updated_at)
        VALUES ($1,$2,$3,1,NULL,now())
      ON CONFLICT (tenant_id, key_hash) DO UPDATE SET updated_at=now(),
        failures = CASE WHEN t.updated_at < now() - make_interval(mins => ${FORGET_AFTER_MINUTES}) THEN 1 ELSE t.failures + 1 END,
        blocked_until = CASE WHEN t.updated_at >= now() - make_interval(mins => ${FORGET_AFTER_MINUTES}) AND t.failures + 1 >= $4
          THEN now() + make_interval(secs => least(${MAX_BLOCK_SECONDS}, ${FIRST_BLOCK_SECONDS} * power(2, least(t.failures + 1 - $4, 10)))) END`, [tenantId, key, subject, threshold]);
  }
}

/** A right password ends this address's back-off for this account. The other two keep counting: an attacker's guesses do not reset because the owner signed in. */
export const clearLoginPair = (db: Db, tenantId: string, k: LoginKeys) => db.query('DELETE FROM auth_throttle WHERE tenant_id=$1 AND key_hash=$2', [tenantId, k.pair]);

/** An administrator's unlock, or a password reset: everything held against this account. */
export const clearLoginAccount = (db: Db, tenantId: string, email: string) => db.query('DELETE FROM auth_throttle WHERE tenant_id=$1 AND subject_hash=$2', [tenantId, loginKeys(tenantId, email, '').subject]);

export const purgeThrottle = (db: Db, tenantId: string) => db.query(`DELETE FROM auth_throttle WHERE tenant_id=$1 AND updated_at < now() - interval '1 day' AND (blocked_until IS NULL OR blocked_until < now())`, [tenantId]);
