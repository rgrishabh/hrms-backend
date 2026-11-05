-- Undoes 042. Runs after 043's down has moved the sealed values back. Data: Aadhaar numbers, salary levels, who self-approved, and the user agent on audit rows are gone and cannot return.
ALTER TABLE audit_logs DROP COLUMN user_agent, DROP COLUMN chain_seq, DROP COLUMN prev_hash, DROP COLUMN row_hash;
ALTER TABLE approval_requests DROP COLUMN self_approver_id;
ALTER TABLE report_snapshots DROP COLUMN data_enc, DROP COLUMN viewer_level;
ALTER TABLE accounting_exports DROP COLUMN total_enc;
ALTER TABLE payroll_adjustments DROP COLUMN data_enc;
ALTER TABLE payroll_runs DROP COLUMN totals_enc;
ALTER TABLE payroll_items DROP COLUMN data_enc;
ALTER TABLE employee_salaries DROP COLUMN amounts_enc, DROP COLUMN annual_ctc_enc;
ALTER TABLE employee_statutory DROP COLUMN aadhaar_enc, DROP COLUMN aadhaar_last4;
ALTER TABLE users DROP COLUMN salary_access_level;
