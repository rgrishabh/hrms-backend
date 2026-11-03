-- 005: deployment-level installations (one customer per installation).
--  * users.must_change_password — forced password change on first login (bootstrap admin, admin resets)
--  * admin_setup_tokens        — one-time setup links for the first administrator (stored hashed)
-- Branding, enabled modules and domains now come from deployment configuration. The tables
-- tenant_branding, tenant_modules and tenant_feature_entitlements are no longer read by the
-- application; they are kept (not dropped) so existing data is preserved.

ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

CREATE TABLE admin_setup_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_setup_tokens_user_idx ON admin_setup_tokens (user_id) WHERE used_at IS NULL;

ALTER TABLE admin_setup_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON admin_setup_tokens
  USING (app_platform_bypass() OR tenant_id = app_current_tenant())
  WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant());

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    GRANT SELECT, UPDATE ON admin_setup_tokens TO hrms_app;
    REVOKE INSERT, DELETE ON admin_setup_tokens FROM hrms_app;  -- only the bootstrap (owner) issues tokens
  END IF;
END $$;
