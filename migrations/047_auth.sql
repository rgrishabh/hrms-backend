-- 047: sessions with an idle limit, back-off by who is failing, known browsers, email codes, links by purpose, secrets kept out of the outbox.

ALTER TABLE sessions ADD COLUMN idle_timeout_minutes integer NOT NULL DEFAULT 30 CHECK (idle_timeout_minutes BETWEEN 1 AND 1440);

-- Counters of failed sign-ins (core/auth/throttle.ts). users.failed_logins and locked_until stay for a rollback, and are no longer read.
CREATE TABLE auth_throttle (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  key_hash      text NOT NULL,
  subject_hash  text,
  failures      integer NOT NULL DEFAULT 0,
  blocked_until timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key_hash)
);
CREATE INDEX auth_throttle_subject_idx ON auth_throttle (tenant_id, subject_hash) WHERE subject_hash IS NOT NULL;

-- A browser that has signed in to an account: a random cookie, hashed. Decides the new-device email and the account-wide back-off.
CREATE TABLE user_devices (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  device_hash   text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_hash)
);

-- MFA: which method a user enrolled in, and failures across sessions, since signing in again must not reset the count of guesses.
ALTER TABLE users ADD COLUMN mfa_method text CHECK (mfa_method IN ('totp','email')),
  ADD COLUMN mfa_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN mfa_locked_until timestamptz;
UPDATE users SET mfa_method='totp' WHERE mfa_enabled_at IS NOT NULL;

CREATE TABLE email_otps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  purpose     text NOT NULL CHECK (purpose IN ('login','enrol')),
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_otps_user_idx ON email_otps (user_id, created_at DESC);

-- One table for every emailed link: bootstrap setup, invitations, password resets.
ALTER TABLE admin_setup_tokens ADD COLUMN purpose text NOT NULL DEFAULT 'setup' CHECK (purpose IN ('setup','invite','reset'));

-- A code or link is never stored readable in the outbox: the body has a placeholder, the secret is sealed beside it and cleared after sending.
ALTER TABLE email_outbox ADD COLUMN secret_enc text, ADD COLUMN expires_at timestamptz;

-- Enforcement is deployment configuration only now (DECISIONS.md D45).
DELETE FROM tenant_settings WHERE setting_key = 'security.mfa_enforcement';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['auth_throttle','user_devices','email_otps'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON auth_throttle, user_devices, email_otps TO hrms_app;
    GRANT INSERT ON admin_setup_tokens TO hrms_app;
  END IF;
END $$;
