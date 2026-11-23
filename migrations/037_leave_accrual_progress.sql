-- 037: which months of a leave year have been through monthly accrual, so a month that hit the cap stays skipped when room
-- appears later (the ledger cannot record a zero credit).
CREATE TABLE leave_accrual_progress (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  employee_id    uuid NOT NULL,
  leave_type_id  uuid NOT NULL,
  leave_year     integer NOT NULL,
  through_month  integer NOT NULL CHECK (through_month BETWEEN 1 AND 12),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, employee_id, leave_type_id, leave_year),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types (tenant_id, id)
);
ALTER TABLE leave_accrual_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON leave_accrual_progress
  USING (app_platform_bypass() OR tenant_id = app_current_tenant())
  WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant());

SELECT set_config('app.platform_bypass', 'on', true);
INSERT INTO leave_accrual_progress (tenant_id, employee_id, leave_type_id, leave_year, through_month)
SELECT tenant_id, employee_id, leave_type_id, leave_year, max(substring(reference from '-m([0-9]+)$')::int)
  FROM leave_ledger WHERE entry_type = 'accrual' AND reference ~ '-m[0-9]+$'
 GROUP BY tenant_id, employee_id, leave_type_id, leave_year;
