-- 008: notifications — in-app inbox and an email outbox (transactional outbox pattern:
-- emails are queued in the same transaction as the event and delivered asynchronously).

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text,
  link        text CHECK (link IS NULL OR link ~ '^/[^/]'),   -- in-app relative links only
  dedupe_key  text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (tenant_id, user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (tenant_id, user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX notifications_dedupe_uq ON notifications (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE email_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  to_user_id       uuid REFERENCES users(id),
  to_email         text NOT NULL,
  subject          text NOT NULL,
  text_body        text NOT NULL,
  html_body        text NOT NULL,
  kind             text NOT NULL,
  dedupe_key       text,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz
);
CREATE INDEX email_outbox_due_idx ON email_outbox (status, next_attempt_at) WHERE status IN ('queued','sending');
CREATE UNIQUE INDEX email_outbox_dedupe_uq ON email_outbox (tenant_id, to_email, dedupe_key) WHERE dedupe_key IS NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notifications boolean NOT NULL DEFAULT true;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications','email_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE DELETE ON notifications, email_outbox FROM hrms_app;
  END IF;
END $$;
