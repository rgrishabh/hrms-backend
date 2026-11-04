-- 030: rotating shift rosters. A pattern is a cycle of days, each a shift or a day off (e.g. M M E E N N off off).
-- Employees follow a pattern from a date, starting at a chosen day of the cycle so crews can be staggered.
-- A one-day override (a swap, cover, an extra day off) beats the pattern; the pattern beats the fixed shift assignment.
-- On rostered dates, days off come from the pattern instead of the weekly-off setting; holidays still apply.

CREATE TABLE roster_patterns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
  days        uuid[] NOT NULL CHECK (cardinality(days) BETWEEN 1 AND 56),   -- shift id per day of the cycle; NULL = day off
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE roster_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  employee_id    uuid NOT NULL,
  pattern_id     uuid NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  start_day      smallint NOT NULL DEFAULT 0 CHECK (start_day >= 0),   -- the cycle day that falls on effective_from (0-based)
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, pattern_id) REFERENCES roster_patterns (tenant_id, id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX roster_assignments_emp_idx ON roster_assignments (tenant_id, employee_id, effective_from DESC);

CREATE TABLE roster_overrides (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  employee_id uuid NOT NULL,
  work_date   date NOT NULL,
  shift_id    uuid,                     -- NULL = day off
  reason      text NOT NULL CHECK (length(reason) BETWEEN 3 AND 200),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, employee_id, work_date),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES shifts (tenant_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['roster_patterns','roster_assignments','roster_overrides'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE DELETE ON roster_patterns FROM hrms_app;   -- deactivated, never deleted (an assignment not yet started may be withdrawn)
  END IF;
END $$;
