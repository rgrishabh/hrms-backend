-- 013: policy management — versioned policies, publication with maker-checker, audience,
-- employee acknowledgements bound to the exact content shown (append-only evidence).

CREATE TABLE policies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  code        text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_-]{0,29}$'),
  title       text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  category    text NOT NULL CHECK (category IN ('hr','code_of_conduct','posh','safety','quality','it_security','data_protection','other')),
  owner       text,                                  -- owning function, e.g. "HR", "Quality"
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code), UNIQUE (tenant_id, id)
);

CREATE TABLE policy_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  policy_id        uuid NOT NULL,
  version_no       integer NOT NULL CHECK (version_no > 0),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','superseded','withdrawn')),
  change_summary   text NOT NULL CHECK (length(change_summary) BETWEEN 3 AND 1000),
  body             text CHECK (body IS NULL OR length(body) <= 100000),
  file_key         text UNIQUE,
  file_name        text,
  file_sha256      text,
  file_size        integer,
  content_sha256   text NOT NULL,                     -- sha256 over body + file hash: what an acknowledgement refers to
  effective_from   date NOT NULL,
  requires_ack     boolean NOT NULL DEFAULT true,
  ack_due_days     integer NOT NULL DEFAULT 14 CHECK (ack_due_days BETWEEN 1 AND 180),
  audience_branch_ids     uuid[] NOT NULL DEFAULT '{}',   -- empty = all branches
  audience_department_ids uuid[] NOT NULL DEFAULT '{}',   -- empty = all departments
  created_by       uuid NOT NULL REFERENCES users(id),
  published_by     uuid REFERENCES users(id),
  published_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, policy_id, version_no),
  CHECK (body IS NOT NULL OR file_key IS NOT NULL),
  CHECK (published_by IS NULL OR published_by <> created_by),            -- maker-checker
  FOREIGN KEY (tenant_id, policy_id) REFERENCES policies (tenant_id, id)
);
CREATE UNIQUE INDEX policy_versions_one_published ON policy_versions (tenant_id, policy_id) WHERE status='published';

CREATE TABLE policy_acknowledgements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  version_id      uuid NOT NULL,
  employee_id     uuid NOT NULL,
  user_id         uuid NOT NULL REFERENCES users(id),
  content_sha256  text NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  ip              text,
  user_agent      text,
  UNIQUE (tenant_id, version_id, employee_id),
  FOREIGN KEY (tenant_id, version_id) REFERENCES policy_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['policies','policy_versions','policy_acknowledgements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE DELETE ON policies, policy_versions, policy_acknowledgements FROM hrms_app;
    REVOKE UPDATE ON policy_acknowledgements FROM hrms_app;   -- acknowledgements are evidence
  END IF;
END $$;
