-- 010: multi-factor authentication (TOTP). Secrets are encrypted by the application
-- (AES-256-GCM, DATA_ENCRYPTION_KEY); recovery codes are stored as SHA-256 hashes only.
ALTER TABLE users ADD COLUMN mfa_secret_enc text;
ALTER TABLE users ADD COLUMN mfa_pending_secret_enc text;
ALTER TABLE users ADD COLUMN mfa_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN mfa_recovery_hashes text[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN mfa_last_step bigint;                 -- last accepted TOTP time step (replay protection)
ALTER TABLE sessions ADD COLUMN mfa_verified_at timestamptz;
ALTER TABLE sessions ADD COLUMN mfa_failures integer NOT NULL DEFAULT 0;
