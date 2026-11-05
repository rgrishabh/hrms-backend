-- Undoes 010.
ALTER TABLE sessions DROP COLUMN mfa_verified_at, DROP COLUMN mfa_failures;
ALTER TABLE users DROP COLUMN mfa_secret_enc, DROP COLUMN mfa_pending_secret_enc, DROP COLUMN mfa_enabled_at, DROP COLUMN mfa_recovery_hashes, DROP COLUMN mfa_last_step;
