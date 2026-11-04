-- "Run now" in the API queues a run; the worker executes it (only the worker runs jobs).
ALTER TABLE job_runs DROP CONSTRAINT job_runs_status_check;
ALTER TABLE job_runs ADD CONSTRAINT job_runs_status_check CHECK (status IN ('queued','running','succeeded','failed'));
CREATE INDEX job_runs_queued_idx ON job_runs (tenant_id, started_at) WHERE status = 'queued';
