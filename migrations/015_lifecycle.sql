-- 015: employee lifecycle — onboarding / exit-clearance checklists (shared engine),
-- probation reviews, separations (resignation, termination, …) with exit interview.

CREATE TABLE checklist_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  kind        text NOT NULL CHECK (kind IN ('onboarding','offboarding')),
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  is_default  boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX checklist_templates_default_uq ON checklist_templates (tenant_id, kind) WHERE is_default AND status = 'active';

CREATE TABLE checklist_template_tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  template_id  uuid NOT NULL,
  position     integer NOT NULL,
  title        text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  description  text,
  owner        text NOT NULL CHECK (owner IN ('hr','it','admin','finance','manager','employee')),
  offset_days  integer NOT NULL DEFAULT 0 CHECK (offset_days BETWEEN -90 AND 180),   -- relative to joining / last working day
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES checklist_templates (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE checklists (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  kind           text NOT NULL CHECK (kind IN ('onboarding','offboarding')),
  employee_id    uuid NOT NULL,
  template_id    uuid,
  separation_id  uuid,
  anchor_date    date NOT NULL,                  -- joining date / last working day
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled')),
  created_by     uuid REFERENCES users(id),      -- NULL = created automatically (hire)
  completed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES checklist_templates (tenant_id, id)
);
CREATE UNIQUE INDEX checklists_one_open_uq ON checklists (tenant_id, employee_id, kind) WHERE status = 'open';

CREATE TABLE checklist_tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  checklist_id  uuid NOT NULL,
  position      integer NOT NULL,
  title         text NOT NULL,
  description   text,
  owner         text NOT NULL CHECK (owner IN ('hr','it','admin','finance','manager','employee')),
  due_date      date NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped')),
  note          text,
  done_by       uuid REFERENCES users(id),
  done_at       timestamptz,
  UNIQUE (tenant_id, id),
  CHECK (status <> 'skipped' OR note IS NOT NULL),
  FOREIGN KEY (tenant_id, checklist_id) REFERENCES checklists (tenant_id, id)
);
CREATE INDEX checklist_tasks_due_idx ON checklist_tasks (tenant_id, status, due_date);

CREATE TABLE probation_reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  employee_id     uuid NOT NULL,
  probation_end   date NOT NULL,                  -- the end date under review
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','approved','rejected','cancelled')),
  recommendation  text CHECK (recommendation IS NULL OR recommendation IN ('confirm','extend','terminate')),
  extend_months   integer CHECK (extend_months IS NULL OR extend_months BETWEEN 1 AND 6),
  comments        text,
  submitted_by    uuid REFERENCES users(id),
  submitted_at    timestamptz,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id, probation_end),
  CHECK (recommendation <> 'extend' OR extend_months IS NOT NULL),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

CREATE TABLE separations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  employee_id          uuid NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('resignation','termination','retirement','contract_end','death','absconding','mutual')),
  reason               text NOT NULL CHECK (length(reason) BETWEEN 3 AND 2000),
  notice_date          date NOT NULL,
  requested_lwd        date NOT NULL,
  notice_days_required integer NOT NULL,
  approved_lwd         date,
  shortfall_days       integer NOT NULL DEFAULT 0,      -- notice not served (input to F&F; recovery/waiver decided by HR)
  waive_shortfall      boolean NOT NULL DEFAULT false,
  rehire_eligible      boolean,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn','completed','cancelled')),
  exit_interview       jsonb,                            -- answers; visible to HR only
  fnf_status           text NOT NULL DEFAULT 'not_started' CHECK (fnf_status IN ('not_started','in_progress','settled')),
  fnf_note             text,
  initiated_by         uuid NOT NULL REFERENCES users(id),
  completed_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (requested_lwd >= notice_date),
  CHECK (approved_lwd IS NULL OR approved_lwd >= notice_date),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE UNIQUE INDEX separations_live_uq ON separations (tenant_id, employee_id) WHERE status IN ('pending','approved');

ALTER TABLE checklists ADD FOREIGN KEY (tenant_id, separation_id) REFERENCES separations (tenant_id, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['checklist_templates','checklist_template_tasks','checklists','checklist_tasks','probation_reviews','separations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE DELETE ON checklists, checklist_tasks, probation_reviews, separations FROM hrms_app;
  END IF;
END $$;
