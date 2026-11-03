-- 003: row-level security (defence in depth) and least-privilege grants for hrms_app.
-- The application ALSO filters by tenant in every query; RLS is the second line.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_domains','tenant_branding','tenant_feature_entitlements','tenant_modules',
    'tenant_settings','tenant_integrations','tenant_roles','legal_entities','branches',
    'departments','employees','employee_bank_accounts','approval_requests','approval_steps',
    'shifts','shift_assignments','holidays','attendance_devices','device_user_mappings',
    'attendance_events','attendance_daily','attendance_regularizations','attendance_period_locks',
    -- nullable tenant_id tables: platform rows (NULL) visible only under explicit bypass
    'users','user_roles','sessions','audit_logs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- grants
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    GRANT USAGE ON SCHEMA public TO hrms_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hrms_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hrms_app;
    -- Tables from later migrations; each migration must still revoke what it should not allow.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hrms_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO hrms_app;

    -- Append-only / immutable history
    REVOKE UPDATE, DELETE ON audit_logs FROM hrms_app;
    REVOKE UPDATE, DELETE ON attendance_events FROM hrms_app;
    GRANT UPDATE (employee_id, status, reject_reason) ON attendance_events TO hrms_app;
    REVOKE DELETE ON employees, attendance_daily, approval_requests, approval_steps,
                     attendance_regularizations, tenants, tenant_domains FROM hrms_app;
    -- Registry is synced by the owner role only.
    REVOKE INSERT, UPDATE, DELETE ON feature_definitions, schema_migrations FROM hrms_app;
  END IF;
END $$;
