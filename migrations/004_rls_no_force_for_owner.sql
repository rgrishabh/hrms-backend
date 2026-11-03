-- 004: stop forcing RLS on the schema owner.
-- FORCE made pg_dump (run as the owner) fail with "query would be affected by
-- row-level security policy", i.e. backups were impossible. The owner can always
-- ALTER TABLE ... DISABLE ROW LEVEL SECURITY, so FORCE gave it no real protection.
-- Isolation for the application is unchanged: hrms_app is neither owner nor
-- BYPASSRLS, so every policy still applies to it (verified at server start).
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity LOOP
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
