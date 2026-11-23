-- 046: the audit chain takes its lock at commit, not at insert (DECISIONS.md D37). Measured against 044: two transactions taking the head and
-- another row in opposite orders deadlocked (40P01), and any open transaction that had audited stopped every other audited write of the tenant.
-- A deferred trigger makes the head the last lock of a transaction, so there is no order to get wrong, and holds it only while committing.
DROP TRIGGER audit_logs_chain ON audit_logs;

ALTER TABLE audit_logs ALTER COLUMN chain_seq DROP NOT NULL, ALTER COLUMN prev_hash DROP NOT NULL, ALTER COLUMN row_hash DROP NOT NULL;

CREATE OR REPLACE FUNCTION audit_chain_append() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k uuid := audit_chain_key(NEW.tenant_id); s bigint; p text; h text;
BEGIN
  INSERT INTO audit_chain_heads (chain_key, last_seq, last_hash) VALUES (k, 0, repeat('0', 64)) ON CONFLICT (chain_key) DO NOTHING;
  SELECT last_seq, last_hash INTO s, p FROM audit_chain_heads WHERE chain_key = k FOR UPDATE;
  h := audit_row_hash(NEW, p, s + 1);
  UPDATE audit_logs SET chain_seq = s + 1, prev_hash = p, row_hash = h WHERE id = NEW.id;
  UPDATE audit_chain_heads SET last_seq = s + 1, last_hash = h WHERE chain_key = k;
  RETURN NULL;
END $$;

-- Runs inside COMMIT, in the order the rows were inserted. A row cannot be committed without it: a failure here aborts the transaction.
CREATE CONSTRAINT TRIGGER audit_logs_chain AFTER INSERT ON audit_logs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION audit_chain_append();

-- Still append-only. The one update allowed is the chain trigger filling in the chain columns of a row that has none, nothing else changing:
-- trigger depth tells it apart from a statement, and such a row is uncommitted, so no other transaction can reach it.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND pg_trigger_depth() > 1 AND OLD.chain_seq IS NULL AND NEW.chain_seq IS NOT NULL
     AND (to_jsonb(NEW) - 'chain_seq' - 'prev_hash' - 'row_hash') = (to_jsonb(OLD) - 'chain_seq' - 'prev_hash' - 'row_hash') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
