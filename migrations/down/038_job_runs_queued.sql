-- Undoes 038. Data: a run still queued has no status in the old list and no worker would pick it up, so it is marked failed with the reason. Run it again by hand.
DROP INDEX job_runs_queued_idx;
ALTER TABLE job_runs DROP CONSTRAINT job_runs_status_check;
UPDATE job_runs SET status = 'failed', finished_at = now(), error = 'Queued when migration 038 was rolled back; not run' WHERE status = 'queued';
ALTER TABLE job_runs ADD CONSTRAINT job_runs_status_check CHECK (status IN ('running','succeeded','failed'));
