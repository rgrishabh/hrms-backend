-- 011: expenses & reimbursements — categories, claims with items and receipts, payment batches
-- with maker-checker. Money is numeric(12,2) in the installation currency.

CREATE TABLE expense_categories (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  code               text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{0,19}$'),
  name               text NOT NULL,
  description        text,
  requires_receipt   boolean NOT NULL DEFAULT true,
  max_amount         numeric(12,2) CHECK (max_amount IS NULL OR max_amount > 0),   -- per item
  gst_applicable     boolean NOT NULL DEFAULT false,                                -- capture GSTIN / invoice no.
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code), UNIQUE (tenant_id, id)
);

CREATE TABLE reimbursement_batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  status       text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','approved','paid','cancelled')),
  total        numeric(14,2) NOT NULL DEFAULT 0,
  claim_count  integer NOT NULL DEFAULT 0,
  prepared_by  uuid NOT NULL REFERENCES users(id),
  approved_by  uuid REFERENCES users(id),
  approved_at  timestamptz,
  paid_by      uuid REFERENCES users(id),
  paid_at      timestamptz,
  payment_reference text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (approved_by IS NULL OR approved_by <> prepared_by)            -- maker-checker
);

CREATE TABLE expense_claims (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  employee_id    uuid NOT NULL,
  title          text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  purpose        text NOT NULL CHECK (length(purpose) BETWEEN 3 AND 1000),
  project        text,                                     -- cost centre / project / client visit reference
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','returned','paid','cancelled')),
  total          numeric(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  currency       text NOT NULL DEFAULT 'INR',
  created_by     uuid NOT NULL REFERENCES users(id),
  submitted_at   timestamptz,
  approved_at    timestamptz,
  batch_id       uuid,
  paid_at        timestamptz,
  payment_reference text,
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES reimbursement_batches (tenant_id, id)
);
CREATE INDEX expense_claims_emp_idx ON expense_claims (tenant_id, employee_id, status);
CREATE INDEX expense_claims_status_idx ON expense_claims (tenant_id, status, approved_at);

CREATE TABLE expense_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  claim_id      uuid NOT NULL,
  category_id   uuid NOT NULL,
  expense_date  date NOT NULL,
  amount        numeric(12,2) NOT NULL CHECK (amount > 0),
  description   text NOT NULL CHECK (length(description) BETWEEN 2 AND 500),
  merchant      text,
  invoice_number text,
  gstin         text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  receipt_key   text UNIQUE,                      -- storage key; never from user input
  receipt_name  text,
  receipt_type  text,
  receipt_sha256 text,
  duplicate_of  uuid,                             -- flagged possible duplicate (another item)
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, claim_id) REFERENCES expense_claims (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES expense_categories (tenant_id, id)
);
CREATE INDEX expense_items_claim_idx ON expense_items (tenant_id, claim_id);
CREATE INDEX expense_items_dupe_idx ON expense_items (tenant_id, expense_date, amount);
-- The same supplier invoice can only be claimed once.
CREATE UNIQUE INDEX expense_items_invoice_uq ON expense_items (tenant_id, gstin, upper(invoice_number)) WHERE gstin IS NOT NULL AND invoice_number IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['expense_categories','reimbursement_batches','expense_claims','expense_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE DELETE ON expense_categories, reimbursement_batches, expense_claims FROM hrms_app;  -- items of DRAFT claims may be removed
  END IF;
END $$;
