/**
 * Central, typed feature registry. Adding a module = adding an entry here
 * (+ its routes guarded by `requireFeature`). The settings center renders
 * from this list, so no UI redesign is needed for new modules.
 *
 * The single source of truth for FEATURE_* flags (Layer 1 of docs/CONFIGURATION.md in hrms-deployment).
 * Module state, evaluated in ./state.ts:
 *   supported (implemented in this release) → enabled (the deployment's FEATURE_* variable, validated at
 *   startup) → configured → operational
 *
 * Security, tenant isolation, audit logging and payroll integrity are NOT
 * modules: they are always-on platform services and cannot appear here.
 */

export type FeatureCategory =
  | 'core_hr' | 'workforce' | 'payroll_finance' | 'talent' | 'operations';

export type Availability = 'available' | 'preview' | 'planned';

export interface FeatureDefinition {
  key: string;
  /** The environment variable that turns it on or off. Always-on platform modules have none. */
  envName: string | null;
  name: string;
  description: string;
  category: FeatureCategory;
  /** 'planned' = not implemented in this build; cannot be enabled by anyone. */
  availability: Availability;
  defaultEnabled: boolean;
  dependencies: readonly string[];
  /** Core modules are always enabled and cannot be disabled. */
  core: boolean;
  /** Permission needed to use the module at all (in addition to per-action ones). */
  requiredPermission?: string;
  /** Setting keys that must have a value before the module counts as configured. */
  requiredSettings?: readonly string[];
}

const f = (d: Omit<FeatureDefinition, 'core' | 'defaultEnabled' | 'dependencies'> &
  Partial<Pick<FeatureDefinition, 'core' | 'defaultEnabled' | 'dependencies'>>): FeatureDefinition => ({
  core: false, defaultEnabled: false, dependencies: [], ...d,
});

/** Flags defined here but with no row in this table would be a typo waiting to ship: the two lists are checked against each other at import. */
const ENV_NAMES: Record<string, string> = {
  'core.documents': 'FEATURE_DOCUMENTS', 'core.onboarding': 'FEATURE_ONBOARDING', 'core.offboarding': 'FEATURE_OFFBOARDING', 'core.policies': 'FEATURE_POLICIES',
  attendance: 'FEATURE_ATTENDANCE', 'attendance.web': 'FEATURE_ATTENDANCE_WEB', 'attendance.mobile': 'FEATURE_ATTENDANCE_MOBILE', 'attendance.geofence': 'FEATURE_ATTENDANCE_GEOFENCE',
  'attendance.selfie': 'FEATURE_ATTENDANCE_SELFIE', 'attendance.biometric': 'FEATURE_ATTENDANCE_BIOMETRIC', 'attendance.regularization': 'FEATURE_ATTENDANCE_REGULARIZATION',
  shifts: 'FEATURE_SHIFTS', holidays: 'FEATURE_HOLIDAYS', leave: 'FEATURE_LEAVE', overtime: 'FEATURE_OVERTIME', comp_off: 'FEATURE_COMP_OFF', field_duty: 'FEATURE_FIELD_DUTY',
  payroll: 'FEATURE_PAYROLL', 'payroll.payslips': 'FEATURE_PAYSLIPS', 'payroll.statutory': 'FEATURE_PAYROLL_STATUTORY', loans: 'FEATURE_LOANS', salary_advance: 'FEATURE_SALARY_ADVANCE',
  accounting_exports: 'FEATURE_ACCOUNTING_EXPORTS', expenses: 'FEATURE_EXPENSE_CLAIMS', travel: 'FEATURE_TRAVEL', recruitment: 'FEATURE_RECRUITMENT', performance: 'FEATURE_PERFORMANCE_REVIEW',
  training: 'FEATURE_TRAINING', 'lab.competency': 'FEATURE_LAB_COMPETENCY', assets: 'FEATURE_ASSET_MANAGEMENT', grievance: 'FEATURE_GRIEVANCE', posh: 'FEATURE_POSH',
  'reports.advanced': 'FEATURE_REPORTS_ADVANCED', 'notifications.email': 'FEATURE_EMAIL_NOTIFICATIONS', 'notifications.push': 'FEATURE_PUSH_NOTIFICATIONS',
};

const d = (x: Omit<Parameters<typeof f>[0], 'envName'>): FeatureDefinition => f({ ...x, envName: ENV_NAMES[x.key] ?? null });

export const FEATURES: readonly FeatureDefinition[] = [
  // ---- Core HR
  d({ key: 'core.employees', name: 'Employee management', description: 'Employee master records, profiles and history.', category: 'core_hr', availability: 'available', core: true, defaultEnabled: true }),
  d({ key: 'core.org_structure', name: 'Organization structure', description: 'Legal entities, branches and departments.', category: 'core_hr', availability: 'available', core: true, defaultEnabled: true }),
  d({ key: 'core.self_service', name: 'Employee self-service', description: 'Employees view their own records, attendance and requests.', category: 'core_hr', availability: 'available', core: true, defaultEnabled: true, dependencies: ['core.employees'] }),
  d({ key: 'core.documents', name: 'Employee documents', description: 'Employee and company documents with categories, restricted access, expiry reminders and audited downloads.', category: 'core_hr', availability: 'available', defaultEnabled: true, dependencies: ['core.employees'] }),
  d({ key: 'core.onboarding', name: 'Onboarding & probation', description: 'Onboarding checklists (HR, IT, manager, new joiner), joining confirmation, probation reviews with approval.', category: 'core_hr', availability: 'available', dependencies: ['core.employees'] }),
  d({ key: 'core.offboarding', name: 'Separation & exit', description: 'Resignation and HR-initiated separations with approval, notice shortfall, exit clearance checklist, exit interview, access ended on the last working day.', category: 'core_hr', availability: 'available', dependencies: ['core.employees'] }),
  d({ key: 'core.policies', name: 'Policy management', description: 'Versioned policies with maker-checker publication, audiences, and employee acknowledgements tied to the exact content.', category: 'core_hr', availability: 'available', dependencies: ['core.employees'] }),

  // ---- Workforce
  d({ key: 'attendance', name: 'Attendance', description: 'Attendance engine: raw events, daily calculation, exceptions, locking.', category: 'workforce', availability: 'available', defaultEnabled: true, dependencies: ['core.employees'], requiredSettings: ['attendance.weekly_offs'] }),
  d({ key: 'attendance.web', name: 'Web attendance', description: 'Clock in/out from the browser.', category: 'workforce', availability: 'available', defaultEnabled: true, dependencies: ['attendance'] }),
  d({ key: 'attendance.mobile', name: 'Mobile attendance', description: 'Clock in/out from the mobile web app.', category: 'workforce', availability: 'available', dependencies: ['attendance'] }),
  d({ key: 'attendance.geofence', name: 'Location and geofence', description: 'Captures the location at clock-in as the location policy says, and checks it against the geofence of the branch.', category: 'workforce', availability: 'available', dependencies: ['attendance'] }),
  d({ key: 'attendance.selfie', name: 'Check-in selfie', description: 'A camera photo at clock-in, kept for the retention period the organization sets.', category: 'workforce', availability: 'available', dependencies: ['attendance'] }),
  d({ key: 'attendance.biometric', name: 'Biometric attendance', description: 'Event ingestion from registered biometric devices via a vendor-neutral adapter.', category: 'workforce', availability: 'available', dependencies: ['attendance'] }),
  d({ key: 'attendance.regularization', name: 'Attendance regularization', description: 'Employees request corrections; approved via workflow.', category: 'workforce', availability: 'available', defaultEnabled: true, dependencies: ['attendance'] }),
  d({ key: 'shifts', name: 'Shift management', description: 'Shift templates and employee shift assignments.', category: 'workforce', availability: 'available', defaultEnabled: true, dependencies: ['attendance'] }),
  d({ key: 'holidays', name: 'Holiday calendars', description: 'Tenant and branch holiday calendars.', category: 'workforce', availability: 'available', defaultEnabled: true, dependencies: ['attendance'] }),
  d({ key: 'leave', name: 'Leave management', description: 'Leave types, balance ledger, accruals, requests with approval, and attendance integration.', category: 'workforce', availability: 'available', defaultEnabled: true, dependencies: ['core.employees'], requiredSettings: ['leave.year_start_month'] }),
  d({ key: 'overtime', name: 'Overtime', description: 'Overtime claims from calculated attendance, approved by the manager and HR, paid through payroll at the rate the organization sets.', category: 'workforce', availability: 'available', dependencies: ['attendance'] }),
  d({ key: 'comp_off', name: 'Compensatory off', description: 'Approved overtime taken as leave instead of pay.', category: 'workforce', availability: 'available', dependencies: ['leave', 'overtime'] }),
  d({ key: 'field_duty', name: 'Field duty', description: 'Field sampling, client-site and other duty away from the workplace, counted as paid days in attendance.', category: 'workforce', availability: 'available', dependencies: ['attendance'] }),

  // ---- Payroll & finance
  d({ key: 'payroll', name: 'Payroll', description: 'Components, approved effective-dated salaries, payroll runs from attendance (LOP), approval and locking, payslips, bank/PF/ESI/register exports, F&F runs.', category: 'payroll_finance', availability: 'available', dependencies: ['core.employees', 'attendance'] }),
  d({ key: 'payroll.payslips', name: 'Payslips (self-service)', description: 'Employees see their payslips once a run is finalized.', category: 'payroll_finance', availability: 'available', dependencies: ['payroll'] }),
  d({ key: 'payroll.statutory', name: 'Statutory deductions', description: 'PF, ESI, PT, LWF and TDS from a rule register whose values the organization enters and verifies (maker-checker).', category: 'payroll_finance', availability: 'available', dependencies: ['payroll'] }),
  d({ key: 'expenses', name: 'Expenses & reimbursements', description: 'Claims with receipts, manager + finance approval, duplicate checks, payment batches with maker-checker.', category: 'payroll_finance', availability: 'available', dependencies: ['core.employees'] }),
  d({ key: 'travel', name: 'Travel management', description: 'Trip requests with estimates and advances, settled against the trip\'s expense claim; trip days count as field duty.', category: 'payroll_finance', availability: 'available', dependencies: ['expenses'] }),
  d({ key: 'loans', name: 'Employee loans', description: 'Interest-free loans, recovered in monthly instalments through payroll.', category: 'payroll_finance', availability: 'available', dependencies: ['payroll'] }),
  d({ key: 'salary_advance', name: 'Salary advances', description: 'Advances on salary, recovered through payroll.', category: 'payroll_finance', availability: 'available', dependencies: ['payroll'] }),
  d({ key: 'accounting_exports', name: 'Accounting exports', description: 'Payroll and reimbursement journals for the accounts, mapped to your ledgers (CSV or Tally XML).', category: 'payroll_finance', availability: 'available', dependencies: ['payroll'] }),

  // ---- Talent & lab
  d({ key: 'recruitment', name: 'Recruitment', description: 'Approved requisitions, candidates with consent and retention, interview pipeline with panel feedback, approved offers, hire into employee records.', category: 'talent', availability: 'available', dependencies: ['core.employees'] }),
  d({ key: 'performance', name: 'Performance reviews', description: 'Review cycles, weighted goals agreed with the manager, self and manager reviews, HR-finalized ratings acknowledged by the employee.', category: 'talent', availability: 'available', dependencies: ['core.employees'] }),
  d({ key: 'training', name: 'Training records', description: 'Training courses with validity, employee training records, expiry reminders.', category: 'talent', availability: 'available', dependencies: ['core.employees'] }),
  d({ key: 'lab.competency', name: 'Laboratory competency & technical authorization', description: 'Methods with training prerequisites, competency assessments, quality-approved technical authorizations with periodic review, competence matrix.', category: 'talent', availability: 'available', dependencies: ['training'] }),

  // ---- Operations & compliance
  d({ key: 'assets', name: 'Assets', description: 'Asset register (lab instruments, IT, PPE…), issue and return with acknowledgement, calibration due reminders, exit clearance check.', category: 'operations', availability: 'available', dependencies: ['core.employees'] }),
  d({ key: 'grievance', name: 'Grievances', description: 'Confidential grievances (optionally anonymous) with handler assignment, response target and complainant-visible updates.', category: 'operations', availability: 'available', dependencies: ['core.employees'] }),
  d({ key: 'posh', name: 'POSH complaints', description: 'Complaints to the Internal Committee only (not visible to administrators), statutory timelines, encrypted narrative, annual report counts.', category: 'operations', availability: 'available', dependencies: ['core.employees'] }),
  d({ key: 'notifications.email', name: 'Email notifications', description: 'Approval alerts, reminders and security notices by email (SMTP configured by the deployment).', category: 'operations', availability: 'available', defaultEnabled: true }),
  d({ key: 'notifications.push', name: 'Push notifications', description: 'Browser push alerts. They say that something needs attention, never what it says.', category: 'operations', availability: 'available' }),
  d({ key: 'reports.advanced', name: 'Advanced reporting', description: 'Saved reports, scheduled reports delivered in the app, and a cross-module department overview.', category: 'operations', availability: 'available' }),
] as const;

export const FEATURE_MAP: ReadonlyMap<string, FeatureDefinition> = new Map(FEATURES.map((d) => [d.key, d]));

/** Validated at import: unknown dependencies or cycles are programmer errors. */
(function validateRegistry() {
  for (const d of FEATURES) {
    for (const dep of d.dependencies) {
      if (!FEATURE_MAP.has(dep)) throw new Error(`Feature ${d.key} depends on unknown feature ${dep}`);
    }
  }
  const visiting = new Set<string>(); const done = new Set<string>();
  const visit = (k: string) => {
    if (done.has(k)) return;
    if (visiting.has(k)) throw new Error(`Feature dependency cycle at ${k}`);
    visiting.add(k);
    for (const dep of FEATURE_MAP.get(k)!.dependencies) visit(dep);
    visiting.delete(k); done.add(k);
  };
  FEATURES.forEach((d) => visit(d.key));
  for (const d of FEATURES) {
    if (!d.core && !d.envName) throw new Error(`Feature ${d.key} has no environment variable`);
    if (d.core && d.envName) throw new Error(`Always-on feature ${d.key} cannot have a flag`);
  }
  for (const k of Object.keys(ENV_NAMES)) if (!FEATURE_MAP.has(k)) throw new Error(`Environment variable for unknown feature ${k}`);
})();

export const FEATURE_BY_ENV: ReadonlyMap<string, FeatureDefinition> = new Map(FEATURES.filter((d) => d.envName).map((d) => [d.envName!, d]));

/**
 * The set of features on for this deployment, from its FEATURE_* variables. Everything wrong is reported at once:
 * an unknown flag (a typo), a value other than true or false, a feature on while one it requires is off.
 * An empty variable counts as unset, because Docker Compose passes unset optional variables as ''.
 */
export function resolveFeatures(source: Record<string, string | undefined>): { features: ReadonlySet<string>; problems: string[] } {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (!name.startsWith('FEATURE_') || value === undefined || value === '') continue;
    if (!FEATURE_BY_ENV.has(name)) problems.push(`${name}: not a known feature flag (see core/features/registry.ts)`);
    else if (value !== 'true' && value !== 'false') problems.push(`${name}: must be true or false`);
  }
  const on = (x: FeatureDefinition) => {
    if (x.core) return true;
    const v = source[x.envName!];
    return v === 'true' || ((v === undefined || v === '') && x.defaultEnabled);
  };
  const features = new Set(FEATURES.filter(on).map((x) => x.key));
  for (const x of FEATURES) {
    if (!features.has(x.key)) continue;
    for (const dep of x.dependencies) {
      if (!features.has(dep)) problems.push(`${x.envName}: is on${source[x.envName!] ? '' : ' by default'} but requires ${FEATURE_MAP.get(dep)!.envName}, which is off`);
    }
  }
  return { features, problems };
}

export function dependentsOf(key: string): FeatureDefinition[] {
  return FEATURES.filter((d) => d.dependencies.includes(key));
}
