-- 007: background job runs. One row per (organization, job, period) — the unique key is
-- what guarantees a scheduled job runs once even with several app instances.
CREATE TABLE job_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  job_key        text NOT NULL,
  period_key     text NOT NULL,                       -- e.g. 2026-11-03, 2026-11, manual:<uuid>
  trigger        text NOT NULL CHECK (trigger IN ('schedule','manual')),
  status         text NOT NULL CHECK (status IN ('running','succeeded','failed')),
  attempts       integer NOT NULL DEFAULT 1,
  triggered_by   uuid REFERENCES users(id),
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  next_retry_at  timestamptz,
  result         jsonb,
  error          text,
  UNIQUE (tenant_id, job_key, period_key)
);
CREATE INDEX job_runs_recent_idx ON job_runs (tenant_id, job_key, started_at DESC);
CREATE INDEX job_runs_retry_idx ON job_runs (status, next_retry_at) WHERE status IN ('running','failed');

ALTER TABLE job_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON job_runs
  USING (app_platform_bypass() OR tenant_id = app_current_tenant())
  WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE DELETE ON job_runs FROM hrms_app;
  END IF;
END $$;
