-- 018: performance (cycles, goals, reviews) and assets (register, assignment, calibration).

CREATE TABLE review_cycles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  self_review   boolean NOT NULL DEFAULT true,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','closed')),
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (period_end > period_start)
);

CREATE TABLE goals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  cycle_id     uuid NOT NULL,
  employee_id  uuid NOT NULL,
  title        text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  description  text,
  measure      text,                                     -- how success is measured (e.g. TAT ≤ 3 days on 95% of samples)
  weight       integer NOT NULL CHECK (weight BETWEEN 1 AND 100),
  status       text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','agreed','dropped')),
  progress     integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES review_cycles (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE INDEX goals_idx ON goals (tenant_id, cycle_id, employee_id);

CREATE TABLE performance_reviews (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  cycle_id         uuid NOT NULL,
  employee_id      uuid NOT NULL,
  reviewer_id      uuid,                                -- manager (employee id) at activation
  status           text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','self_submitted','manager_submitted','finalized','acknowledged')),
  self_rating      integer CHECK (self_rating BETWEEN 1 AND 5),
  self_comments    text,
  manager_rating   integer CHECK (manager_rating BETWEEN 1 AND 5),
  manager_comments text,
  goal_ratings     jsonb NOT NULL DEFAULT '{}',         -- {goalId: 1..5} by the manager
  final_rating     integer CHECK (final_rating BETWEEN 1 AND 5),
  final_comments   text,
  finalized_by     uuid REFERENCES users(id),
  employee_ack_at  timestamptz,
  employee_ack_note text,
  version          integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, cycle_id, employee_id),
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES review_cycles (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewer_id) REFERENCES employees (tenant_id, id)
);

CREATE TABLE assets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  tag              text NOT NULL CHECK (tag ~ '^[A-Za-z0-9][A-Za-z0-9/_.-]{0,39}$'),
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 150),
  category         text NOT NULL CHECK (category IN ('lab_instrument','it','ppe','vehicle','furniture','tool','other')),
  serial_number    text,
  branch_id        uuid,
  status           text NOT NULL DEFAULT 'available' CHECK (status IN ('available','assigned','in_repair','retired','lost')),
  purchase_date    date,
  calibration_due  date,                                 -- lab instruments (ISO/IEC 17025 equipment records live in the LIMS)
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, tag),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);

CREATE TABLE asset_assignments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  asset_id           uuid NOT NULL,
  employee_id        uuid NOT NULL,
  issued_at          date NOT NULL,
  issued_by          uuid NOT NULL REFERENCES users(id),
  condition_out      text,
  due_back           date,
  returned_at        date,
  received_by        uuid REFERENCES users(id),
  condition_in       text,
  outcome            text CHECK (outcome IS NULL OR outcome IN ('returned','lost','damaged')),
  acknowledged_at    timestamptz,                         -- employee confirms receipt
  UNIQUE (tenant_id, id),
  CHECK ((returned_at IS NULL) = (outcome IS NULL)),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES assets (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE UNIQUE INDEX asset_assignments_open_uq ON asset_assignments (tenant_id, asset_id) WHERE returned_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['review_cycles','goals','performance_reviews','assets','asset_assignments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE DELETE ON review_cycles, performance_reviews, assets, asset_assignments FROM hrms_app;
  END IF;
END $$;
