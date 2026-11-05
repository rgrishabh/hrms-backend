import type { Pool } from '../../db/pool.js';
import { withPlatformBypass, type Db } from '../../db/tx.js';
import { randomToken, sha256 } from '../crypto/index.js';
import { SYSTEM_ROLE_MAP, resolveRolePermissions } from './permissions.js';
import { currentMode } from '../policy/mode.js';
import { effectiveLevel } from '../policy/levels.js';
import { effectiveMethod, type MfaMethod, type MfaPolicy } from './mfa.js';

export const SESSION_COOKIE = 'hrms_sid';
/** A random value per browser, long-lived: tells a browser this account has used from one it has not. Never authenticates anything. */
export const DEVICE_COOKIE = 'hrms_did';

/**
 * CSRF token bound to the session token. A cross-site attacker cannot read the
 * httpOnly cookie, so cannot compute it; the SPA gets it from login or /auth/me.
 */
export const deriveCsrf = (sessionToken: string) => sha256(`csrf:${sessionToken}`);

export interface SessionUser {
  sessionId: string;
  userId: string;
  tenantId: string | null;
  email: string;
  displayName: string;
  csrfHash: string;
  roles: string[];
  permissions: Set<string>;
  /** Effective salary level (core/policy/levels.ts). */
  salaryLevel: number;
  employeeId: string | null;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  /** The method this user must answer with, or null. Null for everyone while MFA_AVAILABLE=false, enrolled or not. */
  mfaMethod: MfaMethod | null;
  /** MFA is enrolled but this session has not presented a code yet. */
  mfaPending: boolean;
  /** MFA_ENFORCED=true and this user has not enrolled. */
  mfaEnrollmentRequired: boolean;
}

export interface SessionLimits {
  ttlHours: number;
  idleMinutes: number;
}

export async function createSession(db: Db, userId: string, tenantId: string | null, limits: SessionLimits, ip?: string, ua?: string) {
  const token = randomToken(32);
  const csrf = deriveCsrf(token);
  const r = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO sessions (token_hash, csrf_hash, user_id, tenant_id, ip, user_agent, expires_at, idle_timeout_minutes)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(hours => $7), $8) RETURNING id, expires_at`,
    [sha256(token), sha256(csrf), userId, tenantId, ip ?? null, (ua ?? '').slice(0, 300), limits.ttlHours, limits.idleMinutes],
  );
  return { token, csrf, sessionId: r.rows[0]!.id, expiresAt: r.rows[0]!.expires_at };
}

/** A new token for the same session, after anything that raises what it can do. The old token stops working at once; the absolute expiry does not move. */
export async function rotateSession(db: Db, sessionId: string) {
  const token = randomToken(32);
  const csrf = deriveCsrf(token);
  const r = await db.query<{ expires_at: Date }>('UPDATE sessions SET token_hash=$2, csrf_hash=$3 WHERE id=$1 AND revoked_at IS NULL RETURNING expires_at', [
    sessionId,
    sha256(token),
    sha256(csrf),
  ]);
  return { token, csrf, expiresAt: r.rows[0]!.expires_at };
}

/**
 * Load the session for a cookie token. The session is bound to exactly one
 * tenant (or the platform); `expectedTenantId` comes from the verified host, so
 * a cookie replayed against another tenant's domain is rejected.
 */
export async function loadSession(pool: Pool, token: string, expectedTenantId: string | null, mfa: MfaPolicy, opts: { passive?: boolean } = {}): Promise<SessionUser | null> {
  return withPlatformBypass(pool, async (db) => {
    const r = await db.query<{
      id: string;
      user_id: string;
      tenant_id: string | null;
      csrf_hash: string;
      email: string;
      display_name: string;
      status: string;
      touch: boolean;
      must_change_password: boolean;
      mfa_on: boolean;
      mfa_method: string | null;
      mfa_ok: boolean;
      salary_access_level: number;
    }>(
      `SELECT s.id, s.user_id, s.tenant_id, s.csrf_hash, u.email, u.display_name, u.status, u.must_change_password, u.salary_access_level,
              (u.mfa_enabled_at IS NOT NULL) AS mfa_on, u.mfa_method, (s.mfa_verified_at IS NOT NULL) AS mfa_ok,
              s.last_seen_at < now() - interval '1 minute' AS touch
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND s.last_seen_at > now() - make_interval(mins => s.idle_timeout_minutes)`,
      [sha256(token)],
    );
    const s = r.rows[0];
    if (!s || s.status !== 'active' || s.tenant_id !== expectedTenantId) return null;
    if (s.touch && !opts.passive) await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [s.id]);
    const { roles, permissions } = await loadPermissions(db, s.user_id, s.tenant_id);
    let employeeId: string | null = null;
    if (s.tenant_id) {
      const e = await db.query<{ id: string }>(`SELECT id FROM employees WHERE tenant_id=$1 AND user_id=$2`, [s.tenant_id, s.user_id]);
      employeeId = e.rows[0]?.id ?? null;
    }
    const method = effectiveMethod(mfa, s.mfa_on, s.mfa_method);
    return {
      sessionId: s.id,
      userId: s.user_id,
      tenantId: s.tenant_id,
      email: s.email,
      displayName: s.display_name,
      csrfHash: s.csrf_hash,
      roles,
      permissions,
      salaryLevel: effectiveLevel(s.salary_access_level, roles),
      employeeId,
      mustChangePassword: s.must_change_password,
      mfaEnabled: !!method,
      mfaMethod: method,
      mfaPending: !!method && !s.mfa_ok,
      mfaEnrollmentRequired: !method && !!s.tenant_id && mfa.available && mfa.enforced,
    };
  });
}

export async function loadPermissions(db: Db, userId: string, tenantId: string | null) {
  const rr = await db.query<{ role_key: string }>(`SELECT DISTINCT role_key FROM user_roles WHERE user_id = $1 AND tenant_id IS NOT DISTINCT FROM $2`, [userId, tenantId]);
  const roles = rr.rows.map((r) => r.role_key);
  const permissions = new Set<string>();
  const mode = currentMode();
  const custom: string[] = [];
  for (const key of roles) {
    if (SYSTEM_ROLE_MAP.has(key) && tenantId) resolveRolePermissions(key, mode).forEach((p) => permissions.add(p));
    else if (key.startsWith('custom:') && tenantId && mode === 'multi') custom.push(key);
  }
  if (custom.length) {
    const cr = await db.query<{ permissions: string[] }>(`SELECT permissions FROM tenant_roles WHERE tenant_id=$1 AND key = ANY($2)`, [tenantId, custom]);
    cr.rows.forEach((r) => r.permissions.forEach((p) => permissions.add(p)));
  }
  return { roles, permissions };
}

export async function revokeSession(db: Db, sessionId: string) {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

export async function revokeAllSessionsForUser(db: Db, userId: string) {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

export async function revokeOtherSessions(db: Db, userId: string, keepSessionId: string) {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [userId, keepSessionId]);
}

/** Records a sign-in from this browser. New means this account has used another browser before and never this one: a first sign-in is not news. */
export async function rememberDevice(db: Db, tenantId: string, userId: string, deviceHash: string): Promise<{ isNew: boolean }> {
  const before = await db.query<{ here: boolean }>('SELECT device_hash = $2 AS here FROM user_devices WHERE user_id=$1', [userId, deviceHash]);
  await db.query(
    `INSERT INTO user_devices (tenant_id, user_id, device_hash) VALUES ($1,$2,$3)
    ON CONFLICT (user_id, device_hash) DO UPDATE SET last_seen_at=now()`,
    [tenantId, userId, deviceHash],
  );
  return { isNew: before.rows.length > 0 && !before.rows.some((r) => r.here) };
}
