-- 051: DPDP data rights: erasure requests, and what retention needs the runtime role to be able to do. See docs/DATA_RIGHTS.md.

CREATE TABLE erasure_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  subject_type          text NOT NULL CHECK (subject_type IN ('employee','candidate')),
  subject_id            uuid NOT NULL,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rejected','retained','completed')),
  reason                text,
  requested_by          uuid NOT NULL REFERENCES users(id),
  decided_by            uuid REFERENCES users(id),
  decided_at            timestamptz,
  decision_note         text,
  completed_at          timestamptz,
  retained_until        date,
  -- Name and date of birth while statutory records must still say whose they are: sealed, cleared when the carve-out ends.
  retained_identity_enc text,
  -- Files to remove once the erasure has committed. Cleared as they go; the follow-up job finishes what a crash or a missing store left.
  files_pending         text[] NOT NULL DEFAULT '{}',
  -- Counts, tables and dates only: never a value.
  report                jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);
-- One open or carried-out request per person: asking twice answers with the same one. A refused request can be followed by another.
CREATE UNIQUE INDEX erasure_requests_subject_uq ON erasure_requests (tenant_id, subject_type, subject_id) WHERE status <> 'rejected';
CREATE INDEX erasure_requests_followup_idx ON erasure_requests (tenant_id, status, retained_until);

ALTER TABLE employees ADD COLUMN erased_at timestamptz;

ALTER TABLE erasure_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON erasure_requests
  USING (app_platform_bypass() OR tenant_id = app_current_tenant())
  WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant());

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    GRANT SELECT, INSERT, UPDATE ON erasure_requests TO hrms_app;
    REVOKE DELETE ON erasure_requests FROM hrms_app;
    -- Retention now decides what 008, 007, 009 and 034 kept: these rows have an end. audit_logs is not among them: it is append-only and stays.
    GRANT DELETE ON notifications, email_outbox, job_runs, documents, employee_bank_changes TO hrms_app;
    -- Punches stay evidence and cannot be edited. Where someone stood at a punch is erased, and a closed case is cleared at the end of its period.
    GRANT UPDATE (latitude, longitude) ON attendance_events TO hrms_app;
    GRANT UPDATE (text_enc) ON case_events TO hrms_app;
  END IF;
END $$;
