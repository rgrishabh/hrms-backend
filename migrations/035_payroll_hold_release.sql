-- 035: pay held at finalize can be released afterwards (F-12). Finalized items stay immutable except for that one step.
ALTER TABLE payroll_items
  ADD COLUMN hold_released_at timestamptz,
  ADD COLUMN hold_released_by uuid REFERENCES users(id),
  ADD COLUMN hold_release_reason text;

CREATE OR REPLACE FUNCTION payroll_guard_finalized() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st text;
  release_cols text[] := ARRAY['hold','hold_released_at','hold_released_by','hold_release_reason'];
BEGIN
  SELECT status INTO st FROM payroll_runs WHERE tenant_id = coalesce(NEW.tenant_id, OLD.tenant_id) AND id = coalesce(NEW.run_id, OLD.run_id);
  IF st IN ('finalized','paid') THEN
    IF TG_TABLE_NAME = 'payroll_items' AND TG_OP = 'UPDATE' THEN
      IF OLD.hold AND NOT NEW.hold AND NEW.net >= 0 AND NEW.hold_released_at IS NOT NULL AND (to_jsonb(NEW) - release_cols) = (to_jsonb(OLD) - release_cols) THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'payroll run is % and cannot be changed', st USING ERRCODE = 'check_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
