-- Undoes 047. Data, beyond the tables and columns themselves:
--  * Mail holding a sealed code or link cannot be sent by the previous release (its body has only a placeholder): marked failed.
--  * Reset and invitation links would look like first-administrator setup links to it: marked used. People ask again.
--  * Someone enrolled in email codes has no TOTP secret, and the previous release would lock them out: their MFA is turned off and they enrol again. This lowers
--    protection for them until they do; run `SELECT id FROM users WHERE mfa_method = 'email'` first if you need the list.
--  * The security.mfa_enforcement rows 047 deleted were not kept. The previous release falls back to its default.
UPDATE email_outbox SET status = 'failed', last_error = 'Holds a sealed secret; failed when migration 047 was rolled back'
 WHERE secret_enc IS NOT NULL AND status IN ('queued','sending');
ALTER TABLE email_outbox DROP COLUMN secret_enc, DROP COLUMN expires_at;

UPDATE admin_setup_tokens SET used_at = now() WHERE purpose <> 'setup' AND used_at IS NULL;
ALTER TABLE admin_setup_tokens DROP COLUMN purpose;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE INSERT ON admin_setup_tokens FROM hrms_app;
  END IF;
END $$;

DROP TABLE email_otps, user_devices, auth_throttle;

UPDATE users SET mfa_secret_enc = NULL, mfa_pending_secret_enc = NULL, mfa_enabled_at = NULL, mfa_recovery_hashes = '{}', mfa_last_step = NULL WHERE mfa_method = 'email';
ALTER TABLE users DROP COLUMN mfa_method, DROP COLUMN mfa_failures, DROP COLUMN mfa_locked_until;

ALTER TABLE sessions DROP COLUMN idle_timeout_minutes;
