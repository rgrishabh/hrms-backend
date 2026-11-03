-- 017: confidential cases — POSH complaints (Internal Committee) and employee grievances.
-- Narrative text is encrypted with the field cipher; access is by case role, not by admin rights.

CREATE TABLE posh_committee_members (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  role        text NOT NULL CHECK (role IN ('presiding_officer','member')),
  added_by    uuid NOT NULL REFERENCES users(id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE posh_external_members (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  name         text NOT NULL,
  organization text NOT NULL,              -- NGO / association, as the Act requires an external member
  since        date NOT NULL,
  until        date,
  UNIQUE (tenant_id, id)
);

CREATE TABLE cases (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  kind               text NOT NULL CHECK (kind IN ('posh','grievance')),
  number             integer NOT NULL,
  category           text NOT NULL,
  complainant_id     uuid,                  -- employee; NULL only for anonymous grievances
  complainant_user   uuid REFERENCES users(id),   -- who filed (kept even when anonymous, never shown)
  anonymous          boolean NOT NULL DEFAULT false,
  respondent_id      uuid,                  -- employee, when known
  respondent_text_enc text,                 -- third party / description (encrypted)
  incident_date      date,
  description_enc    text NOT NULL,         -- encrypted
  late_reason_enc    text,                  -- POSH: filed after the 3-month window
  status             text NOT NULL,
  assignee_user      uuid REFERENCES users(id),     -- grievance handler
  received_at        timestamptz NOT NULL DEFAULT now(),
  inquiry_due        date,                  -- POSH: received + 90 days
  report_due         date,                  -- POSH: inquiry completed + 10 days
  sla_due            date,                  -- grievance
  outcome_enc        text,
  closed_at          timestamptz,
  version            integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, kind, number),
  CHECK (kind = 'grievance' OR NOT anonymous),
  CHECK (anonymous OR complainant_id IS NOT NULL),
  CHECK ((kind = 'posh' AND status IN ('received','conciliation','inquiry','report_submitted','closed','withdrawn'))
      OR (kind = 'grievance' AND status IN ('open','in_progress','resolved','closed','reopened','withdrawn'))),
  FOREIGN KEY (tenant_id, complainant_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, respondent_id) REFERENCES employees (tenant_id, id)
);
CREATE INDEX cases_status_idx ON cases (tenant_id, kind, status);

CREATE TABLE case_events (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  case_id                uuid NOT NULL,
  type                   text NOT NULL CHECK (type IN ('note','update','status','comment','assignment')),
  text_enc               text,
  from_status            text,
  to_status              text,
  visible_to_complainant boolean NOT NULL DEFAULT false,
  actor_user             uuid REFERENCES users(id),
  at                     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases (tenant_id, id)
);
CREATE INDEX case_events_idx ON case_events (tenant_id, case_id, at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['posh_committee_members','posh_external_members','cases','case_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE DELETE ON cases, case_events FROM hrms_app;
    REVOKE UPDATE ON case_events FROM hrms_app;
  END IF;
END $$;
