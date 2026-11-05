import { z } from 'zod';

/**
 * Typed business settings (configuration layer C). Ordinary administrators edit
 * values through these schemas only — never arbitrary JSON.
 *
 * Resolution (later layers override earlier ones; constraints always apply):
 *   1. Code default            — `default`
 *   2. Deployment default      — from deployment config (e.g. BRAND_TIMEZONE)
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
  /** Module whose settings page shows this key; with a list, any one of them. */
  feature?: string | readonly string[];
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
  def({ key: 'attendance.mobile_location_mode', group: 'attendance', feature: 'attendance.geofence', label: 'Mobile location capture', description: 'Whether mobile clock-in asks for the device location. Location is captured only at punch time — never tracked continuously.',
    control: 'select', options: [{ value: 'off', label: 'Off' }, { value: 'optional', label: 'Optional' }, { value: 'required', label: 'Required' }],
    schema: z.enum(['off', 'optional', 'required']), default: 'off', scopes: ['tenant', 'branch'], editPermission: 'attendance.configure' }),
  def({ key: 'attendance.geofence_enforce', group: 'attendance', feature: 'attendance.geofence', label: 'Refuse clock-in outside the geofence', description: 'Off: a clock-in outside the branch geofence is recorded and flagged. On: it is refused.',
    control: 'boolean', schema: z.boolean(), default: false, scopes: ['tenant', 'branch'], editPermission: 'attendance.configure' }),
  def({ key: 'attendance.selfie_required', group: 'attendance', feature: 'attendance.selfie', label: 'Selfie required at clock-in', description: 'Clock-in on the web or mobile app needs a camera photo.',
    control: 'boolean', schema: z.boolean(), default: true, scopes: ['tenant', 'branch'], editPermission: 'attendance.configure' }),
  def({ key: 'attendance.selfie_retention_days', group: 'attendance', feature: 'attendance.selfie', label: 'Keep check-in selfies for (days)', description: 'Selfies are erased after this many days. Changing it applies to new photos.',
    control: 'number', schema: z.number().int().min(1).max(730), default: 90, scopes: ['tenant'], editPermission: 'attendance.configure' }),
  def({ key: 'attendance.max_device_clock_drift_seconds', group: 'attendance', feature: 'attendance.biometric', label: 'Max tolerated device clock drift (seconds)', description: 'Devices reporting a clock further off than this are flagged; their events are corrected using the reported drift.',
    control: 'number', schema: z.number().int().min(0).max(3600), default: 300, scopes: ['tenant'], editPermission: 'attendance.configure' }),
  def({ key: 'attendance.overtime_enabled', group: 'attendance', feature: 'attendance', label: 'Calculate overtime minutes', description: 'Record overtime minutes on daily results for shifts that define an overtime threshold. Payout requires the Overtime/Payroll modules.',
    control: 'boolean', schema: z.boolean(), default: false, scopes: ['tenant'], editPermission: 'attendance.configure' }),

  // Overtime. Pay settings have no defaults: the organization enters the rate its law and contracts require (e.g. the Factories Act or the state Shops and Establishments Act).
  def({ key: 'overtime.claim_window_days', group: 'attendance', feature: 'overtime', label: 'Overtime claim window (days)', description: 'How many days back an employee may claim overtime recorded by attendance.',
    control: 'number', schema: z.number().int().min(1).max(90), default: 30, scopes: ['tenant'], editPermission: 'overtime.manage' }),
  def({ key: 'overtime.min_minutes', group: 'attendance', feature: 'overtime', label: 'Smallest overtime claim (minutes)', description: 'Overtime below this on a day cannot be claimed.',
    control: 'number', schema: z.number().int().min(0).max(240), default: 30, scopes: ['tenant'], editPermission: 'overtime.manage' }),
  def({ key: 'overtime.quarter_cap_hours', group: 'attendance', feature: 'overtime', label: 'Overtime limit per quarter (hours)', description: 'Claims beyond this many hours in a calendar quarter are refused. Limits differ by state and establishment; enter yours. 0 = no limit.',
    control: 'number', schema: z.number().int().min(0).max(1000), default: 0, scopes: ['tenant'], editPermission: 'overtime.manage' }),
  def({ key: 'overtime.rate_multiplier', group: 'attendance', feature: 'overtime', label: 'Overtime pay rate (× ordinary rate)', description: 'Multiple of the ordinary hourly rate paid for overtime, as your applicable law or contract requires. Not set = overtime cannot be paid.',
    control: 'number', schema: z.number().positive().max(5).nullable(), default: null, scopes: ['tenant'], editPermission: 'overtime.manage' }),
  def({ key: 'overtime.rate_basis', group: 'attendance', feature: 'overtime', label: 'Ordinary rate: pay components', description: 'Comma-separated pay component codes that make up the ordinary rate of wages (e.g. BASIC,DA). Not set = overtime cannot be paid.',
    control: 'text', schema: z.string().trim().toUpperCase().regex(/^([A-Z][A-Z0-9_]{0,19}(\s*,\s*[A-Z][A-Z0-9_]{0,19})*)?$/, 'Use component codes separated by commas'), default: '', scopes: ['tenant'], editPermission: 'overtime.manage' }),
  def({ key: 'overtime.days_divisor', group: 'attendance', feature: 'overtime', label: 'Ordinary rate: days per month', description: 'Monthly ordinary wages are divided by this many days for the daily rate (e.g. 26). 0 = the calendar days of the month worked. Not set = overtime cannot be paid.',
    control: 'number', schema: z.number().int().min(0).max(31).nullable(), default: null, scopes: ['tenant'], editPermission: 'overtime.manage' }),
  def({ key: 'overtime.hours_per_day', group: 'attendance', feature: 'overtime', label: 'Ordinary rate: hours per day', description: 'The daily rate is divided by this for the hourly rate (e.g. 8). Not set = overtime cannot be paid.',
    control: 'number', schema: z.number().positive().max(24).nullable(), default: null, scopes: ['tenant'], editPermission: 'overtime.manage' }),
  def({ key: 'overtime.esi_wages', group: 'attendance', feature: 'overtime', label: 'Overtime pay and ESI', description: 'Whether overtime pay counts toward ESI contribution wages (it never decides ESI coverage). Confirm the treatment for your establishment. Not set = overtime cannot be paid.',
    control: 'select', options: [{ value: '', label: 'Not set' }, { value: 'include', label: 'Include in ESI contribution wages' }, { value: 'exclude', label: 'Exclude from ESI wages' }],
    schema: z.enum(['', 'include', 'exclude']), default: '', scopes: ['tenant'], editPermission: 'overtime.manage' }),
  def({ key: 'overtime.comp_off_leave_type', group: 'attendance', feature: 'comp_off', label: 'Compensatory off: leave type', description: 'Code of the leave type credited when an employee takes compensatory off instead of pay (e.g. COMP). Empty = compensatory off is not offered.',
    control: 'text', schema: z.string().trim().toUpperCase().regex(/^([A-Z][A-Z0-9_]{0,19})?$/, 'Use a leave type code'), default: '', scopes: ['tenant'], editPermission: 'overtime.manage' }),
  def({ key: 'overtime.comp_off_day_minutes', group: 'attendance', feature: 'comp_off', label: 'Compensatory off: overtime minutes per day off', description: 'Overtime worth one day off; half of it earns half a day. Smaller claims cannot be taken as compensatory off.',
    control: 'number', schema: z.number().int().min(60).max(1440), default: 480, scopes: ['tenant'], editPermission: 'overtime.manage' }),

  // Field duty.
  def({ key: 'field_duty.backdate_days', group: 'attendance', feature: 'field_duty', label: 'Field duty: days back a request may start', description: 'Field duty can be recorded after the event up to this many days back (0 = only from today).',
    control: 'number', schema: z.number().int().min(0).max(60), default: 7, scopes: ['tenant'], editPermission: 'field_duty.manage' }),
  def({ key: 'field_duty.advance_days', group: 'attendance', feature: 'field_duty', label: 'Field duty: days ahead a request may start', description: 'How far ahead field duty can be planned.',
    control: 'number', schema: z.number().int().min(1).max(365), default: 90, scopes: ['tenant'], editPermission: 'field_duty.manage' }),
  def({ key: 'field_duty.max_days', group: 'attendance', feature: 'field_duty', label: 'Field duty: longest request (days)', description: 'Longer assignments are split into several requests.',
    control: 'number', schema: z.number().int().min(1).max(92), default: 31, scopes: ['tenant'], editPermission: 'field_duty.manage' }),
  def({ key: 'field_duty.hr_approval', group: 'attendance', feature: 'field_duty', label: 'Field duty: HR approves after the manager', description: 'When off, the reporting manager\'s approval is enough. HR always approves when the employee has no manager with an account.',
    control: 'boolean', schema: z.boolean(), default: false, scopes: ['tenant'], editPermission: 'field_duty.manage' }),

  // Travel (the organization's travel policy; nothing here is statutory).
  def({ key: 'travel.min_notice_days', group: 'general', feature: 'travel', label: 'Travel: days of notice', description: 'How many days before a trip starts it must be requested (0 = up to the day itself).',
    control: 'number', schema: z.number().int().min(0).max(60), default: 0, scopes: ['tenant'], editPermission: 'travel.manage' }),
  def({ key: 'travel.max_days', group: 'general', feature: 'travel', label: 'Travel: longest trip (days)', description: 'Longer travel is split into several requests.',
    control: 'number', schema: z.number().int().min(1).max(180), default: 60, scopes: ['tenant'], editPermission: 'travel.manage' }),
  def({ key: 'travel.max_advance_percent', group: 'general', feature: 'travel', label: 'Travel: largest advance (% of the estimate)', description: 'An advance can be at most this share of the trip\'s estimated cost.',
    control: 'number', schema: z.number().int().min(0).max(100), default: 80, scopes: ['tenant'], editPermission: 'travel.manage' }),
  def({ key: 'travel.finance_approval_above', group: 'general', feature: 'travel', label: 'Travel: finance approves estimates from', description: 'Trips estimated at or above this also need finance approval. Empty = only trips with an advance, trips abroad and trips of people without a manager.',
    control: 'number', schema: z.number().min(0).nullable(), default: null, scopes: ['tenant'], editPermission: 'travel.manage' }),
  // Salary advances and loans (the organization's policy).
  def({ key: 'loans.advance_max_installments', group: 'general', feature: 'salary_advance', label: 'Salary advance: most instalments', description: 'A salary advance is recovered in at most this many monthly instalments.',
    control: 'number', schema: z.number().int().min(1).max(24), default: 3, scopes: ['tenant'], editPermission: 'loans.manage' }),
  def({ key: 'loans.max_installments', group: 'general', feature: 'loans', label: 'Loan: most instalments', description: 'A loan is recovered in at most this many monthly instalments.',
    control: 'number', schema: z.number().int().min(1).max(120), default: 24, scopes: ['tenant'], editPermission: 'loans.manage' }),
  def({ key: 'loans.max_advance_amount', group: 'general', feature: 'salary_advance', label: 'Salary advance: largest amount', description: 'Empty = no limit (finance decides at approval).',
    control: 'number', schema: z.number().int().positive().nullable(), default: null, scopes: ['tenant'], editPermission: 'loans.manage' }),
  def({ key: 'loans.max_loan_amount', group: 'general', feature: 'loans', label: 'Loan: largest amount', description: 'Empty = no limit (finance decides at approval).',
    control: 'number', schema: z.number().int().positive().nullable(), default: null, scopes: ['tenant'], editPermission: 'loans.manage' }),
  def({ key: 'loans.one_at_a_time', group: 'general', feature: ['loans', 'salary_advance'], label: 'One advance and one loan at a time', description: 'Refuse a new salary advance (or loan) while another is pending, approved or not yet repaid.',
    control: 'boolean', schema: z.boolean(), default: true, scopes: ['tenant'], editPermission: 'loans.manage' }),
  // Accounting exports (Tally import).
  def({ key: 'accounting.tally_company', group: 'general', feature: 'accounting_exports', label: 'Tally: company name', description: 'Exact company name in Tally to import into. Empty = the company open in Tally at import.',
    control: 'text', schema: z.string().trim().max(200), default: '', scopes: ['tenant'], editPermission: 'accounting.configure' }),
  def({ key: 'accounting.tally_voucher_type', group: 'general', feature: 'accounting_exports', label: 'Tally: voucher type', description: 'Voucher type the journals are imported as (it must exist in Tally).',
    control: 'text', schema: z.string().trim().min(1).max(100), default: 'Journal', scopes: ['tenant'], editPermission: 'accounting.configure' }),

  def({ key: 'leave.year_start_month', group: 'attendance', feature: 'leave', label: 'Leave year starts in', description: 'Month in which the leave year begins (balances, accruals and carry-forward follow this year).',
    control: 'select', options: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => ({ value: String(i + 1), label: m })),
    schema: z.coerce.number().int().min(1).max(12), default: 1, scopes: ['tenant'], editPermission: 'leave.manage' }),
  def({ key: 'notifications.approval_reminder_days', group: 'notifications', label: 'Remind approvers after (days)', description: 'Approvers get a daily reminder for requests waiting longer than this. 0 turns reminders off.',
    control: 'number', schema: z.number().int().min(0).max(30), default: 2, scopes: ['tenant'], editPermission: 'settings.manage' }),
  def({ key: 'approvals.escalate_after_days', group: 'notifications', label: 'Escalate unanswered approvals after (days)', description: "A request waiting this long for one person (e.g. the reporting manager) also goes to that person's manager, or to HR when they have none. They can still decide it themselves. Requests for a group (HR, finance) are not escalated, unless nobody in the group can act. 0 turns escalation off.",
    control: 'number', schema: z.number().int().min(0).max(30), default: 5, scopes: ['tenant'], editPermission: 'settings.manage' }),
  def({ key: 'expenses.claim_window_days', group: 'general', feature: 'expenses', label: 'Expense claim window (days)', description: 'Expenses older than this cannot be claimed.',
    control: 'number', schema: z.number().int().min(7).max(365), default: 60, scopes: ['tenant'], editPermission: 'expenses.manage' }),
  def({ key: 'competency.assessment_validity_days', group: 'general', feature: 'lab.competency', label: 'Competency assessment validity (days)', description: 'An authorization can only be requested on an assessment at most this old.',
    control: 'number', schema: z.number().int().min(30).max(730), default: 180, scopes: ['tenant'], editPermission: 'competency.manage' }),
  def({ key: 'recruitment.retention_months', group: 'general', feature: 'recruitment', label: 'Keep candidate data for (months)', description: 'Candidates who are not hired are anonymized and their resumes deleted this long after they were added (unless still in an open process).',
    control: 'number', schema: z.number().int().min(1).max(60), default: 12, scopes: ['tenant'], editPermission: 'recruitment.manage' }),
  def({ key: 'offboarding.notice_days', group: 'general', feature: 'core.offboarding', label: 'Notice period (calendar days)', description: 'Used to compute the expected last working day and any notice shortfall. Follow your appointment letters / standing orders.',
    control: 'number', schema: z.number().int().min(0).max(180), default: 30, scopes: ['tenant'], editPermission: 'lifecycle.manage' }),
  def({ key: 'probation.review_lead_days', group: 'general', feature: 'core.onboarding', label: 'Start probation reviews (days before end)', description: 'The reporting manager is asked for a recommendation this many days before probation ends.',
    control: 'number', schema: z.number().int().min(1).max(60), default: 14, scopes: ['tenant'], editPermission: 'lifecycle.manage' }),
  def({ key: 'payroll.expected_statutory', group: 'general', feature: 'payroll.statutory', label: 'Statutory deductions this organization applies', description: 'Comma-separated: pf, esi, pt, lwf, tds. A run warns (and needs acknowledgement) when one of these has no active, verified rule.',
    control: 'text', schema: z.string().trim().regex(/^((pf|esi|pt|lwf|tds)(\s*,\s*(pf|esi|pt|lwf|tds))*)?$/, 'Use pf, esi, pt, lwf, tds separated by commas'), default: 'pf,esi,pt,tds', scopes: ['tenant'], editPermission: 'payroll.statutory' }),
  def({ key: 'payroll.missing_punch_is_lop', group: 'general', feature: 'payroll', label: 'Count unresolved missing punches as loss of pay', description: 'When off, missing-punch days are paid but flagged as warnings on the run.',
    control: 'boolean', schema: z.boolean(), default: true, scopes: ['tenant'], editPermission: 'payroll.manage' }),
  def({ key: 'grievance.response_days', group: 'general', feature: 'grievance', label: 'Grievance response target (days)', description: 'Handlers are reminded when a grievance is open longer than this.',
    control: 'number', schema: z.number().int().min(1).max(90), default: 15, scopes: ['tenant'], editPermission: 'grievance.manage' }),
  def({ key: 'security.manager_team_salaries', group: 'security', feature: 'payroll', label: 'Managers can see team salaries', description: 'Off: managers see no salary, loan or payslip of their team. On: they can, for people below their own salary level.',
    control: 'boolean', schema: z.boolean(), default: false, scopes: ['tenant'], editPermission: 'security.manage' }),
  def({ key: 'security.aadhaar_collection', group: 'security', feature: 'payroll.statutory', label: 'Collect Aadhaar numbers', description: 'Off by default. Indian law limits who may ask for and keep an Aadhaar number: turn this on only with legal advice and a lawful basis. Numbers are encrypted and only their last four digits are ever shown.',
    control: 'boolean', schema: z.boolean(), default: false, scopes: ['tenant'], editPermission: 'security.manage' }),
  def({ key: 'security.session_ttl_hours', group: 'security', label: 'Session lifetime (hours)', description: 'Users are signed out after this long. Cannot exceed the deployment maximum.',
    control: 'number', schema: z.number().int().min(1).max(720), default: 12, scopes: ['tenant'], editPermission: 'security.manage',
    deploymentCeiling: (e) => e.sessionTtlHours }),
  def({ key: 'security.mfa_enforcement', group: 'security', label: 'Two-factor authentication', description: 'Who must use an authenticator app. The installation sets a minimum (MFA_ENFORCEMENT); this can only make it stricter.',
    control: 'select', options: [{ value: 'off', label: 'Optional for everyone' }, { value: 'privileged', label: 'Required for administrators, HR admins, payroll and IT' }, { value: 'all', label: 'Required for everyone' }],
    schema: z.enum(['off', 'privileged', 'all']), default: 'off', scopes: ['tenant'], editPermission: 'security.manage' }),
  def({ key: 'security.max_failed_logins', group: 'security', label: 'Failed sign-ins before lockout', description: 'Account is locked for 15 minutes after this many consecutive failures.',
    control: 'number', schema: z.number().int().min(3).max(10), default: 5, scopes: ['tenant'], editPermission: 'security.manage' }),
  def({ key: 'security.password_min_length', group: 'security', label: 'Minimum password length', description: 'At least 12 characters, whatever is set here. Leaked passwords, and ones made of your name or email address, are always refused.',
    control: 'number', schema: z.number().int().min(12).max(128), default: 12, scopes: ['tenant'], editPermission: 'security.manage' }),
];

export const SETTINGS_MAP: ReadonlyMap<string, SettingDefinition> = new Map(SETTINGS.map((s) => [s.key, s]));

function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-IN', { timeZone: tz }); return true; } catch { return false; }
}
