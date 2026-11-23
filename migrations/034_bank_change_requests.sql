-- 034: a bank account change needs a second person (F-9). The requested details wait here, encrypted, until approved.
CREATE TABLE employee_bank_changes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  employee_id        uuid NOT NULL,
  account_holder     text NOT NULL,
  account_number_enc text NOT NULL,
  account_last4      text NOT NULL,
  ifsc               text NOT NULL,
  bank_name          text,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected','returned','cancelled')),
  requested_by       uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE UNIQUE INDEX employee_bank_changes_pending_uq ON employee_bank_changes (tenant_id, employee_id) WHERE status = 'pending';
ALTER TABLE employee_bank_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON employee_bank_changes
  USING (app_platform_bypass() OR tenant_id = app_current_tenant())
  WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN REVOKE DELETE ON employee_bank_changes FROM hrms_app; END IF;
END $$;
