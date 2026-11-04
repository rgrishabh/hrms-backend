-- 042: expand step for the data policy. Adds what the code migration (043) writes into and what the application needs next.
-- Plaintext columns stay until 044, so this release can be rolled back up to that point.

ALTER TABLE users ADD COLUMN salary_access_level integer NOT NULL DEFAULT 0 CHECK (salary_access_level BETWEEN 0 AND 100);

-- Aadhaar: statutory, encrypted, shown as its last four digits only. Collection is off until an administrator turns it on.
ALTER TABLE employee_statutory ADD COLUMN aadhaar_enc text, ADD COLUMN aadhaar_last4 text CHECK (aadhaar_last4 IS NULL OR aadhaar_last4 ~ '^[0-9]{4}$');

ALTER TABLE employee_salaries ADD COLUMN amounts_enc text, ADD COLUMN annual_ctc_enc text;
ALTER TABLE payroll_items ADD COLUMN data_enc text;
ALTER TABLE payroll_runs ADD COLUMN totals_enc text;
ALTER TABLE payroll_adjustments ADD COLUMN data_enc text;
ALTER TABLE accounting_exports ADD COLUMN total_enc text;

-- A snapshot holds what one recipient could see when it was made, sealed.
ALTER TABLE report_snapshots ADD COLUMN data_enc text, ADD COLUMN viewer_level integer;

-- Single and single_hr: the one person who may decide their own request, always written to the audit log.
ALTER TABLE approval_requests ADD COLUMN self_approver_id uuid REFERENCES users(id);

-- Who read what, from which device; and the hash chain (044 fills it in and turns it on).
ALTER TABLE audit_logs ADD COLUMN user_agent text, ADD COLUMN chain_seq bigint, ADD COLUMN prev_hash text, ADD COLUMN row_hash text;
