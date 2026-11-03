-- 014: recruitment — requisitions (approved headcount), candidates (consent + retention),
-- applications with stage history, interviews with panel feedback, offers with approval, hire.

CREATE TABLE job_requisitions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  number           integer NOT NULL,                       -- REQ-<number>, per organization
  title            text NOT NULL CHECK (length(title) BETWEEN 3 AND 150),
  legal_entity_id  uuid NOT NULL,
  branch_id        uuid NOT NULL,
  department_id    uuid,
  designation      text,
  employment_type  text NOT NULL CHECK (employment_type IN ('permanent','probation','contract','trainee','intern','consultant')),
  positions        integer NOT NULL DEFAULT 1 CHECK (positions BETWEEN 1 AND 100),
  filled           integer NOT NULL DEFAULT 0 CHECK (filled >= 0),
  justification    text NOT NULL CHECK (length(justification) BETWEEN 3 AND 2000),
  budget_ctc_max   numeric(12,2) CHECK (budget_ctc_max IS NULL OR budget_ctc_max > 0),   -- annual, per position (restricted)
  hiring_manager_id uuid,                                  -- employee
  target_date      date,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','approved','rejected','on_hold','closed','cancelled')),
  created_by       uuid NOT NULL REFERENCES users(id),
  approved_at      timestamptz,
  closed_at        timestamptz,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, number),
  CHECK (filled <= positions),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entities (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id),
  FOREIGN KEY (tenant_id, hiring_manager_id) REFERENCES employees (tenant_id, id)
);

CREATE TABLE candidates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  first_name         text NOT NULL,
  last_name          text,
  email              text,
  phone              text,
  source             text NOT NULL CHECK (source IN ('referral','job_portal','website','agency','campus','walk_in','other')),
  referred_by        uuid,                                 -- employee
  current_company    text,
  current_designation text,
  experience_months  integer CHECK (experience_months IS NULL OR experience_months BETWEEN 0 AND 720),
  notice_days        integer CHECK (notice_days IS NULL OR notice_days BETWEEN 0 AND 365),
  expected_ctc       numeric(12,2) CHECK (expected_ctc IS NULL OR expected_ctc > 0),   -- restricted
  location           text,
  qualification      text,                                 -- e.g. M.Sc. Chemistry
  resume_key         text UNIQUE,
  resume_name        text,
  resume_type        text,
  resume_sha256      text,
  consent_at         timestamptz NOT NULL,                 -- candidate agreed to processing for recruitment
  consent_note       text NOT NULL,                        -- how consent was obtained
  retain_until       date NOT NULL,                        -- then anonymized unless hired / in process
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','anonymized')),
  employee_id        uuid,                                 -- set on hire
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, referred_by) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE UNIQUE INDEX candidates_email_uq ON candidates (tenant_id, lower(email)) WHERE email IS NOT NULL AND status = 'active';
CREATE INDEX candidates_phone_idx ON candidates (tenant_id, phone) WHERE phone IS NOT NULL;

CREATE TABLE job_applications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  requisition_id   uuid NOT NULL,
  candidate_id     uuid NOT NULL,
  stage            text NOT NULL DEFAULT 'applied' CHECK (stage IN ('applied','screening','interview','offer','hired','rejected','withdrawn')),
  rejection_reason text,
  version          integer NOT NULL DEFAULT 1,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, requisition_id, candidate_id),
  CHECK (stage <> 'rejected' OR rejection_reason IS NOT NULL),
  FOREIGN KEY (tenant_id, requisition_id) REFERENCES job_requisitions (tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates (tenant_id, id)
);
CREATE INDEX job_applications_req_idx ON job_applications (tenant_id, requisition_id, stage);

CREATE TABLE job_application_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  application_id uuid NOT NULL,
  from_stage     text,
  to_stage       text NOT NULL,
  note           text,
  actor_id       uuid REFERENCES users(id),
  at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, application_id) REFERENCES job_applications (tenant_id, id)
);
CREATE INDEX job_application_events_idx ON job_application_events (tenant_id, application_id, at);

CREATE TABLE interviews (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  application_id uuid NOT NULL,
  round          integer NOT NULL CHECK (round BETWEEN 1 AND 20),
  kind           text NOT NULL CHECK (kind IN ('phone','technical','practical_lab','hr','panel','other')),
  scheduled_at   timestamptz NOT NULL,
  duration_min   integer NOT NULL DEFAULT 45 CHECK (duration_min BETWEEN 10 AND 480),
  location       text,                                     -- room or meeting link
  status         text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, application_id) REFERENCES job_applications (tenant_id, id)
);

CREATE TABLE interview_panel (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  interview_id   uuid NOT NULL,
  user_id        uuid NOT NULL REFERENCES users(id),
  rating         integer CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  recommendation text CHECK (recommendation IS NULL OR recommendation IN ('strong_yes','yes','no','strong_no')),
  notes          text,
  submitted_at   timestamptz,
  PRIMARY KEY (tenant_id, interview_id, user_id),
  CHECK ((submitted_at IS NULL) = (rating IS NULL AND recommendation IS NULL)),
  FOREIGN KEY (tenant_id, interview_id) REFERENCES interviews (tenant_id, id)
);

CREATE TABLE job_offers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  application_id   uuid NOT NULL,
  designation      text NOT NULL,
  legal_entity_id  uuid NOT NULL,
  branch_id        uuid NOT NULL,
  department_id    uuid,
  employment_type  text NOT NULL CHECK (employment_type IN ('permanent','probation','contract','trainee','intern','consultant')),
  annual_ctc       numeric(12,2) NOT NULL CHECK (annual_ctc > 0),      -- restricted
  joining_date     date NOT NULL,
  probation_months integer CHECK (probation_months IS NULL OR probation_months BETWEEN 0 AND 24),
  contract_end_date date,
  above_budget     boolean NOT NULL DEFAULT false,
  notes            text,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','approved','rejected','sent','accepted','declined','withdrawn')),
  created_by       uuid NOT NULL REFERENCES users(id),
  approved_at      timestamptz,
  sent_at          timestamptz,
  responded_at     timestamptz,
  employee_id      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, application_id) REFERENCES job_applications (tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entities (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
-- One live offer per application.
CREATE UNIQUE INDEX job_offers_live_uq ON job_offers (tenant_id, application_id) WHERE status IN ('draft','pending','approved','sent','accepted');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['job_requisitions','candidates','job_applications','job_application_events','interviews','interview_panel','job_offers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    -- Candidates are anonymized, never deleted (references stay intact); history is append-only.
    REVOKE DELETE ON job_requisitions, candidates, job_applications, job_application_events, interviews, job_offers FROM hrms_app;
    REVOKE UPDATE ON job_application_events FROM hrms_app;
  END IF;
END $$;
