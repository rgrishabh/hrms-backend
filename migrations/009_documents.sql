-- 009: documents — categories configured by HR, document metadata (files live in the
-- installation's storage: local volume or S3), expiry tracking.

CREATE TABLE document_categories (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  code              text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{0,19}$'),
  name              text NOT NULL,
  scope             text NOT NULL DEFAULT 'employee' CHECK (scope IN ('employee','company')),
  employee_visible  boolean NOT NULL DEFAULT true,     -- employee can see their own documents of this category
  employee_upload   boolean NOT NULL DEFAULT false,    -- employee can upload to their own record
  restricted        boolean NOT NULL DEFAULT false,    -- e.g. medical / identity: needs documents.restricted
  requires_expiry   boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  category_id   uuid NOT NULL,
  employee_id   uuid,                                   -- NULL for company documents
  title         text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  file_name     text NOT NULL,                          -- sanitized original name (download name only)
  content_type  text NOT NULL,
  size_bytes    integer NOT NULL CHECK (size_bytes > 0),
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key   text NOT NULL UNIQUE,                   -- never derived from user input
  expires_on    date,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  uploaded_by   uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  archived_by   uuid REFERENCES users(id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES document_categories (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE INDEX documents_employee_idx ON documents (tenant_id, employee_id, status);
CREATE INDEX documents_expiry_idx ON documents (tenant_id, expires_on) WHERE status = 'active' AND expires_on IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_categories','documents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE DELETE ON documents, document_categories FROM hrms_app;   -- archive, never delete (retention policy decides)
  END IF;
END $$;
