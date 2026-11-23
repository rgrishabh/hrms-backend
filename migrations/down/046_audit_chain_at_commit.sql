-- Undoes 046: the chain taken at insert, with both functions as 044 wrote them. A committed row always has its chain columns, so NOT NULL holds; if it does not, this stops here with the error.
DROP TRIGGER audit_logs_chain ON audit_logs;

CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = 'insufficient_privilege'; END $$;

CREATE OR REPLACE FUNCTION audit_chain_append() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k uuid := audit_chain_key(NEW.tenant_id); s bigint; p text;
BEGIN
  INSERT INTO audit_chain_heads (chain_key, last_seq, last_hash) VALUES (k, 0, repeat('0', 64)) ON CONFLICT (chain_key) DO NOTHING;
  SELECT last_seq, last_hash INTO s, p FROM audit_chain_heads WHERE chain_key = k FOR UPDATE;
  NEW.chain_seq := s + 1;
  NEW.prev_hash := p;
  NEW.row_hash := audit_row_hash(NEW, p, s + 1);
  UPDATE audit_chain_heads SET last_seq = NEW.chain_seq, last_hash = NEW.row_hash WHERE chain_key = k;
  RETURN NEW;
END $$;

ALTER TABLE audit_logs ALTER COLUMN chain_seq SET NOT NULL, ALTER COLUMN prev_hash SET NOT NULL, ALTER COLUMN row_hash SET NOT NULL;

CREATE TRIGGER audit_logs_chain BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_chain_append();
