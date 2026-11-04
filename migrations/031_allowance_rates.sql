-- 031: per-diem and mileage allowances. Rates are the organization's own policy (none are shipped):
-- per diem per day by destination class (e.g. METRO, OTHER, INTL) and optionally by grade; mileage per km by vehicle.
-- Rates are effective-dated and never edited: a new rate takes over from its date, so old claims stay explainable.
-- An expense category with `calc` computes the item from a quantity (days / km) × the rate on the expense date.

CREATE TABLE allowance_rates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  kind           text NOT NULL CHECK (kind IN ('per_diem','mileage')),
  tier           text CHECK (tier IS NULL OR tier ~ '^[A-Z0-9_]{1,20}$'),           -- per diem: destination class
  grade          text CHECK (grade IS NULL OR length(grade) BETWEEN 1 AND 20),     -- per diem: NULL = every grade
  vehicle        text CHECK (vehicle IS NULL OR vehicle IN ('car','two_wheeler')), -- mileage
  rate           numeric(12,2) NOT NULL CHECK (rate > 0),
  effective_from date NOT NULL,
  note           text CHECK (note IS NULL OR length(note) <= 200),
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'per_diem' AND tier IS NOT NULL AND vehicle IS NULL) OR (kind = 'mileage' AND vehicle IS NOT NULL AND tier IS NULL AND grade IS NULL))
);
CREATE UNIQUE INDEX allowance_rates_uq ON allowance_rates (tenant_id, kind, coalesce(tier,''), coalesce(grade,''), coalesce(vehicle,''), effective_from);

ALTER TABLE allowance_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON allowance_rates
  USING (app_platform_bypass() OR tenant_id = app_current_tenant())
  WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN REVOKE UPDATE ON allowance_rates FROM hrms_app; END IF;   -- superseded, never edited
END $$;

ALTER TABLE expense_categories ADD COLUMN calc text CHECK (calc IS NULL OR calc IN ('per_diem','mileage'));

-- How a computed item was worked out: quantity (days or km) × rate, and which rate.
ALTER TABLE expense_items
  ADD COLUMN quantity  numeric(8,2) CHECK (quantity IS NULL OR quantity > 0),
  ADD COLUMN rate      numeric(12,2),
  ADD COLUMN rate_id   uuid REFERENCES allowance_rates(id),
  ADD COLUMN tier      text,
  ADD COLUMN vehicle   text;
