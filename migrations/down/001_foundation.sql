-- Undoes 001. Everything in the installation is gone after this. pgcrypto is left alone if another role owns it: it was there before us.
DROP TABLE departments, branches, legal_entities, audit_logs, sessions, user_roles, tenant_roles, users, tenant_integrations,
  tenant_settings, platform_settings, tenant_modules, tenant_feature_entitlements, feature_definitions, tenant_branding, tenant_domains, tenants;
DROP FUNCTION app_platform_bypass();
DROP FUNCTION app_current_tenant();
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension e WHERE e.extname = 'pgcrypto' AND pg_has_role(current_user, e.extowner, 'MEMBER')) THEN
    DROP EXTENSION pgcrypto;
  END IF;
END $$;
