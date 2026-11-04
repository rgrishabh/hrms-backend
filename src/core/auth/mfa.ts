import type { Db } from '../../db/tx.js';
import { getSettingValue } from '../settings/service.js';
import { SYSTEM_ROLES } from './permissions.js';

/**
 * MFA enforcement = the stricter of the deployment floor (MFA_ENFORCEMENT) and the
 * organization setting (security.mfa_enforcement). Administrators can tighten, never relax.
 *   off        — optional for everyone
 *   privileged — required for roles that can change configuration, money or access
 *   all        — required for every user
 */
export type MfaLevel = 'off' | 'privileged' | 'all';
const RANK: Record<MfaLevel, number> = { off: 0, privileged: 1, all: 2 };
export const PRIVILEGED_ROLES: readonly string[] = ['tenant_admin', 'hr_admin', 'payroll_manager', 'it_admin'];
/**
 * Permissions that only privileged system roles carry (configuration, access, bank details, payroll set-up).
 * An organization's own role carrying any of them counts as privileged too, so a custom role cannot avoid MFA.
 */
export const PRIVILEGED_PERMISSIONS: ReadonlySet<string> = (() => {
  const ordinary = new Set(SYSTEM_ROLES.filter((r) => !PRIVILEGED_ROLES.includes(r.key)).flatMap((r) => r.permissions as readonly string[]));
  return new Set(SYSTEM_ROLES.filter((r) => PRIVILEGED_ROLES.includes(r.key)).flatMap((r) => r.permissions as readonly string[]).filter((p) => !ordinary.has(p)));
})();

let floor: MfaLevel = 'privileged';
export const setMfaFloor = (l: MfaLevel) => { floor = l; };
export const getMfaFloor = () => floor;

export async function effectiveMfaLevel(db: Db, tenantId: string): Promise<MfaLevel> {
  const org = await getSettingValue<MfaLevel>(db, tenantId, 'security.mfa_enforcement');
  return RANK[org] > RANK[floor] ? org : floor;
}

export function mfaRequiredFor(roles: string[], permissions: ReadonlySet<string>, level: MfaLevel) {
  return level === 'all' || (level === 'privileged' && (roles.some((r) => PRIVILEGED_ROLES.includes(r)) || [...permissions].some((p) => PRIVILEGED_PERMISSIONS.has(p))));
}

/** Paths usable while a session still needs its MFA code. */
export const MFA_PENDING_ALLOWED = new Set(['/api/v1/auth/me', '/api/v1/auth/mfa/verify', '/api/v1/auth/logout']);
/** Paths usable while a user must enrol before doing anything else. */
export const MFA_ENROLL_ALLOWED = new Set(['/api/v1/auth/me', '/api/v1/auth/mfa/setup', '/api/v1/auth/mfa/enable', '/api/v1/auth/logout', '/api/v1/auth/password']);
