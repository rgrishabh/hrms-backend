-- 027: the rest of the employee record — emergency contacts, addresses, nominees, education, previous employment —
-- and employee-initiated change requests for the sections HR verifies (nominees, education, employment history).
-- Each section is replaced as a whole; history is in the audit log (section and counts, never the contents).

CREATE TABLE employee_emergency_contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  employee_id   uuid NOT NULL,
  position      smallint NOT NULL CHECK (position BETWEEN 1 AND 5),          -- 1 = call first
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  relationship  text NOT NULL CHECK (length(relationship) BETWEEN 2 AND 40),
  phone         text NOT NULL CHECK (phone ~ '^\+?[0-9 -]{10,15}$'),
  alt_phone     text CHECK (alt_phone IS NULL OR alt_phone ~ '^\+?[0-9 -]{10,15}$'),
  UNIQUE (tenant_id, employee_id, position),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

CREATE TABLE employee_addresses (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  employee_id   uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('current','permanent')),
  line1         text NOT NULL CHECK (length(line1) BETWEEN 3 AND 200),
  line2         text CHECK (line2 IS NULL OR length(line2) <= 200),
  city          text NOT NULL CHECK (length(city) BETWEEN 2 AND 80),
  state         text NOT NULL CHECK (length(state) BETWEEN 2 AND 80),
  postal_code   text NOT NULL CHECK (length(postal_code) BETWEEN 3 AND 12),
  country       text NOT NULL DEFAULT 'India' CHECK (length(country) BETWEEN 2 AND 60),
  PRIMARY KEY (tenant_id, employee_id, kind),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

-- Nominations per purpose (PF, gratuity, insurance, other); the shares of a purpose add up to 100.
CREATE TABLE employee_nominees (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  employee_id    uuid NOT NULL,
  purpose        text NOT NULL CHECK (purpose IN ('pf','gratuity','insurance','other')),
  name           text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  relationship   text NOT NULL CHECK (length(relationship) BETWEEN 2 AND 40),
  date_of_birth  date,
  share_percent  numeric(5,2) NOT NULL CHECK (share_percent > 0 AND share_percent <= 100),
  guardian_name  text CHECK (guardian_name IS NULL OR length(guardian_name) BETWEEN 2 AND 120),  -- for a minor nominee
  address        text CHECK (address IS NULL OR length(address) <= 300),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE INDEX employee_nominees_idx ON employee_nominees (tenant_id, employee_id, purpose);

CREATE TABLE employee_education (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  employee_id      uuid NOT NULL,
  level            text NOT NULL CHECK (level IN ('secondary','higher_secondary','diploma','graduate','postgraduate','doctorate','certification','other')),
  qualification    text NOT NULL CHECK (length(qualification) BETWEEN 2 AND 120),   -- e.g. M.Sc. Chemistry
  institution      text NOT NULL CHECK (length(institution) BETWEEN 2 AND 200),
  university       text CHECK (university IS NULL OR length(university) <= 200),  -- board / university
  year_of_passing  smallint CHECK (year_of_passing IS NULL OR year_of_passing BETWEEN 1950 AND 2100),
  score            text CHECK (score IS NULL OR length(score) <= 20),              -- percentage, CGPA or class
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE INDEX employee_education_idx ON employee_education (tenant_id, employee_id);

CREATE TABLE employee_experience (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  employee_id        uuid NOT NULL,
  employer           text NOT NULL CHECK (length(employer) BETWEEN 2 AND 200),
  designation        text NOT NULL CHECK (length(designation) BETWEEN 2 AND 120),
  from_date          date NOT NULL,
  to_date            date NOT NULL,
  reason_for_leaving text CHECK (reason_for_leaving IS NULL OR length(reason_for_leaving) <= 300),
  CHECK (to_date >= from_date),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE INDEX employee_experience_idx ON employee_experience (tenant_id, employee_id);

-- An employee's proposed replacement of a section HR verifies; applied when approved. One pending change per section.
CREATE TABLE employee_profile_changes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  employee_id   uuid NOT NULL,
  section       text NOT NULL CHECK (section IN ('nominees','education','experience')),
  items         jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  note          text CHECK (note IS NULL OR length(note) <= 500),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','returned','cancelled')),
  requested_by  uuid NOT NULL REFERENCES users(id),
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE UNIQUE INDEX employee_profile_changes_pending_uq ON employee_profile_changes (tenant_id, employee_id, section) WHERE status = 'pending';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee_emergency_contacts','employee_addresses','employee_nominees','employee_education','employee_experience','employee_profile_changes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE DELETE ON employee_profile_changes FROM hrms_app;
  END IF;
END $$;
