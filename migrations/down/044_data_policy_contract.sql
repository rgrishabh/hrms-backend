-- Undoes 044. Must be followed at once by the down of 043_encrypt_l4_data.code, which rollback enforces: the plaintext columns come back with the
-- exact definition they had, NOT NULL included, and a NOT NULL column on a table with rows needs a value before the key can supply the real one. So until
-- that step runs they hold PLACEHOLDERS (0, '{}', '[]', and 1 for an adjustment, since its check refuses 0). The sealed values stay beside them, untouched.
-- Data: the audit chain ends. Its columns are cleared, and 044 going up again chains whatever the rows are then, so it would not reveal a change made in between.

DROP FUNCTION audit_chain_verify(uuid);
DROP TRIGGER audit_logs_no_truncate ON audit_logs;
DROP TRIGGER audit_logs_no_change ON audit_logs;
DROP FUNCTION audit_logs_immutable();
DROP TRIGGER audit_logs_chain ON audit_logs;
DROP FUNCTION audit_chain_append();
DROP INDEX audit_logs_chain_uq;
ALTER TABLE audit_logs ALTER COLUMN chain_seq DROP NOT NULL, ALTER COLUMN prev_hash DROP NOT NULL, ALTER COLUMN row_hash DROP NOT NULL;
UPDATE audit_logs SET chain_seq = NULL, prev_hash = NULL, row_hash = NULL;
DROP FUNCTION audit_chain_key(uuid);
DROP FUNCTION audit_row_hash(audit_logs, text, bigint);
DROP TABLE audit_chain_heads;

-- The guard as 035 wrote it: it checks NEW.net again.
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

-- The previous release has no owner role. Whoever holds it keeps administering: as tenant_admin, unless they already are.
UPDATE user_roles o SET role_key = 'tenant_admin' WHERE o.role_key = 'owner' AND NOT EXISTS (
  SELECT 1 FROM user_roles a WHERE a.user_id = o.user_id AND a.role_key = 'tenant_admin' AND a.scope_type = o.scope_type AND a.scope_id IS NOT DISTINCT FROM o.scope_id);
DELETE FROM user_roles WHERE role_key = 'owner';

ALTER TABLE report_snapshots ALTER COLUMN data_enc DROP NOT NULL, ADD COLUMN rows jsonb NOT NULL DEFAULT '[]', ADD COLUMN totals jsonb;
ALTER TABLE report_snapshots ALTER COLUMN rows DROP DEFAULT;
ALTER TABLE accounting_exports ALTER COLUMN total_enc DROP NOT NULL, ADD COLUMN total numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE accounting_exports ALTER COLUMN total DROP DEFAULT;
ALTER TABLE payroll_adjustments ALTER COLUMN data_enc DROP NOT NULL,
  ADD COLUMN amount numeric(12,2) NOT NULL DEFAULT 1 CONSTRAINT payroll_adjustments_amount_check CHECK (amount <> 0), ADD COLUMN note text;
ALTER TABLE payroll_adjustments ALTER COLUMN amount DROP DEFAULT;
ALTER TABLE payroll_runs ADD COLUMN totals jsonb NOT NULL DEFAULT '{}';
ALTER TABLE payroll_items ALTER COLUMN data_enc DROP NOT NULL,
  ADD COLUMN lines jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN gross numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN deductions numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN net numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN employer_cost numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN warnings jsonb NOT NULL DEFAULT '[]';
ALTER TABLE payroll_items ALTER COLUMN lines DROP DEFAULT, ALTER COLUMN gross DROP DEFAULT, ALTER COLUMN deductions DROP DEFAULT, ALTER COLUMN net DROP DEFAULT, ALTER COLUMN employer_cost DROP DEFAULT;
ALTER TABLE employee_salaries ALTER COLUMN amounts_enc DROP NOT NULL, ADD COLUMN amounts jsonb NOT NULL DEFAULT '{}', ADD COLUMN annual_ctc numeric(12,2);
ALTER TABLE employee_salaries ALTER COLUMN amounts DROP DEFAULT;
