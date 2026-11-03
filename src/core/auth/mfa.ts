import type { Db } from '../../db/tx.js';
import { getSettingValue } from '../settings/service.js';

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

let floor: MfaLevel = 'privileged';
export const setMfaFloor = (l: MfaLevel) => { floor = l; };
export const getMfaFloor = () => floor;

export async function effectiveMfaLevel(db: Db, tenantId: string): Promise<MfaLevel> {
  const org = await getSettingValue<MfaLevel>(db, tenantId, 'security.mfa_enforcement');
  return RANK[org] > RANK[floor] ? org : floor;
}

export function mfaRequiredFor(roles: string[], level: MfaLevel) {
  return level === 'all' || (level === 'privileged' && roles.some((r) => PRIVILEGED_ROLES.includes(r)));
}

/** Paths usable while a session still needs its MFA code. */
export const MFA_PENDING_ALLOWED = new Set(['/api/v1/auth/me', '/api/v1/auth/mfa/verify', '/api/v1/auth/logout']);
/** Paths usable while a user must enrol before doing anything else. */
export const MFA_ENROLL_ALLOWED = new Set(['/api/v1/auth/me', '/api/v1/auth/mfa/setup', '/api/v1/auth/mfa/enable', '/api/v1/auth/logout', '/api/v1/auth/password']);
