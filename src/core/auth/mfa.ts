import type { Env } from '../../config/env.js';

/**
 * MFA is deployment configuration and nothing else (D45):
 *   MFA_AVAILABLE=false  off for every user, whatever they enrolled in, which is kept
 *   MFA_ENFORCED=false   optional, per user
 *   MFA_ENFORCED=true    enrolment required at next sign-in
 */
export type MfaMethod = 'totp' | 'email';
export interface MfaPolicy {
  available: boolean;
  enforced: boolean;
  methods: readonly string[];
}
export const mfaPolicyOf = (env: Pick<Env, 'MFA_AVAILABLE' | 'MFA_ENFORCED' | 'MFA_METHODS'>): MfaPolicy => ({
  available: env.MFA_AVAILABLE,
  enforced: env.MFA_ENFORCED,
  methods: env.MFA_METHODS,
});

/**
 * The method that counts for this user, or null. Enrolment in a method this deployment no longer offers does not count: they could not
 * complete a challenge. It is kept, and comes back if the method does.
 */
export function effectiveMethod(p: MfaPolicy, enabledAt: unknown, method: string | null): MfaMethod | null {
  if (!p.available || !enabledAt || !method || !p.methods.includes(method)) return null;
  return method as MfaMethod;
}

/**
 * Paths that do not act for the session in the cookie: someone at a sign-in or reset page, or following a link from an email, may well still hold
 * one. They need no CSRF token, and no pending step of that session stands in their way. A cross-site form cannot send the cookie anyway (SameSite).
 */
export const SESSIONLESS_PATHS = new Set(['/api/v1/auth/login', '/api/v1/auth/password/forgot', '/api/v1/auth/password/reset', '/api/v1/auth/setup']);

/** Paths usable while a session still needs its MFA code. */
export const MFA_PENDING_ALLOWED = new Set(['/api/v1/auth/me', '/api/v1/auth/mfa/verify', '/api/v1/auth/mfa/email/send', '/api/v1/auth/logout']);
/** Paths usable while a user must enrol before doing anything else. */
export const MFA_ENROLL_ALLOWED = new Set([
  '/api/v1/auth/me',
  '/api/v1/auth/mfa/methods',
  '/api/v1/auth/mfa/setup',
  '/api/v1/auth/mfa/enable',
  '/api/v1/auth/mfa/email/setup',
  '/api/v1/auth/mfa/email/enable',
  '/api/v1/auth/logout',
  '/api/v1/auth/password',
]);

/** Wrong codes across sessions before the second factor stops answering, and for how long. Signing in again must not earn more guesses. */
export const MFA_USER_MAX_FAILURES = 10;
export const MFA_USER_LOCK_MINUTES = 15;
