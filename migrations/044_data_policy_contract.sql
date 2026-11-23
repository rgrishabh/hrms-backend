-- 044: contract step. 043 has sealed the data, so the plaintext copies go, and the audit log becomes a hash chain.
-- Check constraints that went with the plaintext columns now live in the application (see docs/DATA_SECURITY.md).

ALTER TABLE employee_salaries DROP COLUMN amounts, DROP COLUMN annual_ctc, ALTER COLUMN amounts_enc SET NOT NULL;
ALTER TABLE payroll_items DROP COLUMN lines, DROP COLUMN gross, DROP COLUMN deductions, DROP COLUMN net, DROP COLUMN employer_cost, DROP COLUMN warnings, ALTER COLUMN data_enc SET NOT NULL;
ALTER TABLE payroll_runs DROP COLUMN totals;
ALTER TABLE payroll_adjustments DROP COLUMN amount, DROP COLUMN note, ALTER COLUMN data_enc SET NOT NULL;
ALTER TABLE accounting_exports DROP COLUMN total, ALTER COLUMN total_enc SET NOT NULL;
ALTER TABLE report_snapshots DROP COLUMN rows, DROP COLUMN totals, ALTER COLUMN data_enc SET NOT NULL;

-- Someone must sit above everyone in the salary hierarchy, or nobody could produce a whole bank file: the oldest active administrator becomes the Owner.
INSERT INTO user_roles (user_id, tenant_id, role_key)
SELECT DISTINCT ON (u.tenant_id) u.id, u.tenant_id, 'owner' FROM users u JOIN user_roles r ON r.user_id=u.id AND r.role_key='tenant_admin' WHERE u.tenant_id IS NOT NULL AND u.status='active' ORDER BY u.tenant_id, u.created_at, u.id;

-- The release of held pay checked NEW.net here. The application checks it now, before it writes (payroll/routes.ts, release).
CREATE OR REPLACE FUNCTION payroll_guard_finalized() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st text;
  release_cols text[] := ARRAY['hold','hold_released_at','hold_released_by','hold_release_reason'];
BEGIN
  SELECT status INTO st FROM payroll_runs WHERE tenant_id = coalesce(NEW.tenant_id, OLD.tenant_id) AND id = coalesce(NEW.run_id, OLD.run_id);
  IF st IN ('finalized','paid') THEN
    IF TG_TABLE_NAME = 'payroll_items' AND TG_OP = 'UPDATE' THEN
      IF OLD.hold AND NOT NEW.hold AND NEW.hold_released_at IS NOT NULL AND (to_jsonb(NEW) - release_cols) = (to_jsonb(OLD) - release_cols) THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'payroll run is % and cannot be changed', st USING ERRCODE = 'check_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;

-- ---------------------------------------------------------------- the audit chain
-- One head per tenant. Taking its row lock in the trigger is the serialized lock: appends of one tenant line up, and the
-- transaction holds the head until it commits, so sequence order is commit order.
CREATE TABLE audit_chain_heads (
  chain_key  uuid PRIMARY KEY,
  last_seq   bigint NOT NULL,
  last_hash  text NOT NULL
);
REVOKE ALL ON audit_chain_heads FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN REVOKE ALL ON audit_chain_heads FROM hrms_app; END IF;
END $$;

CREATE FUNCTION audit_row_hash(l audit_logs, prev text, seq bigint) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws(E'\x1f', prev, seq::text, l.id::text, coalesce(l.tenant_id::text, ''), coalesce(l.actor_id::text, ''), l.actor_type, l.action, l.category,
    coalesce(l.target_type, ''), coalesce(l.target_id, ''), coalesce(l.setting_key, ''), l.change_metadata::text, coalesce(l.request_id, ''), coalesce(l.ip, ''), coalesce(l.user_agent, ''),
    (extract(epoch FROM l.created_at) * 1000000)::bigint::text), 'UTF8')), 'hex')
$$;

CREATE FUNCTION audit_chain_key(tenant uuid) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce(tenant, '00000000-0000-0000-0000-000000000000'::uuid) $$;

-- Existing rows, oldest first, chained as if they had always been: order by time, then id.
DO $$
DECLARE l audit_logs; k uuid; s bigint; h text; p text; last_k uuid := NULL;
BEGIN
  FOR l IN SELECT * FROM audit_logs ORDER BY audit_chain_key(tenant_id), created_at, id LOOP
    k := audit_chain_key(l.tenant_id);
    IF k IS DISTINCT FROM last_k THEN s := 0; h := repeat('0', 64); last_k := k; END IF;
    s := s + 1;
    p := h;
    h := audit_row_hash(l, p, s);
    UPDATE audit_logs SET chain_seq = s, prev_hash = p, row_hash = h WHERE id = l.id;
    INSERT INTO audit_chain_heads (chain_key, last_seq, last_hash) VALUES (k, s, h) ON CONFLICT (chain_key) DO UPDATE SET last_seq = EXCLUDED.last_seq, last_hash = EXCLUDED.last_hash;
  END LOOP;
END $$;
CREATE UNIQUE INDEX audit_logs_chain_uq ON audit_logs (audit_chain_key(tenant_id), chain_seq);
ALTER TABLE audit_logs ALTER COLUMN chain_seq SET NOT NULL, ALTER COLUMN prev_hash SET NOT NULL, ALTER COLUMN row_hash SET NOT NULL;

CREATE FUNCTION audit_chain_append() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
CREATE TRIGGER audit_logs_chain BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_chain_append();

-- Append-only for everyone, whatever their grants. A table owner could drop the trigger; verify would then find the break.
CREATE FUNCTION audit_logs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = 'insufficient_privilege'; END $$;
CREATE TRIGGER audit_logs_no_change BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();

-- Walks one tenant's chain and reports the first row that does not fit. SECURITY DEFINER because the head is not readable by the app.
CREATE FUNCTION audit_chain_verify(tenant uuid) RETURNS TABLE (ok boolean, checked bigint, broken_seq bigint, reason text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k uuid := audit_chain_key(tenant); l audit_logs; n bigint := 0; h text := repeat('0', 64); head audit_chain_heads;
BEGIN
  FOR l IN SELECT * FROM audit_logs WHERE audit_chain_key(tenant_id) = k ORDER BY chain_seq LOOP
    n := n + 1;
    IF l.chain_seq <> n THEN RETURN QUERY SELECT false, n - 1, n, 'row missing'; RETURN; END IF;
    IF l.prev_hash <> h THEN RETURN QUERY SELECT false, n - 1, n, 'previous hash does not match'; RETURN; END IF;
    IF audit_row_hash(l, h, n) <> l.row_hash THEN RETURN QUERY SELECT false, n - 1, n, 'row was changed'; RETURN; END IF;
    h := l.row_hash;
  END LOOP;
  SELECT * INTO head FROM audit_chain_heads WHERE chain_key = k;
  IF head IS NOT NULL AND (head.last_seq <> n OR head.last_hash <> h) THEN RETURN QUERY SELECT false, n, n + 1, 'rows missing at the end of the chain'; RETURN; END IF;
  RETURN QUERY SELECT true, n, NULL::bigint, NULL::text;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN GRANT EXECUTE ON FUNCTION audit_chain_verify(uuid) TO hrms_app; END IF;
END $$;
