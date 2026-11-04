-- 020: overtime claims from calculated attendance, paid through payroll or credited as compensatory off.

CREATE TABLE overtime_claims (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  employee_id       uuid NOT NULL,
  work_date         date NOT NULL,
  minutes           integer NOT NULL CHECK (minutes BETWEEN 1 AND 1440),
  recorded_minutes  integer NOT NULL CHECK (recorded_minutes >= 0),      -- attendance overtime when claimed
  payout            text NOT NULL CHECK (payout IN ('pay','comp_off')),
  reason            text NOT NULL CHECK (length(reason) BETWEEN 3 AND 1000),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','returned','cancelled')),
  comp_off_days     numeric(4,1),                                        -- comp_off: days credited on approval
  payroll_run_id    uuid,                                                -- pay: the run that included it (a cancelled run releases it)
  created_by        uuid NOT NULL REFERENCES users(id),
  decided_at        timestamptz,
  cancelled_by      uuid REFERENCES users(id),
  cancel_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, payroll_run_id) REFERENCES payroll_runs (tenant_id, id),
  CHECK (minutes <= recorded_minutes)
);
-- One live claim per person and day.
CREATE UNIQUE INDEX overtime_claims_live_uq ON overtime_claims (tenant_id, employee_id, work_date) WHERE status IN ('pending','approved');
CREATE INDEX overtime_claims_pay_idx ON overtime_claims (tenant_id, employee_id, status, payout, work_date);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['overtime_claims'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE DELETE ON overtime_claims FROM hrms_app;
  END IF;
END $$;
