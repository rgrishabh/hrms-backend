-- 025: SMS notifications — the organization's DLT-registered templates per notification kind, an outbox
-- written in the caller's transaction (like email), and each user's opt-out.

ALTER TABLE users ADD COLUMN IF NOT EXISTS sms_notifications boolean NOT NULL DEFAULT true;

CREATE TABLE sms_templates (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  kind             text NOT NULL CHECK (kind ~ '^[a-z_]+\.[a-z_.]+$'),
  dlt_template_id  text NOT NULL CHECK (dlt_template_id ~ '^[0-9]{10,25}$'),   -- as registered on the operator's DLT portal
  text             text NOT NULL CHECK (length(text) BETWEEN 5 AND 500),     -- the registered text; {#var#} placeholders
  enabled          boolean NOT NULL DEFAULT true,
  updated_by       uuid REFERENCES users(id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind)
);

CREATE TABLE sms_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  to_user_id       uuid REFERENCES users(id),
  to_phone         text NOT NULL,
  kind             text NOT NULL,
  dlt_template_id  text NOT NULL,
  text             text NOT NULL,
  dedupe_key       text,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  provider_ref     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz
);
CREATE INDEX sms_outbox_due_idx ON sms_outbox (status, next_attempt_at) WHERE status IN ('queued','sending');
CREATE INDEX sms_outbox_tenant_idx ON sms_outbox (tenant_id, created_at DESC);
CREATE UNIQUE INDEX sms_outbox_dedupe_uq ON sms_outbox (tenant_id, to_user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sms_templates','sms_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE DELETE ON sms_outbox FROM hrms_app;
  END IF;
END $$;
