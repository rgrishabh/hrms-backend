-- 012: training records, laboratory methods, competency assessments and technical authorizations
-- (personnel competence records in the style of ISO/IEC 17025 clause 6.2; the organization's quality
-- system decides the actual requirements — nothing here is a certification).

CREATE TABLE training_courses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  code            text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_-]{0,29}$'),
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 150),
  kind            text NOT NULL CHECK (kind IN ('induction','safety','method','instrument','quality','external','other')),
  description     text,
  validity_months integer CHECK (validity_months IS NULL OR validity_months BETWEEN 1 AND 120),  -- NULL = does not expire
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code), UNIQUE (tenant_id, id)
);

CREATE TABLE training_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  employee_id   uuid NOT NULL,
  course_id     uuid NOT NULL,
  completed_on  date NOT NULL,
  expires_on    date,                                  -- from the course validity at the time of recording
  result        text NOT NULL CHECK (result IN ('completed','passed','failed')),
  trainer       text,
  provider      text,
  hours         numeric(5,1) CHECK (hours IS NULL OR hours > 0),
  notes         text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  revoked_reason text,
  recorded_by   uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (expires_on IS NULL OR expires_on >= completed_on),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, course_id) REFERENCES training_courses (tenant_id, id)
);
CREATE INDEX training_records_emp_idx ON training_records (tenant_id, employee_id, course_id);
CREATE INDEX training_records_exp_idx ON training_records (tenant_id, expires_on) WHERE status='active';

CREATE TABLE lab_methods (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  code          text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_./-]{0,39}$'),
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),   -- e.g. "pH by electrometric method"
  standard_ref  text,                                                   -- e.g. "IS 3025 (Part 11)" — as the lab cites it
  discipline    text,                                                   -- e.g. Chemical, Biological
  matrix        text,                                                   -- e.g. Water, Ambient air, Soil
  branch_id     uuid,
  review_months integer NOT NULL DEFAULT 12 CHECK (review_months BETWEEN 1 AND 60),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code), UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);

CREATE TABLE lab_method_requirements (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  method_id  uuid NOT NULL,
  course_id  uuid NOT NULL,
  PRIMARY KEY (tenant_id, method_id, course_id),
  FOREIGN KEY (tenant_id, method_id) REFERENCES lab_methods (tenant_id, id),
  FOREIGN KEY (tenant_id, course_id) REFERENCES training_courses (tenant_id, id)
);

CREATE TABLE competency_assessments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  employee_id   uuid NOT NULL,
  method_id     uuid NOT NULL,
  activity      text NOT NULL CHECK (activity IN ('sampling','perform','review','authorize_report')),
  approach      text NOT NULL CHECK (approach IN ('witnessed','replicate','retained_sample','proficiency_test','interlab_comparison','written','other')),
  assessed_on   date NOT NULL,
  result        text NOT NULL CHECK (result IN ('competent','not_yet_competent')),
  evidence      text NOT NULL CHECK (length(evidence) BETWEEN 3 AND 2000),  -- e.g. PT round and z-score, replicate RSD
  assessor_id   uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, method_id) REFERENCES lab_methods (tenant_id, id)
);
CREATE INDEX competency_assessments_idx ON competency_assessments (tenant_id, employee_id, method_id, activity, assessed_on DESC);

CREATE TABLE lab_authorizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  employee_id   uuid NOT NULL,
  method_id     uuid NOT NULL,
  activity      text NOT NULL CHECK (activity IN ('sampling','perform','review','authorize_report')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','authorized','rejected','suspended','withdrawn','expired','superseded','cancelled')),
  assessment_id uuid NOT NULL,
  requested_by  uuid NOT NULL REFERENCES users(id),
  authorized_by uuid REFERENCES users(id),
  authorized_at timestamptz,
  valid_from    date,
  review_due    date,
  ended_at      timestamptz,
  end_reason    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (authorized_by IS NULL OR authorized_by <> requested_by),          -- maker-checker
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, method_id) REFERENCES lab_methods (tenant_id, id),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES competency_assessments (tenant_id, id)
);
-- Per person, method and activity: at most one in force (authorized / suspended) and one pending
-- (a renewal can be pending while the current authorization stays in force; approval supersedes it).
CREATE UNIQUE INDEX lab_authorizations_inforce_uq ON lab_authorizations (tenant_id, employee_id, method_id, activity)
  WHERE status IN ('authorized','suspended');
CREATE UNIQUE INDEX lab_authorizations_pending_uq ON lab_authorizations (tenant_id, employee_id, method_id, activity)
  WHERE status = 'pending';
CREATE INDEX lab_authorizations_review_idx ON lab_authorizations (tenant_id, review_due) WHERE status='authorized';

CREATE TABLE lab_authorization_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  authorization_id uuid NOT NULL,
  action           text NOT NULL,   -- requested, authorized, rejected, returned, cancelled, suspended, reinstated, withdrawn, expired, superseded
  actor_id         uuid REFERENCES users(id),   -- NULL = scheduled job
  reason           text,
  at               timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, authorization_id) REFERENCES lab_authorizations (tenant_id, id)
);
CREATE INDEX lab_authorization_events_idx ON lab_authorization_events (tenant_id, authorization_id, at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['training_courses','training_records','lab_methods','lab_method_requirements','competency_assessments','lab_authorizations','lab_authorization_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    -- Competence records are evidence: never deleted by the application. Requirements may be unlinked.
    REVOKE DELETE ON training_courses, training_records, lab_methods, competency_assessments, lab_authorizations, lab_authorization_events FROM hrms_app;
    REVOKE UPDATE ON competency_assessments, lab_authorization_events FROM hrms_app;
  END IF;
END $$;
