-- 016: payroll — components, effective-dated employee salaries (approved), statutory rule register
-- (values entered and VERIFIED by the organization, never shipped as defaults), employee statutory
-- details, payroll runs (compute → approve → finalize → paid), items, adjustments, payslips.

CREATE TABLE pay_components (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  code        text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{0,19}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  kind        text NOT NULL CHECK (kind IN ('earning','deduction')),
  calc        text NOT NULL DEFAULT 'fixed' CHECK (calc IN ('fixed','percent')),   -- percent: of the sum of `base_codes`
  base_codes  text[] NOT NULL DEFAULT '{}',
  prorate     boolean NOT NULL DEFAULT true,              -- by paid days
  taxable     boolean NOT NULL DEFAULT true,
  pf_wage     boolean NOT NULL DEFAULT false,             -- counts towards PF wages
  esi_wage    boolean NOT NULL DEFAULT true,              -- counts towards ESI wages
  position    integer NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code), UNIQUE (tenant_id, id),
  CHECK (calc <> 'percent' OR cardinality(base_codes) > 0)
);

CREATE TABLE employee_salaries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  employee_id    uuid NOT NULL,
  effective_from date NOT NULL,
  -- {CODE: monthly amount} for fixed components, {CODE: percent} for percent components
  amounts        jsonb NOT NULL,
  annual_ctc     numeric(12,2),
  reason         text NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected','superseded','cancelled')),
  created_by     uuid NOT NULL REFERENCES users(id),
  approved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE UNIQUE INDEX employee_salaries_active_uq ON employee_salaries (tenant_id, employee_id, effective_from) WHERE status = 'active';
CREATE UNIQUE INDEX employee_salaries_pending_uq ON employee_salaries (tenant_id, employee_id) WHERE status = 'pending';

-- Employee statutory identifiers. PAN is encrypted (field cipher); only the last 4 are kept in clear.
CREATE TABLE employee_statutory (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  employee_id    uuid NOT NULL,
  uan            text CHECK (uan IS NULL OR uan ~ '^[0-9]{12}$'),
  pf_member_id   text,
  pf_excluded    boolean NOT NULL DEFAULT false,         -- not covered (e.g. excluded employee as per the organization's assessment)
  esi_ip_number  text CHECK (esi_ip_number IS NULL OR esi_ip_number ~ '^[0-9]{10}$'),
  pan_enc        text,
  pan_last4      text,
  tax_regime     text NOT NULL DEFAULT 'new' CHECK (tax_regime IN ('new','old')),
  pt_state       text,                                    -- default: branch state
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, employee_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

-- Statutory rule register. A rule only applies when status='active' AND verified. Values come from the
-- organization's verified sources (notification/circular cited in source_reference).
CREATE TABLE statutory_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  kind             text NOT NULL CHECK (kind IN ('pf','esi','pt','lwf','tds')),
  scope            text NOT NULL DEFAULT 'IN',             -- state name for pt/lwf, regime ('new'/'old') for tds, 'IN' otherwise
  effective_from   date NOT NULL,
  effective_to     date,
  params           jsonb NOT NULL,
  source_reference text NOT NULL CHECK (length(source_reference) >= 5),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  created_by       uuid NOT NULL REFERENCES users(id),
  verified_by      uuid REFERENCES users(id),
  verified_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (status <> 'active' OR verified_by IS NOT NULL),
  CHECK (verified_by IS NULL OR verified_by <> created_by)                   -- maker-checker
);
CREATE INDEX statutory_rules_idx ON statutory_rules (tenant_id, kind, scope, effective_from) WHERE status = 'active';

CREATE TABLE payroll_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id  uuid NOT NULL,
  period           text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  kind             text NOT NULL DEFAULT 'regular' CHECK (kind IN ('regular','fnf')),
  employee_id      uuid,                                    -- fnf: the leaver
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','computed','pending','approved','finalized','paid','cancelled')),
  totals           jsonb NOT NULL DEFAULT '{}',
  warnings         integer NOT NULL DEFAULT 0,
  warnings_acknowledged boolean NOT NULL DEFAULT false,
  computed_at      timestamptz,
  created_by       uuid NOT NULL REFERENCES users(id),
  approved_at      timestamptz,
  finalized_at     timestamptz,
  paid_at          timestamptz,
  payment_reference text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (kind <> 'fnf' OR employee_id IS NOT NULL),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entities (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE UNIQUE INDEX payroll_runs_regular_uq ON payroll_runs (tenant_id, legal_entity_id, period) WHERE kind = 'regular' AND status <> 'cancelled';

CREATE TABLE payroll_adjustments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  run_id       uuid NOT NULL,
  employee_id  uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('earning','deduction','lop_days')),
  label        text NOT NULL CHECK (length(label) BETWEEN 2 AND 80),
  amount       numeric(12,2) NOT NULL CHECK (amount <> 0),         -- lop_days: days (+ adds LOP, − reverses)
  taxable      boolean NOT NULL DEFAULT true,
  note         text,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES payroll_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

CREATE TABLE payroll_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  run_id         uuid NOT NULL,
  employee_id    uuid NOT NULL,
  salary_id      uuid,
  days_in_period numeric(5,2) NOT NULL,
  employed_days  numeric(5,2) NOT NULL,
  lop_days       numeric(5,2) NOT NULL DEFAULT 0,
  paid_days      numeric(5,2) NOT NULL,
  lines          jsonb NOT NULL,      -- [{code, name, kind: earning|deduction|employer, amount, basis?}]
  gross          numeric(12,2) NOT NULL,
  deductions     numeric(12,2) NOT NULL,
  net            numeric(12,2) NOT NULL,
  employer_cost  numeric(12,2) NOT NULL,
  warnings       jsonb NOT NULL DEFAULT '[]',
  hold           boolean NOT NULL DEFAULT false,
  calc_version   integer NOT NULL,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, run_id, employee_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES payroll_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pay_components','employee_salaries','employee_statutory','statutory_rules','payroll_runs','payroll_adjustments','payroll_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE DELETE ON pay_components, employee_salaries, statutory_rules, payroll_runs FROM hrms_app;
  END IF;
END $$;

-- Finalized runs are immutable: items and adjustments cannot change once the run is finalized or paid.
CREATE FUNCTION payroll_guard_finalized() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM payroll_runs WHERE tenant_id = coalesce(NEW.tenant_id, OLD.tenant_id) AND id = coalesce(NEW.run_id, OLD.run_id);
  IF st IN ('finalized','paid') THEN RAISE EXCEPTION 'payroll run is % and cannot be changed', st USING ERRCODE = 'check_violation'; END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER payroll_items_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_items FOR EACH ROW EXECUTE FUNCTION payroll_guard_finalized();
CREATE TRIGGER payroll_adjustments_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_adjustments FOR EACH ROW EXECUTE FUNCTION payroll_guard_finalized();
