import { gunzipSync } from 'node:zlib';
import { AppError } from '../http/errors.js';
import { BREACHED_GZ_BASE64 } from './breached-list.data.js';

/**
 * The password rules, product constants (configuration layer 4). Length is what counts, so there are no character class rules: a long phrase
 * is fine and `Password1!` is not. The breached list is bundled and checked in memory; nothing goes over the network. See docs/AUTH.md.
 */
export const PASSWORD_FLOOR = 12;
export const PASSWORD_MAX = 256;
const MIN_DISTINCT = 5;
const MIN_PERSONAL_PART = 4;

let breached: ReadonlySet<string> | null = null;
/** About 72,000 entries of 12 characters or more. Opened at first use, and kept. */
const breachedList = () => (breached ??= new Set(gunzipSync(Buffer.from(BREACHED_GZ_BASE64, 'base64')).toString('latin1').split('\n')));

export function isBreached(password: string) {
  const list = breachedList();
  const lower = password.toLowerCase();
  // The commonest change to a listed password is a number or a mark on the end.
  return list.has(lower) || list.has(lower.replace(/[^a-z]+$/, ''));
}

export interface PasswordContext { minLength: number; email: string; displayName?: string }
export type PasswordProblem = 'too_short' | 'too_long' | 'breached' | 'personal' | 'too_simple';

export function passwordProblems(password: string, c: PasswordContext): PasswordProblem[] {
  const out: PasswordProblem[] = [];
  const lower = password.toLowerCase();
  if ([...password].length < Math.max(PASSWORD_FLOOR, c.minLength)) out.push('too_short');
  if (password.length > PASSWORD_MAX) out.push('too_long');
  if (isBreached(password)) out.push('breached');
  const [local = '', domain = ''] = c.email.toLowerCase().split('@');
  const parts = [local, ...local.split(/[._+-]/), domain.split('.')[0] ?? '', ...(c.displayName ?? '').toLowerCase().split(/\s+/)];
  if (parts.some((p) => p.length >= MIN_PERSONAL_PART && lower.includes(p))) out.push('personal');
  if (new Set(lower).size < MIN_DISTINCT || /^(.{1,6})\1+$/.test(lower)) out.push('too_simple');
  return out;
}

const SAY: Record<PasswordProblem, (c: PasswordContext) => string> = {
  too_short: (c) => `Use at least ${Math.max(PASSWORD_FLOOR, c.minLength)} characters`,
  too_long: () => `Use at most ${PASSWORD_MAX} characters`,
  breached: () => 'This password appears in lists of leaked passwords. Choose another',
  personal: () => 'Do not use your name or email address in your password',
  too_simple: () => 'This password is too repetitive. Choose another',
};

export function assertStrongPassword(password: string, c: PasswordContext) {
  const problems = passwordProblems(password, c);
  if (problems.length) throw new AppError(400, 'weak_password', SAY[problems[0]!](c), { problems });
}
