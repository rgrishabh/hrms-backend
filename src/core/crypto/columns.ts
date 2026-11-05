/**
 * Every column holding ciphertext: what `rotate-keys` rewrites, and what a test checks against the schema, so a new
 * encrypted column cannot be forgotten at the next rotation. `key` is the columns that identify a row.
 */
export interface EncryptedColumn { table: string; column: string; key: readonly string[]; guardTrigger?: string }

export const ENCRYPTED_COLUMNS: readonly EncryptedColumn[] = [
  { table: 'case_events', column: 'text_enc', key: ['id'] },
  { table: 'cases', column: 'description_enc', key: ['id'] },
  { table: 'cases', column: 'late_reason_enc', key: ['id'] },
  { table: 'cases', column: 'outcome_enc', key: ['id'] },
  { table: 'cases', column: 'respondent_text_enc', key: ['id'] },
  { table: 'employee_bank_accounts', column: 'account_number_enc', key: ['employee_id'] },
  { table: 'employee_bank_changes', column: 'account_number_enc', key: ['id'] },
  { table: 'employee_statutory', column: 'pan_enc', key: ['tenant_id', 'employee_id'] },
  { table: 'employee_statutory', column: 'aadhaar_enc', key: ['tenant_id', 'employee_id'] },
  { table: 'users', column: 'mfa_pending_secret_enc', key: ['id'] },
  { table: 'users', column: 'mfa_secret_enc', key: ['id'] },
  { table: 'employee_salaries', column: 'amounts_enc', key: ['id'] },
  { table: 'employee_salaries', column: 'annual_ctc_enc', key: ['id'] },
  { table: 'payroll_items', column: 'data_enc', key: ['id'], guardTrigger: 'payroll_items_guard' },
  { table: 'payroll_runs', column: 'totals_enc', key: ['id'] },
  { table: 'payroll_adjustments', column: 'data_enc', key: ['id'], guardTrigger: 'payroll_adjustments_guard' },
  { table: 'accounting_exports', column: 'total_enc', key: ['id'] },
  { table: 'report_snapshots', column: 'data_enc', key: ['id'] },
  { table: 'email_outbox', column: 'secret_enc', key: ['id'] },
];
