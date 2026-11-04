/**
 * Permission catalogue and system roles. Server-side checks use these; the UI
 * only mirrors them for visibility. Segregation of duties is deliberate: the
 * Tenant Administrator configures the organization but cannot read bank details.
 * Branding, domains and modules are deployment-controlled, so no role can change them.
 */
export const PERMISSIONS = {
  // tenant administration
  'settings.read': 'View tenant settings',
  'settings.manage': 'Change general tenant settings',
  'security.manage': 'Change security settings',
  'users.manage': 'Manage user accounts and role assignments',
  'audit.read': 'View audit history',
  // organization & employees
  'org.read': 'View legal entities, branches and departments',
  'org.manage': 'Manage legal entities, branches and departments',
  'employees.directory': 'View employee directory (basic fields)',
  'employees.read': 'View full employee records',
  'employees.manage': 'Create and update employee records',
  'employees.bank.read': 'View masked bank details',
  'employees.bank.manage': 'Update bank details',
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
  'leave.self': 'Apply for leave and view own balances',
  'leave.team.read': 'View leave of reporting team',
  'leave.read': 'View leave of all employees',
  'leave.approve': 'Approve leave requests at HR level',
  'leave.manage': 'Configure leave types, run accruals and year-end, adjust balances, cancel any leave',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

const P = (...p: Permission[]) => p;
const SELF = P('attendance.self', 'employees.directory', 'leave.self', 'documents.self', 'expenses.self', 'competency.self', 'policies.self', 'lifecycle.self', 'payslips.self', 'cases.self', 'performance.self', 'assets.self', 'overtime.self', 'field_duty.self', 'travel.self');

export interface RoleDefinition { key: string; name: string; scope: 'tenant'; permissions: readonly Permission[] }

export const SYSTEM_ROLES: readonly RoleDefinition[] = [
  { key: 'tenant_admin', name: 'Administrator', scope: 'tenant', permissions: P(...SELF,
    'settings.read', 'settings.manage', 'security.manage',
    'users.manage', 'audit.read', 'org.read', 'org.manage', 'attendance.configure', 'policies.read', 'policies.publish', 'posh.admin') },
  { key: 'hr_admin', name: 'HR Administrator', scope: 'tenant', permissions: P(...SELF, 'settings.read', 'org.read', 'org.manage',
    'employees.read', 'employees.manage', 'employees.bank.read', 'employees.bank.manage', 'attendance.read',
    'attendance.recalculate', 'attendance.approve', 'attendance.configure', 'audit.read', 'leave.read', 'leave.approve', 'leave.manage', 'documents.read', 'documents.restricted', 'documents.manage', 'training.manage', 'competency.read',
    'policies.read', 'policies.manage', 'policies.publish',
    'recruitment.requisition', 'recruitment.read', 'recruitment.manage', 'recruitment.approve', 'recruitment.compensation',
    'lifecycle.read', 'lifecycle.manage', 'payroll.read', 'grievance.manage', 'posh.admin', 'performance.manage', 'assets.manage',
    'overtime.read', 'overtime.approve', 'overtime.manage', 'field_duty.read', 'field_duty.approve', 'field_duty.manage', 'travel.read') },
  { key: 'hr_executive', name: 'HR Executive', scope: 'tenant', permissions: P(...SELF, 'org.read', 'employees.read', 'employees.manage',
    'attendance.read', 'attendance.recalculate', 'attendance.approve', 'leave.read', 'leave.approve', 'documents.read', 'documents.manage', 'training.manage', 'policies.read', 'policies.manage',
    'recruitment.requisition', 'recruitment.read', 'recruitment.manage', 'lifecycle.read', 'lifecycle.manage', 'overtime.read', 'field_duty.read', 'field_duty.approve') },
  { key: 'payroll_manager', name: 'Payroll Manager', scope: 'tenant', permissions: P(...SELF, 'org.read', 'employees.read', 'employees.bank.read', 'payroll.read', 'payroll.manage', 'payroll.statutory',
    'attendance.read', 'attendance.lock', 'leave.read', 'documents.read', 'expenses.read', 'expenses.pay', 'overtime.read', 'field_duty.read', 'travel.read') },
  { key: 'finance_manager', name: 'Finance Manager', scope: 'tenant', permissions: P(...SELF, 'org.read', 'recruitment.compensation', 'payroll.read', 'payroll.approve', 'payroll.statutory', 'expenses.read', 'expenses.approve', 'expenses.pay', 'expenses.manage', 'travel.read', 'travel.approve', 'travel.manage') },
  { key: 'department_head', name: 'Department Head', scope: 'tenant', permissions: P(...SELF, 'org.read', 'attendance.team.read', 'leave.team.read', 'expenses.team.read', 'overtime.team.read', 'field_duty.team.read', 'travel.team.read', 'recruitment.requisition') },
  { key: 'laboratory_manager', name: 'Laboratory Manager', scope: 'tenant', permissions: P(...SELF, 'org.read', 'attendance.team.read', 'leave.team.read', 'expenses.team.read', 'overtime.team.read', 'field_duty.team.read', 'travel.team.read',
    'training.manage', 'competency.read', 'competency.assess', 'recruitment.requisition') },
  { key: 'quality_manager', name: 'Quality Manager', scope: 'tenant', permissions: P(...SELF, 'org.read', 'training.manage',
    'competency.read', 'competency.manage', 'competency.assess', 'competency.authorize', 'policies.read', 'policies.manage', 'policies.publish') },
  { key: 'reporting_manager', name: 'Reporting Manager', scope: 'tenant', permissions: P(...SELF, 'attendance.team.read', 'leave.team.read', 'expenses.team.read', 'overtime.team.read', 'field_duty.team.read', 'travel.team.read', 'recruitment.requisition') },
  // Management sign-off on hiring (e.g. the laboratory director): approves requisitions and offers, sees compensation, cannot change the pipeline.
  // A second approver besides HR, so an offer drafted by the only HR administrator can still be approved (never by its requester).
  { key: 'hiring_approver', name: 'Hiring Approver', scope: 'tenant', permissions: P(...SELF, 'org.read', 'recruitment.read', 'recruitment.approve', 'recruitment.compensation') },
  { key: 'it_admin', name: 'IT Administrator', scope: 'tenant', permissions: P(...SELF, 'settings.read', 'users.manage', 'attendance.devices.manage', 'org.read', 'assets.manage') },
  { key: 'employee', name: 'Employee', scope: 'tenant', permissions: SELF },
  { key: 'auditor', name: 'Auditor / Read-only Reviewer', scope: 'tenant', permissions: P(...SELF, 'settings.read', 'audit.read', 'org.read',
    'employees.read', 'attendance.read', 'leave.read', 'documents.read', 'expenses.read', 'competency.read', 'policies.read', 'recruitment.read', 'lifecycle.read', 'payroll.read', 'overtime.read', 'field_duty.read', 'travel.read') },
];

export const SYSTEM_ROLE_MAP: ReadonlyMap<string, RoleDefinition> = new Map(SYSTEM_ROLES.map((r) => [r.key, r]));
