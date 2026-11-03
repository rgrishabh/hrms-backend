import { z } from 'zod';

/**
 * Typed business settings (configuration layer C). Ordinary administrators edit
 * values through these schemas only — never arbitrary JSON.
 *
 * Resolution (later layers override earlier ones; constraints always apply):
 *   1. Code default            — `default`
 *   2. Deployment default      — from deployment config (e.g. ORGANIZATION_TIMEZONE)
 *   3. Organization value      — set by an administrator (tenant_settings scope 'tenant')
 *   4. Branch override         — tenant_settings scope 'branch', only if `scopes` includes 'branch'
 *   Always enforced: immutable constraints (`schema`) and deployment ceilings (`deploymentCeiling`).
 */
export interface SettingDefinition<T = unknown> {
  key: string;
  group: 'general' | 'attendance' | 'security' | 'notifications';
  label: string;
  description: string;
  control: 'text' | 'number' | 'boolean' | 'select' | 'weekdays' | 'timezone';
  options?: readonly { value: string; label: string }[];
  schema: z.ZodType<T>;
  default: T;
  scopes: readonly ('tenant' | 'branch')[];
  /** Permission needed to change it. Reading effective values needs settings.read. */
  editPermission: string;
  /** Module whose settings page shows this key. */
  feature?: string;
  /** Upper bound imposed by deployment configuration (layer 2). */
  deploymentCeiling?: (env: DeploymentLimits) => T;
}

export interface DeploymentLimits { sessionTtlHours: number }

const def = <T>(d: SettingDefinition<T>) => d as SettingDefinition<unknown>;

export const SETTINGS: readonly SettingDefinition[] = [
  def({ key: 'general.timezone', group: 'general', label: 'Business timezone', description: 'Timezone used for attendance days, shift times and reports. Branches may override.',
    control: 'timezone', schema: z.string().refine(isValidTimezone, 'Unknown IANA timezone'), default: 'Asia/Kolkata', scopes: ['tenant', 'branch'], editPermission: 'settings.manage' }),
  def({ key: 'general.date_format', group: 'general', label: 'Date format', description: 'Display format for dates across the application.',
    control: 'select', options: [{ value: 'DD/MM/YYYY', label: 'DD/MM/YYYY' }, { value: 'DD-MM-YYYY', label: 'DD-MM-YYYY' }, { value: 'DD-MMM-YYYY', label: 'DD-MMM-YYYY' }, { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD' }],
    schema: z.enum(['DD/MM/YYYY', 'DD-MM-YYYY', 'DD-MMM-YYYY', 'YYYY-MM-DD']), default: 'DD/MM/YYYY', scopes: ['tenant'], editPermission: 'settings.manage' }),

  def({ key: 'attendance.weekly_offs', group: 'attendance', feature: 'attendance', label: 'Weekly off days', description: 'Days treated as weekly off. Branches may override (e.g. labs working Saturdays).',
    control: 'weekdays', schema: z.array(z.number().int().min(0).max(6)).max(3).transform((a) => [...new Set(a)].sort()), default: [0], scopes: ['tenant', 'branch'], editPermission: 'attendance.configure' }),
  def({ key: 'attendance.min_punch_gap_seconds', group: 'attendance', feature: 'attendance', label: 'Minimum gap between punches (seconds)', description: 'Punches by the same employee closer than this are treated as accidental repeats and ignored in calculation (still stored).',
    control: 'number', schema: z.number().int().min(0).max(900), default: 60, scopes: ['tenant'], editPermission: 'attendance.configure' }),
  def({ key: 'attendance.regularization_window_days', group: 'attendance', feature: 'attendance.regularization', label: 'Regularization window (days)', description: 'How many days back an employee may request an attendance correction.',
    control: 'number', schema: z.number().int().min(1).max(60), default: 7, scopes: ['tenant'], editPermission: 'attendance.configure' }),
  def({ key: 'attendance.mobile_location_mode', group: 'attendance', feature: 'attendance.mobile', label: 'Mobile location capture', description: 'Whether mobile clock-in asks for the device location. Location is captured only at punch time — never tracked continuously.',
    control: 'select', options: [{ value: 'off', label: 'Off' }, { value: 'optional', label: 'Optional' }, { value: 'required', label: 'Required' }],
    schema: z.enum(['off', 'optional', 'required']), default: 'off', scopes: ['tenant', 'branch'], editPermission: 'attendance.configure' }),
  def({ key: 'attendance.max_device_clock_drift_seconds', group: 'attendance', feature: 'attendance.biometric', label: 'Max tolerated device clock drift (seconds)', description: 'Devices reporting a clock further off than this are flagged; their events are corrected using the reported drift.',
    control: 'number', schema: z.number().int().min(0).max(3600), default: 300, scopes: ['tenant'], editPermission: 'attendance.configure' }),
  def({ key: 'attendance.overtime_enabled', group: 'attendance', feature: 'attendance', label: 'Calculate overtime minutes', description: 'Record overtime minutes on daily results for shifts that define an overtime threshold. Payout requires the Overtime/Payroll modules.',
    control: 'boolean', schema: z.boolean(), default: false, scopes: ['tenant'], editPermission: 'attendance.configure' }),

  def({ key: 'leave.year_start_month', group: 'attendance', feature: 'leave', label: 'Leave year starts in', description: 'Month in which the leave year begins (balances, accruals and carry-forward follow this year).',
    control: 'select', options: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => ({ value: String(i + 1), label: m })),
    schema: z.coerce.number().int().min(1).max(12), default: 1, scopes: ['tenant'], editPermission: 'leave.manage' }),
  def({ key: 'notifications.approval_reminder_days', group: 'notifications', label: 'Remind approvers after (days)', description: 'Approvers get a daily reminder for requests waiting longer than this. 0 turns reminders off.',
    control: 'number', schema: z.number().int().min(0).max(30), default: 2, scopes: ['tenant'], editPermission: 'settings.manage' }),
  def({ key: 'expenses.claim_window_days', group: 'general', feature: 'expenses', label: 'Expense claim window (days)', description: 'Expenses older than this cannot be claimed.',
    control: 'number', schema: z.number().int().min(7).max(365), default: 60, scopes: ['tenant'], editPermission: 'expenses.manage' }),
  def({ key: 'competency.assessment_validity_days', group: 'general', feature: 'lab.competency', label: 'Competency assessment validity (days)', description: 'An authorization can only be requested on an assessment at most this old.',
    control: 'number', schema: z.number().int().min(30).max(730), default: 180, scopes: ['tenant'], editPermission: 'competency.manage' }),
  def({ key: 'security.session_ttl_hours', group: 'security', label: 'Session lifetime (hours)', description: 'Users are signed out after this long. Cannot exceed the deployment maximum.',
    control: 'number', schema: z.number().int().min(1).max(720), default: 12, scopes: ['tenant'], editPermission: 'security.manage',
    deploymentCeiling: (e) => e.sessionTtlHours }),
  def({ key: 'security.mfa_enforcement', group: 'security', label: 'Two-factor authentication', description: 'Who must use an authenticator app. The installation sets a minimum (MFA_ENFORCEMENT); this can only make it stricter.',
    control: 'select', options: [{ value: 'off', label: 'Optional for everyone' }, { value: 'privileged', label: 'Required for administrators, HR admins, payroll and IT' }, { value: 'all', label: 'Required for everyone' }],
    schema: z.enum(['off', 'privileged', 'all']), default: 'off', scopes: ['tenant'], editPermission: 'security.manage' }),
  def({ key: 'security.max_failed_logins', group: 'security', label: 'Failed sign-ins before lockout', description: 'Account is locked for 15 minutes after this many consecutive failures.',
    control: 'number', schema: z.number().int().min(3).max(10), default: 5, scopes: ['tenant'], editPermission: 'security.manage' }),
  def({ key: 'security.password_min_length', group: 'security', label: 'Minimum password length', description: 'Platform floor is 12 characters; tenants may require longer.',
    control: 'number', schema: z.number().int().min(12).max(128), default: 12, scopes: ['tenant'], editPermission: 'security.manage' }),
];

export const SETTINGS_MAP: ReadonlyMap<string, SettingDefinition> = new Map(SETTINGS.map((s) => [s.key, s]));

function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-IN', { timeZone: tz }); return true; } catch { return false; }
}
