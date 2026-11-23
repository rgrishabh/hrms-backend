import type { Db } from '../../db/tx.js';
import { dataCipher } from '../crypto/index.js';
import { allOff } from '../features/state.js';

/** What documents print about the employer: Layer 3, Settings, Company. */
export interface CompanyProfile {
  legalName: string | null;
  gstin: string | null;
  pan: string | null;
  tan: string | null;
  cin: string | null;
  registeredAddress: string | null;
  pfRegistration: string | null;
  esiRegistration: string | null;
  ptRegistration: string | null;
  signatoryName: string | null;
  signatoryDesignation: string | null;
  /** Storage keys of the uploaded images. Null until uploaded. */
  signatureKey: string | null;
  stampKey: string | null;
}

export interface CompanyRow {
  legal_name: string | null;
  gstin: string | null;
  pan_enc: string | null;
  pan_last4: string | null;
  tan: string | null;
  cin: string | null;
  registered_address: string | null;
  pf_registration: string | null;
  esi_registration: string | null;
  pt_registration: string | null;
  bank_account_holder: string | null;
  bank_name: string | null;
  bank_ifsc: string | null;
  bank_account_enc: string | null;
  bank_account_last4: string | null;
  signatory_name: string | null;
  signatory_designation: string | null;
  signature_key: string | null;
  signature_type: string | null;
  signature_sha256: string | null;
  stamp_key: string | null;
  stamp_type: string | null;
  stamp_sha256: string | null;
  version: number;
  updated_at: Date | null;
}

export async function companyRow(db: Db, tenantId: string, lock = false): Promise<CompanyRow | undefined> {
  return (await db.query<CompanyRow>(`SELECT * FROM company_profile WHERE tenant_id=$1${lock ? ' FOR UPDATE' : ''}`, [tenantId])).rows[0];
}

/** The organization's first active legal entity: what name, GSTIN and CIN fall back to until the company settings say otherwise. */
export async function legalEntityFallback(db: Db, tenantId: string) {
  return (
    await db.query<{ name: string; cin: string | null; gstin: string | null }>(
      `SELECT name, cin, gstin FROM legal_entities WHERE tenant_id=$1 AND status='active' ORDER BY created_at LIMIT 1`,
      [tenantId],
    )
  ).rows[0];
}

/**
 * The employer as documents print it. Holds the whole PAN: for the server's own documents, never for an API answer (modules/tenant/company.ts masks).
 * The registration numbers belong to payroll: with it off they are kept, and not printed.
 */
export async function loadCompanyProfile(db: Db, tenantId: string): Promise<CompanyProfile> {
  const c = await companyRow(db, tenantId);
  const le = await legalEntityFallback(db, tenantId);
  const payrollOff = allOff('payroll');
  return {
    legalName: c?.legal_name ?? le?.name ?? null,
    gstin: c?.gstin ?? le?.gstin ?? null,
    pan: c?.pan_enc ? dataCipher().decrypt(c.pan_enc) : null,
    tan: c?.tan ?? null,
    cin: c?.cin ?? le?.cin ?? null,
    registeredAddress: c?.registered_address ?? null,
    pfRegistration: payrollOff ? null : (c?.pf_registration ?? null),
    esiRegistration: payrollOff ? null : (c?.esi_registration ?? null),
    ptRegistration: payrollOff ? null : (c?.pt_registration ?? null),
    signatoryName: c?.signatory_name ?? null,
    signatoryDesignation: c?.signatory_designation ?? null,
    signatureKey: c?.signature_key ?? null,
    stampKey: c?.stamp_key ?? null,
  };
}
