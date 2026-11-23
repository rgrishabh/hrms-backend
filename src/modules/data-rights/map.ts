/**
 * Where a person's data is, table by table, and what erasing it means there. Export and erasure both read this. A test fails when a table with a person's id in it is neither here nor
 * on the exempt list below, so a new module cannot be forgotten.
 *
 *   erase 'delete'  the rows go
 *   erase 'scrub'   the row stays; `scrub` columns are emptied now
 *   erase 'keep'    the row stays as it is, without the person's name on it
 * `carveOut` says which legal period a row that stays is kept for. It is only ever about rows; nothing in a carve-out stays linked to a name, except through the sealed identity.
 */
export type CarveOut = 'payroll' | 'attendance' | 'claims';
export type Subject = 'employee' | 'user' | 'none';

export interface PersonalTable {
  section: string;
  table: string;
  /** Which of the person's ids finds their rows. */
  by: Subject;
  /** The column holding it; or `where` when the row is one join away. */
  column?: string;
  where?: string;
  erase: 'delete' | 'scrub' | 'keep' | 'custom';
  scrub?: readonly string[];
  carveOut?: CarveOut;
  /** Stable order for paging. Default `id`. */
  order?: string;
  /** Not in an export: nothing about the person, or someone else's. */
  noExport?: boolean;
  /** Only the person themselves receives this section; for anyone else it is withheld, with no count. */
  selfOnly?: boolean;
  /** Sealed columns to open for an allowed viewer. Every other `_enc` column stays closed. */
  open?: readonly string[];
  /** Columns left out of an export whatever the viewer: not data about the person. */
  omit?: readonly string[];
}

const FILE_COLS = ['storage_key', 'sha256', 'receipt_key', 'receipt_sha256', 'resume_key', 'resume_sha256'];

export const PERSONAL_TABLES: readonly PersonalTable[] = [
  { section: 'profile', table: 'employees', by: 'employee', column: 'id', erase: 'custom' },
  { section: 'account', table: 'users', by: 'user', column: 'id', erase: 'custom', omit: ['failed_logins', 'locked_until', 'mfa_failures', 'mfa_locked_until', 'mfa_last_step'] },
  { section: 'addresses', table: 'employee_addresses', by: 'employee', erase: 'delete', order: 'kind' },
  { section: 'emergency_contacts', table: 'employee_emergency_contacts', by: 'employee', erase: 'delete' },
  { section: 'education', table: 'employee_education', by: 'employee', erase: 'delete' },
  { section: 'experience', table: 'employee_experience', by: 'employee', erase: 'delete' },
  { section: 'nominees', table: 'employee_nominees', by: 'employee', erase: 'delete' },
  { section: 'profile_changes', table: 'employee_profile_changes', by: 'employee', erase: 'scrub', scrub: ['items', 'note'] },
  { section: 'device_mappings', table: 'device_user_mappings', by: 'employee', erase: 'delete', order: 'device_user_id' },

  { section: 'attendance_days', table: 'attendance_daily', by: 'employee', erase: 'keep', carveOut: 'attendance', order: 'work_date', omit: ['policy_snapshot', 'calc_version'] },
  { section: 'attendance_punches', table: 'attendance_events', by: 'employee', erase: 'scrub', scrub: ['latitude', 'longitude'], carveOut: 'attendance', order: 'event_time, id' },
  { section: 'attendance_corrections', table: 'attendance_regularizations', by: 'employee', erase: 'scrub', scrub: ['reason'], carveOut: 'attendance' },
  { section: 'selfies', table: 'attendance_selfies', by: 'employee', erase: 'custom', omit: FILE_COLS },
  { section: 'shift_assignments', table: 'shift_assignments', by: 'employee', erase: 'keep', carveOut: 'attendance' },
  { section: 'roster_assignments', table: 'roster_assignments', by: 'employee', erase: 'keep', carveOut: 'attendance' },
  { section: 'roster_overrides', table: 'roster_overrides', by: 'employee', erase: 'scrub', scrub: ['reason'], carveOut: 'attendance', order: 'work_date' },
  { section: 'leave_requests', table: 'leave_requests', by: 'employee', erase: 'scrub', scrub: ['reason'], carveOut: 'attendance' },
  { section: 'leave_ledger', table: 'leave_ledger', by: 'employee', erase: 'keep', carveOut: 'attendance' },
  { section: 'leave_accruals', table: 'leave_accrual_progress', by: 'employee', erase: 'keep', carveOut: 'attendance', order: 'leave_year, leave_type_id' },
  { section: 'overtime', table: 'overtime_claims', by: 'employee', erase: 'scrub', scrub: ['reason', 'cancel_reason'], carveOut: 'payroll' },
  { section: 'field_duty', table: 'field_duty_requests', by: 'employee', erase: 'scrub', scrub: ['reason', 'outcome_note', 'cancel_reason'], carveOut: 'attendance' },

  { section: 'salaries', table: 'employee_salaries', by: 'employee', erase: 'keep', carveOut: 'payroll', open: ['amounts_enc', 'annual_ctc_enc'], order: 'effective_from, id' },
  { section: 'payslips', table: 'payroll_items', by: 'employee', erase: 'keep', carveOut: 'payroll', open: ['data_enc'] },
  { section: 'payroll_adjustments', table: 'payroll_adjustments', by: 'employee', erase: 'keep', carveOut: 'payroll', open: ['data_enc'] },
  { section: 'final_settlements', table: 'payroll_runs', by: 'employee', erase: 'keep', carveOut: 'payroll', omit: ['warnings', 'warnings_acknowledged'] },
  { section: 'statutory', table: 'employee_statutory', by: 'employee', erase: 'scrub', scrub: ['aadhaar_enc', 'aadhaar_last4'], carveOut: 'payroll', order: 'employee_id' },
  { section: 'bank_account', table: 'employee_bank_accounts', by: 'employee', erase: 'keep', carveOut: 'payroll', order: 'employee_id' },
  { section: 'bank_changes', table: 'employee_bank_changes', by: 'employee', erase: 'keep', carveOut: 'payroll' },
  { section: 'loans', table: 'employee_loans', by: 'employee', erase: 'scrub', scrub: ['purpose', 'cancel_reason'], carveOut: 'payroll' },
  {
    section: 'loan_recoveries',
    table: 'loan_recoveries',
    by: 'employee',
    where: 'loan_id IN (SELECT id FROM employee_loans WHERE tenant_id=$1 AND employee_id=$2)',
    erase: 'keep',
    carveOut: 'payroll',
  },
  { section: 'expense_claims', table: 'expense_claims', by: 'employee', erase: 'keep', carveOut: 'payroll' },
  {
    section: 'expense_items',
    table: 'expense_items',
    by: 'employee',
    where: 'claim_id IN (SELECT id FROM expense_claims WHERE tenant_id=$1 AND employee_id=$2)',
    erase: 'keep',
    carveOut: 'payroll',
    omit: FILE_COLS,
  },
  { section: 'travel', table: 'travel_requests', by: 'employee', erase: 'keep', carveOut: 'payroll' },

  { section: 'documents', table: 'documents', by: 'employee', erase: 'custom', omit: FILE_COLS },
  {
    section: 'reviews',
    table: 'performance_reviews',
    by: 'employee',
    erase: 'scrub',
    scrub: ['self_comments', 'manager_comments', 'final_comments', 'employee_ack_note', 'goal_ratings'],
  },
  { section: 'goals', table: 'goals', by: 'employee', erase: 'scrub', scrub: ['title', 'description', 'measure'] },
  { section: 'probation', table: 'probation_reviews', by: 'employee', erase: 'scrub', scrub: ['comments'] },
  { section: 'separation', table: 'separations', by: 'employee', erase: 'scrub', scrub: ['reason', 'exit_interview', 'fnf_note'], carveOut: 'claims' },
  { section: 'checklists', table: 'checklists', by: 'employee', erase: 'keep', carveOut: 'claims' },
  { section: 'training', table: 'training_records', by: 'employee', erase: 'scrub', scrub: ['notes'], carveOut: 'claims' },
  { section: 'competency', table: 'competency_assessments', by: 'employee', erase: 'keep', carveOut: 'claims' },
  { section: 'authorizations', table: 'lab_authorizations', by: 'employee', erase: 'keep', carveOut: 'claims' },
  { section: 'assets', table: 'asset_assignments', by: 'employee', erase: 'keep', carveOut: 'claims' },
  { section: 'policy_acknowledgements', table: 'policy_acknowledgements', by: 'employee', erase: 'keep', carveOut: 'claims' },
  // POSH and grievance: what someone raised goes to them alone. A case naming them as respondent is not theirs to read (POSH Act s.16, confidentiality).
  {
    section: 'cases_raised',
    table: 'cases',
    by: 'employee',
    column: 'complainant_id',
    erase: 'keep',
    carveOut: 'claims',
    selfOnly: true,
    open: ['description_enc', 'late_reason_enc', 'outcome_enc', 'respondent_text_enc'],
    omit: ['assignee_user', 'respondent_id', 'complainant_user'],
  },
  { section: 'job_offers', table: 'job_offers', by: 'employee', erase: 'scrub', scrub: ['annual_ctc', 'notes'] },

  { section: 'notifications', table: 'notifications', by: 'user', erase: 'delete' },
  {
    section: 'email',
    table: 'email_outbox',
    by: 'user',
    column: 'to_user_id',
    erase: 'delete',
    omit: ['secret_enc', 'html_body', 'text_body', 'dedupe_key', 'last_error', 'attempts', 'next_attempt_at'],
  },
  { section: 'push', table: 'push_outbox', by: 'user', column: 'to_user_id', erase: 'delete', noExport: true },
  { section: 'push_subscriptions', table: 'push_subscriptions', by: 'user', erase: 'delete', noExport: true },
  { section: 'sessions', table: 'sessions', by: 'user', erase: 'delete', omit: ['mfa_failures', 'idle_timeout_minutes', 'mfa_verified_at'] },
  { section: 'devices', table: 'user_devices', by: 'user', erase: 'delete', order: 'first_seen_at', omit: ['device_hash'] },
  { section: 'email_codes', table: 'email_otps', by: 'user', erase: 'delete', noExport: true },
  { section: 'saved_reports', table: 'saved_reports', by: 'user', column: 'owner_id', erase: 'delete' },
  { section: 'report_copies', table: 'report_snapshots', by: 'user', column: 'owner_id', erase: 'delete', noExport: true },
  { section: 'roles', table: 'user_roles', by: 'user', erase: 'delete' },
  { section: 'committee', table: 'posh_committee_members', by: 'user', erase: 'delete', order: 'added_at' },
  {
    section: 'approvals_requested',
    table: 'approval_requests',
    by: 'user',
    column: 'requester_id',
    erase: 'scrub',
    scrub: ['summary'],
    omit: ['excluded_user_ids', 'self_approver_id'],
  },
];

/** Columns naming a person that are not about that person: who decided, who recorded. They point at an account that is itself anonymized. */
export const PERSON_COLUMNS = ['employee_id', 'user_id', 'to_user_id', 'owner_id', 'requester_id', 'complainant_id'] as const;

/** Tables with such a column that this file leaves alone, and why. */
export const EXEMPT_TABLES: Readonly<Record<string, string>> = {
  admin_setup_tokens: 'Handled with the account: outstanding links are ended, and the hash reveals nothing',
  candidates: "A hired candidate: anonymized with recruitment's own function, which also removes the resume",
  interview_panel: 'The user is the interviewer; notes about a candidate go with the candidate',
};

export const CARVE_OUT_BASIS: Readonly<Record<CarveOut, { setting: string; label: string; basis: string }>> = {
  payroll: {
    setting: 'retention.payroll_years',
    label: 'Payroll and statutory records',
    basis:
      'Books of account and vouchers: Companies Act 2013 s.128 (8 financial years). Income-tax and TDS records, PF, ESI and wage registers have shorter periods that this one covers.',
  },
  attendance: {
    setting: 'retention.attendance_years',
    label: 'Attendance and leave registers',
    basis: 'Labour registers: five years is the period commonly applied. It varies by state and establishment.',
  },
  claims: {
    setting: 'retention.claims_years',
    label: 'Records needed for disputes',
    basis: 'Separation, grievance, POSH and competence records: the three-year period of the Limitation Act 1963 for most claims.',
  },
};
export const NOT_LEGAL_ADVICE = 'These periods are the defaults as best known, and can be changed in Settings. They are a technical control and not legal advice.';
export const AUDIT_LOG_NOTE =
  'The audit log is append-only and hash-chained, and is never rewritten. It holds no L3 or L4 values: changes to those record field names. It does hold what happened to L1 and L2 fields, old and new, such as a name or work email changed before the erasure, plus account ids, addresses and devices of requests.';
