import type { ManagementMode } from '../policy/mode.js';

/**
 * Permission catalogue and system roles. Server-side checks use these; the UI
 * only mirrors them for visibility. What a role resolves to depends on ORG_MANAGEMENT_MODE
 * (resolveRolePermissions). Who can see whose L4 data is decided by core/policy/salary.ts on top of these.
 * Branding, domains and modules are deployment-controlled, so no role can change them.
 */
export const PERMISSIONS = {
  // tenant administration
  'settings.read': 'View tenant settings',
  'settings.manage': 'Change general tenant settings',
  'security.manage': 'Change security settings',
  'users.manage': 'Manage user accounts and role assignments',
  'audit.read': 'View audit history',
  'approvals.delegations': "Hand over someone's approvals to a colleague (e.g. for an unplanned absence)",
  'approvals.escalations': 'Decide approvals escalated because the approver did not respond and has no manager to take them',
  'approvals.hr_step': 'Decide one-step HR approvals (single_hr mode)',
  // organization & employees
  'org.read': 'View legal entities, branches and departments',
  'org.manage': 'Manage legal entities, branches and departments',
  'employees.directory': 'View employee directory (basic fields)',
  'employees.read': 'View full employee records',
  'employees.manage': 'Create and update employee records',
  'employees.bank.read': 'View masked bank details',
  'employees.bank.manage': 'Propose changes to bank details',
  'employees.bank.approve': "Approve changes to someone's bank details (not ones you proposed)",
  'profile.self': 'Keep your own personal details up to date (nominee, education and employment history changes need HR approval)',
  'profile.approve': "Approve employees' changes to their nominees, education and employment history",
  // attendance
  'attendance.self': 'Clock in/out and view own attendance',
  'attendance.team.read': 'View attendance of reporting team',
  'attendance.read': 'View attendance of all employees',
  'attendance.recalculate': 'Recalculate attendance results',
  'attendance.approve': 'Approve attendance regularizations at HR level',
  'attendance.configure': 'Configure attendance policies, shifts and holidays',
  'attendance.devices.manage': 'Register and manage biometric devices',
  'attendance.lock': 'Lock attendance periods for payroll',
  // documents
  'documents.self': 'View own documents and upload where a category allows it',
  'documents.read': 'View employee and company documents (not restricted categories)',
  'documents.payroll': 'View employee documents in payroll categories only (not restricted ones)',
  'documents.restricted': 'View restricted documents (e.g. medical, identity)',
  'documents.manage': 'Upload and archive any document; manage document categories',
  // expenses
  'expenses.self': 'Create and submit own expense claims',
  'expenses.team.read': 'View expense claims of reporting team',
  'expenses.read': 'View all expense claims and reports',
  'expenses.approve': 'Approve expense claims at finance level',
  'expenses.pay': 'Prepare, approve and record reimbursement payment batches',
  'expenses.manage': 'Configure expense categories and limits',
  'performance.self': 'Set my goals, write my self-review, see my finalized review',
  'performance.manage': 'Run review cycles and finalize ratings',
  'assets.self': 'See assets issued to me and confirm receipt',
  'assets.manage': 'Maintain the asset register; issue and receive assets',
  'cases.self': 'Raise a grievance or POSH complaint and follow my own cases',
  'grievance.manage': 'Handle employee grievances',
  'posh.admin': 'Maintain the Internal Committee membership (does not give access to complaints)',
  'payslips.self': 'View my payslips',
  'payroll.read': 'View payroll runs, salaries and registers',
  'payroll.manage': 'Set up components and salaries, prepare and compute payroll runs',
  'payroll.approve': 'Approve salary changes and payroll runs (not ones you prepared)',
  'payroll.statutory': 'Maintain and verify statutory rules (PF, ESI, PT, LWF, TDS)',
  'lifecycle.self': 'See my onboarding tasks and resign',
  'lifecycle.read': 'View onboarding, probation and separation records',
  'lifecycle.manage': 'Manage onboarding/exit checklists, probation decisions and separations',
  'recruitment.requisition': 'Request new positions (job requisitions)',
  'recruitment.read': 'View all requisitions, candidates and the hiring pipeline',
  'recruitment.manage': 'Manage candidates, applications, interviews and offers',
  'recruitment.approve': 'Approve requisitions and offers',
  'recruitment.compensation': 'See budgets, expected and offered CTC',
  'policies.self': 'Read and acknowledge policies that apply to me',
  'policies.read': 'View all policies, drafts and acknowledgement reports',
  'policies.manage': 'Create policies and draft new versions',
  'policies.publish': 'Publish or withdraw policy versions (not ones you drafted)',
  'competency.self': 'View own training records and technical authorizations',
  'training.manage': 'Manage training courses and record training',
  'competency.read': 'View all training, competency assessments, authorizations and the competence matrix',
  'competency.manage': 'Configure laboratory methods and their training requirements',
  'competency.assess': 'Record competency assessments and request technical authorizations',
  'competency.authorize': 'Grant, suspend and withdraw technical authorizations (quality)',
  // leave
  'overtime.self': 'Claim own overtime',
  'overtime.team.read': 'View overtime claims of reporting team',
  'overtime.read': 'View overtime claims of all employees',
  'overtime.approve': 'Approve overtime claims at HR level',
  'overtime.manage': 'Configure overtime pay and cancel approved claims',
  'field_duty.self': 'Request own field duty',
  'field_duty.team.read': 'View field duty of reporting team',
  'field_duty.read': 'View field duty of all employees',
  'field_duty.approve': 'Approve field duty at HR level, or when there is no manager',
  'field_duty.manage': 'Configure field duty, record it for an employee and cancel approved field duty',
  'travel.self': 'Request own travel and claim its expenses',
  'travel.team.read': 'View travel of reporting team',
  'travel.read': 'View travel of all employees',
  'travel.approve': 'Approve travel at finance level (advances, trips abroad, large estimates) and cancel approved trips',
  'travel.manage': 'Configure travel policy settings',
  'loans.self': 'Apply for own salary advance or loan',
  'loans.team.read': 'View advances and loans of reporting team',
  'loans.read': 'View advances and loans of all employees',
  'loans.approve': 'Approve salary advances and loans (finance)',
  'loans.manage': 'Disburse advances and loans, record repayments, defer instalments, configure the policy',
  'accounting.export': 'Export payroll and reimbursement journals for the accounts',
  'accounting.configure': 'Map payroll and expense heads to the organization\'s ledgers',
  'leave.self': 'Apply for leave and view own balances',
  'leave.team.read': 'View leave of reporting team',
  'leave.read': 'View leave of all employees',
  'leave.approve': 'Approve leave requests at HR level',
  'leave.manage': 'Configure leave types, run accruals and year-end, adjust balances, cancel any leave',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

const P = (...p: Permission[]) => p;
const SELF = P('attendance.self', 'employees.directory', 'leave.self', 'documents.self', 'expenses.self', 'competency.self', 'policies.self', 'lifecycle.self', 'payslips.self', 'cases.self', 'performance.self', 'assets.self', 'overtime.self', 'field_duty.self', 'travel.self', 'loans.self', 'profile.self');

export interface RoleDefinition { key: string; name: string; scope: 'tenant'; permissions: readonly Permission[] }

export const SYSTEM_ROLES: readonly RoleDefinition[] = [
  { key: 'tenant_admin', name: 'Administrator', scope: 'tenant', permissions: P(...SELF,
    'settings.read', 'settings.manage', 'security.manage',
    'users.manage', 'audit.read', 'org.read', 'org.manage', 'attendance.configure', 'policies.read', 'policies.publish', 'posh.admin',
    // Super-admin: salaries are visible only above their subject, so the top of the hierarchy must be able to read and approve them.
    'employees.read', 'employees.bank.read', 'payroll.read', 'payroll.approve', 'loans.read') },
  // Resolves to the Administrator's permissions in `multi`; see resolveRolePermissions for the other modes.
  { key: 'owner', name: 'Owner', scope: 'tenant', permissions: [] },
  { key: 'hr_admin', name: 'HR Administrator', scope: 'tenant', permissions: P(...SELF, 'settings.read', 'org.read', 'org.manage',
    'employees.read', 'employees.manage', 'employees.bank.read', 'employees.bank.manage', 'employees.bank.approve', 'attendance.read',
    'attendance.recalculate', 'attendance.approve', 'attendance.configure', 'audit.read', 'leave.read', 'leave.approve', 'leave.manage', 'documents.read', 'documents.restricted', 'documents.manage', 'training.manage', 'competency.read',
    'policies.read', 'policies.manage', 'policies.publish',
    'recruitment.requisition', 'recruitment.read', 'recruitment.manage', 'recruitment.approve', 'recruitment.compensation',
    'lifecycle.read', 'lifecycle.manage', 'payroll.read', 'grievance.manage', 'posh.admin', 'performance.manage', 'assets.manage',
    'overtime.read', 'overtime.approve', 'overtime.manage', 'field_duty.read', 'field_duty.approve', 'field_duty.manage', 'travel.read', 'loans.read', 'profile.approve', 'approvals.delegations', 'approvals.escalations', 'approvals.hr_step') },
  { key: 'hr_executive', name: 'HR Executive', scope: 'tenant', permissions: P(...SELF, 'org.read', 'employees.read', 'employees.manage',
    'attendance.read', 'attendance.recalculate', 'attendance.approve', 'leave.read', 'leave.approve', 'documents.read', 'documents.manage', 'training.manage', 'policies.read', 'policies.manage',
    'recruitment.requisition', 'recruitment.read', 'recruitment.manage', 'lifecycle.read', 'lifecycle.manage', 'overtime.read', 'field_duty.read', 'field_duty.approve', 'profile.approve', 'approvals.hr_step') },
  { key: 'payroll_manager', name: 'Payroll Manager', scope: 'tenant', permissions: P(...SELF, 'org.read', 'employees.read', 'employees.bank.read', 'payroll.read', 'payroll.manage', 'payroll.statutory',
    'attendance.read', 'attendance.lock', 'leave.read', 'documents.payroll', 'expenses.read', 'expenses.pay', 'overtime.read', 'field_duty.read', 'travel.read', 'loans.read', 'loans.manage', 'accounting.export') },
  { key: 'finance_manager', name: 'Finance Manager', scope: 'tenant', permissions: P(...SELF, 'org.read', 'employees.bank.approve', 'recruitment.compensation', 'payroll.read', 'payroll.approve', 'payroll.statutory', 'expenses.read', 'expenses.approve', 'expenses.pay', 'expenses.manage', 'travel.read', 'travel.approve', 'travel.manage', 'loans.read', 'loans.approve', 'accounting.export', 'accounting.configure') },
  { key: 'department_head', name: 'Department Head', scope: 'tenant', permissions: P(...SELF, 'org.read', 'attendance.team.read', 'leave.team.read', 'expenses.team.read', 'overtime.team.read', 'field_duty.team.read', 'travel.team.read', 'loans.team.read', 'recruitment.requisition') },
  { key: 'laboratory_manager', name: 'Laboratory Manager', scope: 'tenant', permissions: P(...SELF, 'org.read', 'attendance.team.read', 'leave.team.read', 'expenses.team.read', 'overtime.team.read', 'field_duty.team.read', 'travel.team.read', 'loans.team.read',
    'training.manage', 'competency.read', 'competency.assess', 'recruitment.requisition') },
  { key: 'quality_manager', name: 'Quality Manager', scope: 'tenant', permissions: P(...SELF, 'org.read', 'training.manage',
    'competency.read', 'competency.manage', 'competency.assess', 'competency.authorize', 'policies.read', 'policies.manage', 'policies.publish') },
  { key: 'reporting_manager', name: 'Reporting Manager', scope: 'tenant', permissions: P(...SELF, 'attendance.team.read', 'leave.team.read', 'expenses.team.read', 'overtime.team.read', 'field_duty.team.read', 'travel.team.read', 'loans.team.read', 'recruitment.requisition') },
  // Management sign-off on hiring (e.g. the laboratory director): approves requisitions and offers, sees compensation, cannot change the pipeline.
  // A second approver besides HR, so an offer drafted by the only HR administrator can still be approved (never by its requester).
  { key: 'hiring_approver', name: 'Hiring Approver', scope: 'tenant', permissions: P(...SELF, 'org.read', 'recruitment.read', 'recruitment.approve', 'recruitment.compensation') },
  { key: 'it_admin', name: 'IT Administrator', scope: 'tenant', permissions: P(...SELF, 'settings.read', 'users.manage', 'attendance.devices.manage', 'org.read', 'assets.manage') },
  { key: 'employee', name: 'Employee', scope: 'tenant', permissions: SELF },
  { key: 'auditor', name: 'Auditor / Read-only Reviewer', scope: 'tenant', permissions: P(...SELF, 'settings.read', 'audit.read', 'org.read',
    'employees.read', 'attendance.read', 'leave.read', 'documents.payroll', 'expenses.read', 'competency.read', 'policies.read', 'recruitment.read', 'lifecycle.read', 'payroll.read', 'overtime.read', 'field_duty.read', 'travel.read', 'loans.read') },
];

export const SYSTEM_ROLE_MAP: ReadonlyMap<string, RoleDefinition> = new Map(SYSTEM_ROLES.map((r) => [r.key, r]));

/** The six names of the contract. Each existing role keeps its key; this is the name it goes by. */
export type RoleGroup = 'Owner' | 'Super-admin' | 'Admin' | 'HR' | 'Payroll' | 'Manager' | 'Employee';
const ROLE_GROUPS: Readonly<Record<string, RoleGroup>> = {
  owner: 'Owner', tenant_admin: 'Super-admin', it_admin: 'Admin', auditor: 'Admin', hr_admin: 'HR', hr_executive: 'HR', payroll_manager: 'Payroll', finance_manager: 'Payroll',
  department_head: 'Manager', laboratory_manager: 'Manager', quality_manager: 'Manager', reporting_manager: 'Manager', hiring_approver: 'Manager', employee: 'Employee',
};
export const roleGroup = (key: string): RoleGroup | 'Custom' => ROLE_GROUPS[key] ?? 'Custom';

/** Top of the organization: in `multi` these are Super-admins; in the smaller modes both are the Owner. */
export const OWNER_ROLE_KEYS: readonly string[] = ['owner', 'tenant_admin'];
export const isOwnerRole = (key: string) => OWNER_ROLE_KEYS.includes(key);

// single_hr: "HR handles employees, attendance, leave, comp-off, documents"; the Owner keeps settings, payroll approval and salaries.
const SINGLE_HR_PERMISSIONS = P(...SELF, 'org.read', 'employees.read', 'employees.manage', 'attendance.read', 'attendance.recalculate', 'attendance.approve', 'attendance.lock',
  'leave.read', 'leave.approve', 'leave.manage', 'overtime.read', 'overtime.approve', 'field_duty.read', 'field_duty.approve', 'field_duty.manage', 'documents.read', 'documents.restricted', 'documents.manage',
  'profile.approve', 'lifecycle.read', 'lifecycle.manage', 'approvals.hr_step');

/** What a role means in this mode. Stored assignments never change with the mode, so moving up needs no data migration. */
export function resolveRolePermissions(key: string, mode: ManagementMode): readonly Permission[] {
  if (mode === 'multi') return SYSTEM_ROLE_MAP.get(key === 'owner' ? 'tenant_admin' : key)?.permissions ?? [];
  if (isOwnerRole(key)) return ALL_PERMISSIONS;
  if (mode === 'single_hr' && (key === 'hr_admin' || key === 'hr_executive')) return SINGLE_HR_PERMISSIONS;
  return SYSTEM_ROLE_MAP.has(key) ? SELF : [];
}

/** Roles that exist in this mode, for assignment. Custom roles and the rest stay stored, unused, until a larger mode. */
export function assignableRoles(mode: ManagementMode): readonly string[] {
  if (mode === 'single') return ['owner', 'tenant_admin', 'employee'];
  if (mode === 'single_hr') return ['owner', 'tenant_admin', 'hr_admin', 'hr_executive', 'employee'];
  return SYSTEM_ROLES.map((r) => r.key);
}

export interface UserView { key: 'employee' | 'manager' | 'hr' | 'payroll' | 'admin' | 'owner'; label: string }

/** The views this user can switch to: one person may hold several roles. Decided from what they can do, so custom roles count. */
export function viewsFor(roles: readonly string[], has: (p: string) => boolean, employeeId: string | null): UserView[] {
  const out: UserView[] = [];
  if (employeeId) out.push({ key: 'employee', label: 'Employee' });
  if (has('leave.team.read') || has('attendance.team.read')) out.push({ key: 'manager', label: 'Manager' });
  if (has('employees.manage')) out.push({ key: 'hr', label: 'HR' });
  if (has('payroll.manage') || has('payroll.read')) out.push({ key: 'payroll', label: 'Payroll' });
  if (has('users.manage') || has('settings.manage')) out.push({ key: 'admin', label: 'Admin' });
  if (roles.some(isOwnerRole)) out.push({ key: 'owner', label: roles.includes('owner') ? 'Owner' : 'Super-admin' });
  return out;
}

/** Which module a permission belongs to, by its name; longer prefixes win. Anything not listed belongs to an always-on part of the product. */
const PERMISSION_FEATURES: readonly (readonly [string, readonly string[]])[] = [
  ['attendance.devices.', ['attendance.biometric']], ['attendance.approve', ['attendance.regularization']], ['attendance.', ['attendance']], ['documents.', ['core.documents']],
  ['expenses.', ['expenses']], ['performance.', ['performance']], ['assets.', ['assets']], ['cases.', ['grievance', 'posh']], ['grievance.', ['grievance']], ['posh.', ['posh']],
  ['payslips.', ['payroll.payslips']], ['payroll.statutory', ['payroll.statutory']], ['payroll.', ['payroll']], ['lifecycle.', ['core.onboarding', 'core.offboarding']],
  ['recruitment.', ['recruitment']], ['policies.', ['core.policies']], ['training.', ['training']], ['competency.', ['lab.competency']], ['overtime.', ['overtime']],
  ['field_duty.', ['field_duty']], ['travel.', ['travel']], ['loans.', ['loans', 'salary_advance']], ['accounting.', ['accounting_exports']], ['leave.', ['leave']],
];
export const permissionFeature = (permission: string) => PERMISSION_FEATURES.find(([prefix]) => permission.startsWith(prefix))?.[1];
