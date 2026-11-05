-- Undoes 004: FORCE again on the tables 003 forced, the only ones that ever had it. Backups by the owner fail in this state, as 004 explains.
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
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
