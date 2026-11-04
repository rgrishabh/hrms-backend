/**
 * Central, typed feature registry. Adding a module = adding an entry here
 * (+ its routes guarded by `requireFeature`). The settings center renders
 * from this list, so no UI redesign is needed for new modules.
 *
 * Module state, evaluated in ./state.ts:
 *   supported (implemented in this release) → enabled (deployment config
 *   ENABLED_MODULES, validated at startup) → configured → operational
 *
 * Security, tenant isolation, audit logging and payroll integrity are NOT
 * modules: they are always-on platform services and cannot appear here.
 */

export type FeatureCategory =
  | 'core_hr' | 'workforce' | 'payroll_finance' | 'talent' | 'operations';

export type Availability = 'available' | 'preview' | 'planned';

export interface FeatureDefinition {
  key: string;
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

export const FEATURES: readonly FeatureDefinition[] = [
  // ---- Core HR
  f({ key: 'core.employees', name: 'Employee management', description: 'Employee master records, profiles and history.', category: 'core_hr', availability: 'available', core: true, defaultEnabled: true }),
  f({ key: 'core.org_structure', name: 'Organization structure', description: 'Legal entities, branches and departments.', category: 'core_hr', availability: 'available', core: true, defaultEnabled: true }),
  f({ key: 'core.self_service', name: 'Employee self-service', description: 'Employees view their own records, attendance and requests.', category: 'core_hr', availability: 'available', defaultEnabled: true, dependencies: ['core.employees'] }),
  f({ key: 'core.documents', name: 'Employee documents', description: 'Employee and company documents with categories, restricted access, expiry reminders and audited downloads.', category: 'core_hr', availability: 'available', defaultEnabled: true, dependencies: ['core.employees'] }),
  f({ key: 'core.onboarding', name: 'Onboarding & probation', description: 'Onboarding checklists (HR, IT, manager, new joiner), joining confirmation, probation reviews with approval.', category: 'core_hr', availability: 'available', dependencies: ['core.employees'] }),
  f({ key: 'core.offboarding', name: 'Separation & exit', description: 'Resignation and HR-initiated separations with approval, notice shortfall, exit clearance checklist, exit interview, access ended on the last working day.', category: 'core_hr', availability: 'available', dependencies: ['core.employees'] }),
  f({ key: 'core.policies', name: 'Policy management', description: 'Versioned policies with maker-checker publication, audiences, and employee acknowledgements tied to the exact content.', category: 'core_hr', availability: 'available', dependencies: ['core.employees'] }),

  // ---- Workforce
  f({ key: 'attendance', name: 'Attendance', description: 'Attendance engine: raw events, daily calculation, exceptions, locking.', category: 'workforce', availability: 'available', defaultEnabled: true, dependencies: ['core.employees'], requiredSettings: ['attendance.weekly_offs'] }),
  f({ key: 'attendance.web', name: 'Web attendance', description: 'Clock in/out from the browser.', category: 'workforce', availability: 'available', defaultEnabled: true, dependencies: ['attendance'] }),
  f({ key: 'attendance.mobile', name: 'Mobile attendance', description: 'Clock in/out from the mobile web app, with optional location capture.', category: 'workforce', availability: 'available', dependencies: ['attendance'] }),
  f({ key: 'attendance.biometric', name: 'Biometric attendance', description: 'Event ingestion from registered biometric devices via a vendor-neutral adapter.', category: 'workforce', availability: 'available', dependencies: ['attendance'] }),
  f({ key: 'attendance.regularization', name: 'Attendance regularization', description: 'Employees request corrections; approved via workflow.', category: 'workforce', availability: 'available', defaultEnabled: true, dependencies: ['attendance'] }),
  f({ key: 'shifts', name: 'Shift management', description: 'Shift templates and employee shift assignments.', category: 'workforce', availability: 'available', defaultEnabled: true, dependencies: ['attendance'] }),
  f({ key: 'holidays', name: 'Holiday calendars', description: 'Tenant and branch holiday calendars.', category: 'workforce', availability: 'available', defaultEnabled: true, dependencies: ['attendance'] }),
  f({ key: 'leave', name: 'Leave management', description: 'Leave types, balance ledger, accruals, requests with approval, and attendance integration.', category: 'workforce', availability: 'available', defaultEnabled: true, dependencies: ['core.employees'], requiredSettings: ['leave.year_start_month'] }),
  f({ key: 'overtime', name: 'Overtime', description: 'Overtime claims from calculated attendance, approved by the manager and HR, paid through payroll at the rate the organization sets, or taken as compensatory off.', category: 'workforce', availability: 'available', dependencies: ['attendance'] }),
  f({ key: 'field_duty', name: 'Field duty', description: 'Field sampling, client-site and other duty away from the workplace, counted as paid days in attendance.', category: 'workforce', availability: 'available', dependencies: ['attendance'] }),

  // ---- Payroll & finance
  f({ key: 'payroll', name: 'Payroll', description: 'Components, approved effective-dated salaries, payroll runs from attendance (LOP), approval and locking, payslips, bank/PF/ESI/register exports, F&F runs.', category: 'payroll_finance', availability: 'available', dependencies: ['core.employees', 'attendance'] }),
  f({ key: 'payroll.payslips', name: 'Payslips (self-service)', description: 'Employees see their payslips once a run is finalized.', category: 'payroll_finance', availability: 'available', dependencies: ['payroll'] }),
  f({ key: 'payroll.statutory', name: 'Statutory deductions', description: 'PF, ESI, PT, LWF and TDS from a rule register whose values the organization enters and verifies (maker-checker).', category: 'payroll_finance', availability: 'available', dependencies: ['payroll'] }),
  f({ key: 'expenses', name: 'Expenses & reimbursements', description: 'Claims with receipts, manager + finance approval, duplicate checks, payment batches with maker-checker.', category: 'payroll_finance', availability: 'available', dependencies: ['core.employees'] }),
  f({ key: 'travel', name: 'Travel management', description: 'Trip requests with estimates and advances, settled against the trip\'s expense claim; trip days count as field duty.', category: 'payroll_finance', availability: 'available', dependencies: ['expenses'] }),
  f({ key: 'advances_loans', name: 'Advances and loans', description: 'Salary advances and interest-free loans, recovered in monthly instalments through payroll.', category: 'payroll_finance', availability: 'available', dependencies: ['payroll'] }),
  f({ key: 'accounting_exports', name: 'Accounting exports', description: 'Ledger exports for payroll and reimbursements.', category: 'payroll_finance', availability: 'planned', dependencies: ['payroll'] }),

  // ---- Talent & lab
  f({ key: 'recruitment', name: 'Recruitment', description: 'Approved requisitions, candidates with consent and retention, interview pipeline with panel feedback, approved offers, hire into employee records.', category: 'talent', availability: 'available', dependencies: ['core.employees'] }),
  f({ key: 'performance', name: 'Performance reviews', description: 'Review cycles, weighted goals agreed with the manager, self and manager reviews, HR-finalized ratings acknowledged by the employee.', category: 'talent', availability: 'available', dependencies: ['core.employees'] }),
  f({ key: 'training', name: 'Training records', description: 'Training courses with validity, employee training records, expiry reminders.', category: 'talent', availability: 'available', dependencies: ['core.employees'] }),
  f({ key: 'lab.competency', name: 'Laboratory competency & technical authorization', description: 'Methods with training prerequisites, competency assessments, quality-approved technical authorizations with periodic review, competence matrix.', category: 'talent', availability: 'available', dependencies: ['training'] }),

  // ---- Operations & compliance
  f({ key: 'assets', name: 'Assets', description: 'Asset register (lab instruments, IT, PPE…), issue and return with acknowledgement, calibration due reminders, exit clearance check.', category: 'operations', availability: 'available', dependencies: ['core.employees'] }),
  f({ key: 'grievance', name: 'Grievances', description: 'Confidential grievances (optionally anonymous) with handler assignment, response target and complainant-visible updates.', category: 'operations', availability: 'available', dependencies: ['core.employees'] }),
  f({ key: 'posh', name: 'POSH complaints', description: 'Complaints to the Internal Committee only (not visible to administrators), statutory timelines, encrypted narrative, annual report counts.', category: 'operations', availability: 'available', dependencies: ['core.employees'] }),
  f({ key: 'notifications.email', name: 'Email notifications', description: 'Approval alerts, reminders and security notices by email (SMTP configured by the deployment).', category: 'operations', availability: 'available' }),
  f({ key: 'notifications.sms', name: 'SMS notifications', description: 'Selected notifications by SMS through your provider, using your DLT-registered templates.', category: 'operations', availability: 'available' }),
  f({ key: 'reports.advanced', name: 'Advanced reporting', description: 'Cross-module reports and scheduled exports.', category: 'operations', availability: 'planned' }),
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
})();

export function dependentsOf(key: string): FeatureDefinition[] {
  return FEATURES.filter((d) => d.dependencies.includes(key));
}
