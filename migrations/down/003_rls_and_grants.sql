-- Undoes 003: policies, row security, the app role's grants on everything that exists at this point (001, 002, schema_migrations), and its default privileges.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_domains','tenant_branding','tenant_feature_entitlements','tenant_modules',
    'tenant_settings','tenant_integrations','tenant_roles','legal_entities','branches',
    'departments','employees','employee_bank_accounts','approval_requests','approval_steps',
    'shifts','shift_assignments','holidays','attendance_devices','device_user_mappings',
    'attendance_events','attendance_daily','attendance_regularizations','attendance_period_locks',
    'users','user_roles','sessions','audit_logs'
  ] LOOP
    EXECUTE format('DROP POLICY tenant_isolation ON %I', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM hrms_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM hrms_app;
    -- Revoking on the table also takes the column grant 003 gave on attendance_events.
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM hrms_app;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM hrms_app;
    REVOKE USAGE ON SCHEMA public FROM hrms_app;
  END IF;
END $$;
