-- 049: the employer's own details, Layer 3 of the configuration model. One row per organization. See DECISIONS.md D53.
-- PAN and the payroll bank account number are sealed by the application (core/crypto/columns.ts). Legal entities stay the fallback for name, GSTIN and CIN.

CREATE TABLE company_profile (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL UNIQUE REFERENCES tenants(id),
  legal_name            text,
  gstin                 text,
  pan_enc               text,
  pan_last4             text,
  tan                   text,
  cin                   text,
  registered_address    text,
  pf_registration       text,
  esi_registration      text,
  pt_registration       text,
  bank_account_holder   text,
  bank_name             text,
  bank_ifsc             text,
  bank_account_enc      text,
  bank_account_last4    text,
  signatory_name        text,
  signatory_designation text,
  signature_key         text UNIQUE,
  signature_type        text CHECK (signature_type IN ('image/png','image/jpeg')),
  signature_sha256      text,
  stamp_key             text UNIQUE,
  stamp_type            text CHECK (stamp_type IN ('image/png','image/jpeg')),
  stamp_sha256          text,
  version               integer NOT NULL DEFAULT 1,
  updated_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE company_profile ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON company_profile
  USING (app_platform_bypass() OR tenant_id = app_current_tenant())
  WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant());

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    GRANT SELECT, INSERT, UPDATE ON company_profile TO hrms_app;
    REVOKE DELETE ON company_profile FROM hrms_app;
  END IF;
END $$;
