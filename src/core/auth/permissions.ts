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
  'leave.self': 'Apply for leave and view own balances',
  'leave.team.read': 'View leave of reporting team',
  'leave.read': 'View leave of all employees',
  'leave.approve': 'Approve leave requests at HR level',
  'leave.manage': 'Configure leave types, run accruals and year-end, adjust balances, cancel any leave',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

const P = (...p: Permission[]) => p;
const SELF = P('attendance.self', 'employees.directory', 'leave.self', 'documents.self', 'expenses.self', 'competency.self', 'policies.self');

export interface RoleDefinition { key: string; name: string; scope: 'tenant'; permissions: readonly Permission[] }

export const SYSTEM_ROLES: readonly RoleDefinition[] = [
  { key: 'tenant_admin', name: 'Administrator', scope: 'tenant', permissions: P(...SELF,
    'settings.read', 'settings.manage', 'security.manage',
    'users.manage', 'audit.read', 'org.read', 'org.manage', 'attendance.configure', 'policies.read', 'policies.publish') },
  { key: 'hr_admin', name: 'HR Administrator', scope: 'tenant', permissions: P(...SELF, 'settings.read', 'org.read', 'org.manage',
    'employees.read', 'employees.manage', 'employees.bank.read', 'employees.bank.manage', 'attendance.read',
    'attendance.recalculate', 'attendance.approve', 'attendance.configure', 'audit.read', 'leave.read', 'leave.approve', 'leave.manage', 'documents.read', 'documents.restricted', 'documents.manage', 'training.manage', 'competency.read',
    'policies.read', 'policies.manage', 'policies.publish') },
  { key: 'hr_executive', name: 'HR Executive', scope: 'tenant', permissions: P(...SELF, 'org.read', 'employees.read', 'employees.manage',
    'attendance.read', 'attendance.recalculate', 'attendance.approve', 'leave.read', 'leave.approve', 'documents.read', 'documents.manage', 'training.manage', 'policies.read', 'policies.manage') },
  { key: 'payroll_manager', name: 'Payroll Manager', scope: 'tenant', permissions: P(...SELF, 'org.read', 'employees.read', 'employees.bank.read',
    'attendance.read', 'attendance.lock', 'leave.read', 'documents.read', 'expenses.read', 'expenses.pay') },
  { key: 'finance_manager', name: 'Finance Manager', scope: 'tenant', permissions: P(...SELF, 'org.read', 'expenses.read', 'expenses.approve', 'expenses.pay', 'expenses.manage') },
  { key: 'department_head', name: 'Department Head', scope: 'tenant', permissions: P(...SELF, 'org.read', 'attendance.team.read', 'leave.team.read', 'expenses.team.read') },
  { key: 'laboratory_manager', name: 'Laboratory Manager', scope: 'tenant', permissions: P(...SELF, 'org.read', 'attendance.team.read', 'leave.team.read', 'expenses.team.read',
    'training.manage', 'competency.read', 'competency.assess') },
  { key: 'quality_manager', name: 'Quality Manager', scope: 'tenant', permissions: P(...SELF, 'org.read', 'training.manage',
    'competency.read', 'competency.manage', 'competency.assess', 'competency.authorize', 'policies.read', 'policies.manage', 'policies.publish') },
  { key: 'reporting_manager', name: 'Reporting Manager', scope: 'tenant', permissions: P(...SELF, 'attendance.team.read', 'leave.team.read', 'expenses.team.read') },
  { key: 'it_admin', name: 'IT Administrator', scope: 'tenant', permissions: P(...SELF, 'settings.read', 'users.manage', 'attendance.devices.manage', 'org.read') },
  { key: 'employee', name: 'Employee', scope: 'tenant', permissions: SELF },
  { key: 'auditor', name: 'Auditor / Read-only Reviewer', scope: 'tenant', permissions: P(...SELF, 'settings.read', 'audit.read', 'org.read',
    'employees.read', 'attendance.read', 'leave.read', 'documents.read', 'expenses.read', 'competency.read', 'policies.read') },
];

export const SYSTEM_ROLE_MAP: ReadonlyMap<string, RoleDefinition> = new Map(SYSTEM_ROLES.map((r) => [r.key, r]));
