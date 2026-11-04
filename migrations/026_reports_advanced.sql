-- 026: advanced reporting — saved report views, schedules that run them for their owner, and the
-- snapshots recipients open in HRMS (no report data is ever put in an email).

CREATE TABLE saved_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  owner_id     uuid NOT NULL REFERENCES users(id),
  report_key   text NOT NULL CHECK (report_key ~ '^[a-z_]{2,60}$'),
  name         text NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
  params       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, owner_id, name)
);

-- Relative periods: a scheduled report's dates move with each run ("last month", "last 7 days"…).
CREATE TABLE report_schedules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  saved_report_id  uuid NOT NULL,
  frequency        text NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  weekday          integer CHECK (weekday BETWEEN 0 AND 6),        -- weekly: 0 = Sunday
  day_of_month     integer CHECK (day_of_month BETWEEN 1 AND 28),  -- monthly
  period           text NOT NULL DEFAULT 'as_saved' CHECK (period IN ('as_saved','yesterday','last_7_days','last_month','month_to_date','year_to_date')),
  recipient_ids    uuid[] NOT NULL DEFAULT '{}',
  enabled          boolean NOT NULL DEFAULT true,
  next_run_on      date NOT NULL,
  last_run_at      timestamptz,
  last_result      text,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, saved_report_id) REFERENCES saved_reports (tenant_id, id) ON DELETE CASCADE,
  CHECK ((frequency = 'weekly') = (weekday IS NOT NULL)),
  CHECK ((frequency = 'monthly') = (day_of_month IS NOT NULL))
);
CREATE INDEX report_schedules_due_idx ON report_schedules (tenant_id, next_run_on) WHERE enabled;

CREATE TABLE report_snapshots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  schedule_id    uuid,
  owner_id       uuid NOT NULL REFERENCES users(id),
  report_key     text NOT NULL,
  name           text NOT NULL,
  params         jsonb NOT NULL,
  scope          text NOT NULL CHECK (scope IN ('all','team')),
  columns        jsonb NOT NULL,
  rows           jsonb NOT NULL,
  totals         jsonb,
  notes          jsonb NOT NULL DEFAULT '[]',
  row_count      integer NOT NULL,
  recipient_ids  uuid[] NOT NULL,
  generated_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, schedule_id) REFERENCES report_schedules (tenant_id, id) ON DELETE SET NULL
);
CREATE INDEX report_snapshots_recipient_idx ON report_snapshots USING gin (recipient_ids);
CREATE INDEX report_snapshots_expiry_idx ON report_snapshots (tenant_id, expires_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['saved_reports','report_schedules','report_snapshots'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
END $$;
