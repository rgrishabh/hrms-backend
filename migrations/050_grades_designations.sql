-- 050: masters for grades and designations. employees.designation and employees.grade stay free text (DECISIONS.md D54): the master says what may be chosen, once it has entries.

CREATE TABLE grades (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  code       text NOT NULL,
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX grades_name_uq ON grades (tenant_id, lower(name));

CREATE TABLE designations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  code       text NOT NULL,
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX designations_name_uq ON designations (tenant_id, lower(name));

-- Every value in use becomes an entry, so nobody's record stops being valid. One entry per spelling that differs only in case; a generated code the administrator can change.
SELECT set_config('app.platform_bypass', 'on', true);
INSERT INTO grades (tenant_id, code, name)
SELECT tenant_id, 'G' || lpad(row_number() OVER (PARTITION BY tenant_id ORDER BY name)::text, 4, '0'), name
  FROM (SELECT DISTINCT ON (tenant_id, lower(btrim(grade))) tenant_id, btrim(grade) AS name FROM employees
         WHERE btrim(coalesce(grade, '')) <> '' ORDER BY tenant_id, lower(btrim(grade)), btrim(grade)) g;
INSERT INTO designations (tenant_id, code, name)
SELECT tenant_id, 'D' || lpad(row_number() OVER (PARTITION BY tenant_id ORDER BY name)::text, 4, '0'), name
  FROM (SELECT DISTINCT ON (tenant_id, lower(btrim(designation))) tenant_id, btrim(designation) AS name FROM employees
         WHERE btrim(coalesce(designation, '')) <> '' ORDER BY tenant_id, lower(btrim(designation)), btrim(designation)) d;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['grades','designations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    GRANT SELECT, INSERT, UPDATE ON grades, designations TO hrms_app;
    REVOKE DELETE ON grades, designations FROM hrms_app;
  END IF;
END $$;
