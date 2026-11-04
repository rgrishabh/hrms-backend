-- 024: accounting exports — the organization's ledger names for each payroll and expense head, and a log of
-- journals exported (payroll runs, reimbursement batches) as CSV or Tally XML.

CREATE TABLE accounting_ledger_map (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  map_key      text NOT NULL CHECK (map_key ~ '^(earning|deduction|employer_expense|employer_payable|expense):([A-Z0-9_]{1,30}|\*)$' OR map_key IN ('net_pay','reimbursement_payable')),
  ledger_name  text NOT NULL CHECK (length(ledger_name) BETWEEN 1 AND 200),
  updated_by   uuid REFERENCES users(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, map_key)
);

CREATE TABLE accounting_exports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  source_type   text NOT NULL CHECK (source_type IN ('payroll_run','reimbursement_batch')),
  source_id     uuid NOT NULL,
  format        text NOT NULL CHECK (format IN ('csv','tally_xml')),
  voucher_date  date NOT NULL,
  total         numeric(14,2) NOT NULL,
  exported_by   uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounting_exports_source_idx ON accounting_exports (tenant_id, source_type, source_id, created_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounting_ledger_map','accounting_exports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE DELETE, UPDATE ON accounting_exports FROM hrms_app;   -- the log is append-only
  END IF;
END $$;
