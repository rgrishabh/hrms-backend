-- 022: travel management — trip requests with a cost estimate and an optional advance, approved by the
-- manager (and finance for advances, trips abroad and large estimates), paid by finance, settled against
-- the trip's expense claim. Approved trips can count as field duty in attendance.

CREATE TABLE travel_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  employee_id        uuid NOT NULL,
  purpose            text NOT NULL CHECK (length(purpose) BETWEEN 3 AND 1000),
  trip_type          text NOT NULL CHECK (trip_type IN ('domestic','international')),
  origin             text NOT NULL CHECK (length(origin) BETWEEN 2 AND 120),
  destination        text NOT NULL CHECK (length(destination) BETWEEN 2 AND 200),
  start_date         date NOT NULL,
  end_date           date NOT NULL,
  travel_mode        text NOT NULL CHECK (travel_mode IN ('air','rail','bus','road','own_vehicle','other')),
  accommodation      boolean NOT NULL DEFAULT false,
  project            text CHECK (project IS NULL OR length(project) <= 100),       -- client / work order / cost centre
  estimate_travel    numeric(12,2) NOT NULL DEFAULT 0 CHECK (estimate_travel >= 0),
  estimate_stay      numeric(12,2) NOT NULL DEFAULT 0 CHECK (estimate_stay >= 0),
  estimate_local     numeric(12,2) NOT NULL DEFAULT 0 CHECK (estimate_local >= 0),
  estimate_meals     numeric(12,2) NOT NULL DEFAULT 0 CHECK (estimate_meals >= 0),
  estimate_other     numeric(12,2) NOT NULL DEFAULT 0 CHECK (estimate_other >= 0),
  estimate_total     numeric(12,2) GENERATED ALWAYS AS (estimate_travel + estimate_stay + estimate_local + estimate_meals + estimate_other) STORED,
  advance_requested  numeric(12,2) NOT NULL DEFAULT 0 CHECK (advance_requested >= 0),
  mark_on_duty       boolean NOT NULL DEFAULT true,     -- approved trip days count as field duty (when that module is on)
  on_duty_note       text,                              -- why the trip was not recorded as field duty
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','returned','cancelled','completed','closed')),
  advance_paid_amount numeric(12,2) CHECK (advance_paid_amount IS NULL OR advance_paid_amount > 0),
  advance_paid_at    timestamptz,
  advance_paid_by    uuid REFERENCES users(id),
  advance_reference  text,
  recovered_amount   numeric(12,2) NOT NULL DEFAULT 0 CHECK (recovered_amount >= 0),
  recovered_note     text,
  created_by         uuid NOT NULL REFERENCES users(id),
  decided_at         timestamptz,
  completed_at       timestamptz,
  closed_at          timestamptz,
  closed_by          uuid REFERENCES users(id),
  cancelled_by       uuid REFERENCES users(id),
  cancel_reason      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  CHECK (end_date >= start_date),
  CHECK (advance_requested <= estimate_travel + estimate_stay + estimate_local + estimate_meals + estimate_other),
  CHECK (recovered_amount <= coalesce(advance_paid_amount, 0))
);
CREATE INDEX travel_requests_emp_idx ON travel_requests (tenant_id, employee_id, start_date);
CREATE INDEX travel_requests_status_idx ON travel_requests (tenant_id, status, start_date);

-- The trip's expense claim, and how much of it was set off against the advance (the rest is reimbursed).
ALTER TABLE expense_claims ADD COLUMN travel_request_id uuid;
ALTER TABLE expense_claims ADD CONSTRAINT expense_claims_travel_fk FOREIGN KEY (tenant_id, travel_request_id) REFERENCES travel_requests (tenant_id, id);
ALTER TABLE expense_claims ADD COLUMN advance_adjusted numeric(12,2) NOT NULL DEFAULT 0 CHECK (advance_adjusted >= 0);
ALTER TABLE expense_claims ADD CONSTRAINT expense_claims_adjusted_le_total CHECK (advance_adjusted <= total);
CREATE INDEX expense_claims_travel_idx ON expense_claims (tenant_id, travel_request_id) WHERE travel_request_id IS NOT NULL;

-- Field duty recorded for an approved trip.
ALTER TABLE field_duty_requests ADD COLUMN travel_request_id uuid;
ALTER TABLE field_duty_requests ADD CONSTRAINT field_duty_travel_fk FOREIGN KEY (tenant_id, travel_request_id) REFERENCES travel_requests (tenant_id, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['travel_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE DELETE ON travel_requests FROM hrms_app;
  END IF;
END $$;
