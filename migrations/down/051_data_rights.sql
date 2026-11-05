-- Undoes 051. Erasure cannot be undone: what was anonymized, purged or deleted stays so. The sealed names held for statutory records and the list of who was erased go with the table,
-- and the marker on employees too, so an anonymized record then looks like any other exited employee named "Erased". Files still pending deletion stay in storage.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE DELETE ON notifications, email_outbox, job_runs, documents, employee_bank_changes FROM hrms_app;
    REVOKE UPDATE (latitude, longitude) ON attendance_events FROM hrms_app;
    REVOKE UPDATE (text_enc) ON case_events FROM hrms_app;
  END IF;
END $$;
ALTER TABLE employees DROP COLUMN erased_at;
DROP TABLE erasure_requests;
