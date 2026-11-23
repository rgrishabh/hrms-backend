-- Undoes 035: the guard as 016 wrote it. Data: who released held pay, when and why is lost; `hold` itself stays as it is.
CREATE OR REPLACE FUNCTION payroll_guard_finalized() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM payroll_runs WHERE tenant_id = coalesce(NEW.tenant_id, OLD.tenant_id) AND id = coalesce(NEW.run_id, OLD.run_id);
  IF st IN ('finalized','paid') THEN RAISE EXCEPTION 'payroll run is % and cannot be changed', st USING ERRCODE = 'check_violation'; END IF;
  RETURN coalesce(NEW, OLD);
END $$;
ALTER TABLE payroll_items DROP COLUMN hold_released_at, DROP COLUMN hold_released_by, DROP COLUMN hold_release_reason;
