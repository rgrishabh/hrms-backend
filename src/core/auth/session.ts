import type { Pool } from '../../db/pool.js';
import { withPlatformBypass, type Db } from '../../db/tx.js';
import { randomToken, sha256 } from '../crypto/index.js';
import { SYSTEM_ROLE_MAP, resolveRolePermissions } from './permissions.js';
import { currentMode } from '../policy/mode.js';
import { effectiveLevel } from '../policy/levels.js';
import { effectiveMfaLevel, mfaRequiredFor } from './mfa.js';

export const SESSION_COOKIE = 'hrms_sid';

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
  /** MFA is enrolled but this session has not presented a code yet. */
  mfaPending: boolean;
  /** Policy requires MFA for this user and they have not enrolled. */
  mfaEnrollmentRequired: boolean;
}

export async function createSession(db: Db, userId: string, tenantId: string | null, ttlHours: number, ip?: string, ua?: string) {
  const token = randomToken(32);
  const csrf = deriveCsrf(token);
  const r = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO sessions (token_hash, csrf_hash, user_id, tenant_id, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(hours => $7)) RETURNING id, expires_at`,
    [sha256(token), sha256(csrf), userId, tenantId, ip ?? null, (ua ?? '').slice(0, 300), ttlHours]);
  return { token, csrf, sessionId: r.rows[0]!.id, expiresAt: r.rows[0]!.expires_at };
}

/**
 * Load the session for a cookie token. The session is bound to exactly one
 * tenant (or the platform); `expectedTenantId` comes from the verified host, so
 * a cookie replayed against another tenant's domain is rejected.
 */
export async function loadSession(pool: Pool, token: string, expectedTenantId: string | null): Promise<SessionUser | null> {
  return withPlatformBypass(pool, async (db) => {
    const r = await db.query<{ id: string; user_id: string; tenant_id: string | null; csrf_hash: string; email: string; display_name: string; status: string; touch: boolean; must_change_password: boolean; mfa_on: boolean; mfa_ok: boolean; salary_access_level: number }>(
      `SELECT s.id, s.user_id, s.tenant_id, s.csrf_hash, u.email, u.display_name, u.status, u.must_change_password, u.salary_access_level,
              (u.mfa_enabled_at IS NOT NULL) AS mfa_on, (s.mfa_verified_at IS NOT NULL) AS mfa_ok,
              s.last_seen_at < now() - interval '5 minutes' AS touch
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [sha256(token)]);
    const s = r.rows[0];
    if (!s || s.status !== 'active' || s.tenant_id !== expectedTenantId) return null;
    if (s.touch) await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [s.id]);
    const { roles, permissions } = await loadPermissions(db, s.user_id, s.tenant_id);
    let employeeId: string | null = null;
    if (s.tenant_id) {
      const e = await db.query<{ id: string }>(`SELECT id FROM employees WHERE tenant_id=$1 AND user_id=$2`, [s.tenant_id, s.user_id]);
      employeeId = e.rows[0]?.id ?? null;
    }
    return { sessionId: s.id, userId: s.user_id, tenantId: s.tenant_id, email: s.email, displayName: s.display_name,
      csrfHash: s.csrf_hash, roles, permissions, salaryLevel: effectiveLevel(s.salary_access_level, roles), employeeId, mustChangePassword: s.must_change_password,
      mfaEnabled: s.mfa_on, mfaPending: s.mfa_on && !s.mfa_ok,
      mfaEnrollmentRequired: !s.mfa_on && !!s.tenant_id && mfaRequiredFor(roles, permissions, await effectiveMfaLevel(db, s.tenant_id)) };
  });
}

export async function loadPermissions(db: Db, userId: string, tenantId: string | null) {
  const rr = await db.query<{ role_key: string }>(
    `SELECT DISTINCT role_key FROM user_roles WHERE user_id = $1 AND tenant_id IS NOT DISTINCT FROM $2`, [userId, tenantId]);
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
