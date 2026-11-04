-- 023: salary advances and employee loans (interest-free), recovered in equal monthly instalments
-- through payroll (in full in a full-and-final run), or repaid directly.

CREATE TABLE employee_loans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  employee_id         uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('salary_advance','loan')),
  amount              numeric(12,2) NOT NULL CHECK (amount > 0 AND amount = trunc(amount)),   -- whole rupees (payslip lines are)
  installments        integer NOT NULL CHECK (installments BETWEEN 1 AND 120),
  installment_amount  numeric(12,2) NOT NULL CHECK (installment_amount > 0 AND installment_amount = trunc(installment_amount)),
  first_period        text NOT NULL CHECK (first_period ~ '^\d{4}-(0[1-9]|1[0-2])$'),        -- first payroll month to recover in
  skip_periods        text[] NOT NULL DEFAULT '{}',                                            -- months deferred by payroll
  purpose             text NOT NULL CHECK (length(purpose) BETWEEN 3 AND 1000),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','returned','cancelled','disbursed','closed')),
  created_by          uuid NOT NULL REFERENCES users(id),
  decided_at          timestamptz,
  disbursed_at        timestamptz,
  disbursed_by        uuid REFERENCES users(id),
  disbursement_reference text,
  closed_at           timestamptz,
  cancelled_by        uuid REFERENCES users(id),
  cancel_reason       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE INDEX employee_loans_emp_idx ON employee_loans (tenant_id, employee_id, status);

-- What has been taken back: a payroll deduction (counts once its run is not cancelled; recovered once the run is
-- finalized or paid) or a direct repayment by the employee.
CREATE TABLE loan_recoveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  loan_id         uuid NOT NULL,
  source          text NOT NULL CHECK (source IN ('payroll','repayment')),
  payroll_run_id  uuid,
  period          text,
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  reference       text,
  recorded_by     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, loan_id) REFERENCES employee_loans (tenant_id, id),
  FOREIGN KEY (tenant_id, payroll_run_id) REFERENCES payroll_runs (tenant_id, id),
  CHECK ((source = 'payroll') = (payroll_run_id IS NOT NULL))
);
CREATE INDEX loan_recoveries_loan_idx ON loan_recoveries (tenant_id, loan_id);
CREATE UNIQUE INDEX loan_recoveries_run_uq ON loan_recoveries (tenant_id, loan_id, payroll_run_id) WHERE payroll_run_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee_loans','loan_recoveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE DELETE ON employee_loans FROM hrms_app;   -- loan_recoveries of a run being recomputed are replaced
  END IF;
END $$;

-- A payroll recovery can only be removed while its run is still being computed (never once approved or final).
CREATE FUNCTION loan_recoveries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.payroll_run_id IS NULL OR EXISTS (SELECT 1 FROM payroll_runs r WHERE r.tenant_id=OLD.tenant_id AND r.id=OLD.payroll_run_id AND r.status NOT IN ('draft','computed','cancelled')) THEN
    RAISE EXCEPTION 'loan recovery % is final', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER loan_recoveries_guard BEFORE DELETE OR UPDATE ON loan_recoveries FOR EACH ROW EXECUTE FUNCTION loan_recoveries_guard();
