-- 032: closing a leave year moves the carried days out of it (F-2), and closed years are recorded.
ALTER TABLE leave_ledger DROP CONSTRAINT leave_ledger_entry_type_check;
ALTER TABLE leave_ledger ADD CONSTRAINT leave_ledger_entry_type_check
  CHECK (entry_type IN ('opening','accrual','consumption','reversal','adjustment','carry_forward','carry_out','lapse'));

CREATE TABLE leave_year_closures (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  leave_year  integer NOT NULL,
  closed_at   timestamptz NOT NULL DEFAULT now(),
  closed_by   uuid REFERENCES users(id),
  backfilled  boolean NOT NULL DEFAULT false,   -- closed by a release that did not write carry_out entries
  PRIMARY KEY (tenant_id, leave_year)
);
ALTER TABLE leave_year_closures ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON leave_year_closures
  USING (app_platform_bypass() OR tenant_id = app_current_tenant())
  WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN REVOKE UPDATE, DELETE ON leave_year_closures FROM hrms_app; END IF;
END $$;

-- Years already closed can be recognised from their year-end ledger entries. Their balances are not touched here:
-- POST /leave/year-end on such a year writes the missing carry_out entries, see QA_REPORT.md.
SELECT set_config('app.platform_bypass', 'on', true);
INSERT INTO leave_year_closures (tenant_id, leave_year, closed_at, backfilled)
SELECT tenant_id, y, min(created_at), true FROM (
  SELECT tenant_id, leave_year AS y, created_at FROM leave_ledger WHERE entry_type = 'lapse' AND reference LIKE 'yearend:%'
  UNION ALL
  SELECT tenant_id, leave_year - 1 AS y, created_at FROM leave_ledger WHERE entry_type = 'carry_forward' AND reference LIKE 'yearend:%'
) x GROUP BY tenant_id, y;
