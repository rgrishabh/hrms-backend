-- FEATURE_SALARY_ADVANCE and FEATURE_COMP_OFF are separate flags, so their approvals need their own entity types:
-- a pending request leaves the inbox with its own feature. The rows stay as they are, only the label moves.
SELECT set_config('app.platform_bypass', 'on', true);
UPDATE approval_requests r SET entity_type = 'salary_advance'
  FROM employee_loans l WHERE r.entity_type = 'employee_loan' AND l.tenant_id = r.tenant_id AND l.id = r.entity_id AND l.kind = 'salary_advance';
UPDATE approval_requests r SET entity_type = 'overtime_comp_off'
  FROM overtime_claims c WHERE r.entity_type = 'overtime_claim' AND c.tenant_id = r.tenant_id AND c.id = r.entity_id AND c.payout = 'comp_off';

DELETE FROM tenant_modules WHERE feature_key = 'advances_loans';
DELETE FROM tenant_feature_entitlements WHERE feature_key = 'advances_loans';
DELETE FROM feature_definitions WHERE key = 'advances_loans';

-- Geofence of a branch, apart from the branch itself so nothing reads it while the feature is off.
CREATE TABLE branch_geofences (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  branch_id   uuid NOT NULL,
  latitude    numeric(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude   numeric(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  radius_m    integer NOT NULL CHECK (radius_m BETWEEN 10 AND 100000),
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, branch_id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);
ALTER TABLE attendance_events ADD COLUMN outside_geofence boolean;

-- Check-in selfies. Personal data (L3): the blob lives in the store under storage_key and is erased at retain_until.
CREATE TABLE attendance_selfies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  employee_id   uuid NOT NULL,
  event_id      uuid,
  storage_key   text,
  content_type  text NOT NULL,
  size_bytes    integer NOT NULL,
  sha256        text NOT NULL,
  data_class    text NOT NULL DEFAULT 'L3' CHECK (data_class = 'L3'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  retain_until  timestamptz NOT NULL,
  erased_at     timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE INDEX attendance_selfies_due_idx ON attendance_selfies (tenant_id, retain_until) WHERE erased_at IS NULL;

-- Web push: one row per browser, and an outbox that holds no content, only the kind of event.
CREATE TABLE push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  endpoint     text NOT NULL,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  UNIQUE (tenant_id, endpoint)
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (tenant_id, user_id);
CREATE TABLE push_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  to_user_id       uuid NOT NULL REFERENCES users(id),
  kind             text NOT NULL,
  dedupe_key       text,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz
);
CREATE INDEX push_outbox_due_idx ON push_outbox (status, next_attempt_at) WHERE status IN ('queued','sending');
CREATE UNIQUE INDEX push_outbox_dedupe_uq ON push_outbox (tenant_id, to_user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['branch_geofences','attendance_selfies','push_subscriptions','push_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
END $$;
