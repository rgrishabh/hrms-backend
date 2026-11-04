-- 021: field duty (on-duty away from the workplace: field sampling, client sites, audits, training).
-- Approved field duty makes the day `on_duty` in calculated attendance: paid, without needing office punches.

CREATE TABLE field_duty_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  employee_id     uuid NOT NULL,
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  day_part        text NOT NULL DEFAULT 'full' CHECK (day_part IN ('full','first_half','second_half')),  -- halves only for a single day
  purpose         text NOT NULL CHECK (purpose IN ('field_sampling','client_visit','site_audit','training','official_work','other')),
  place           text NOT NULL CHECK (length(place) BETWEEN 2 AND 200),       -- site, client or town
  client_name     text CHECK (client_name IS NULL OR length(client_name) <= 200),
  reference       text CHECK (reference IS NULL OR length(reference) <= 100),  -- job / work order number
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 1000),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','returned','cancelled')),
  outcome         text CHECK (outcome IS NULL OR outcome IN ('completed','partly_completed','not_done')),
  outcome_note    text CHECK (outcome_note IS NULL OR length(outcome_note) <= 2000),
  reported_at     timestamptz,
  created_by      uuid NOT NULL REFERENCES users(id),
  decided_at      timestamptz,
  cancelled_by    uuid REFERENCES users(id),
  cancel_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  CHECK (end_date >= start_date),
  CHECK (day_part = 'full' OR start_date = end_date)
);
CREATE INDEX field_duty_employee_idx ON field_duty_requests (tenant_id, employee_id, start_date, end_date) WHERE status IN ('pending','approved');
CREATE INDEX field_duty_dates_idx ON field_duty_requests (tenant_id, status, start_date);

-- Attendance: on-duty days.
ALTER TABLE attendance_daily DROP CONSTRAINT attendance_daily_status_check;
ALTER TABLE attendance_daily ADD CONSTRAINT attendance_daily_status_check
  CHECK (status IN ('present','half_day','absent','missing_punch','weekly_off','holiday','not_joined','on_leave','on_duty'));
ALTER TABLE attendance_daily ADD COLUMN duty_fraction numeric(3,2) NOT NULL DEFAULT 0 CHECK (duty_fraction IN (0, 0.5, 1));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['field_duty_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE DELETE ON field_duty_requests FROM hrms_app;
  END IF;
END $$;
