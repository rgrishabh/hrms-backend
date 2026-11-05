import { z } from 'zod';

/**
 * Formats of Indian registration numbers: what a value must look like, not whether the authority issued it. Checks only what is printed in the format: nothing here
 * calls a government service, so a well-formed number can still be wrong.
 */
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
/** L or U, five digits of industry, state, year, three letters of ownership, six digits: 21 characters. */
export const CIN_RE = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const BANK_ACCOUNT_RE = /^[0-9]{9,18}$/;
/** The employer's ESIC code is 17 digits. */
export const ESI_RE = /^[0-9]{17}$/;
/** PF and PT numbers are written differently by region and state, so only the characters are checked. */
export const REGISTRATION_RE = /^[A-Z0-9][A-Z0-9/-]{2,39}$/;

const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The GSTIN check character: base-36 digits weighted 1, 2 alternately, each product's two base-36 digits added, then the complement modulo 36. */
export function gstinCheckDigit(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = BASE36.indexOf(first14[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return BASE36[(36 - (sum % 36)) % 36]!;
}

export const isValidGstin = (v: string) => GSTIN_RE.test(v) && gstinCheckDigit(v.slice(0, 14)) === v[14];

const upper = () => z.string().trim().toUpperCase();
export const Gstin = upper().refine(isValidGstin, 'Not a valid GSTIN: check the 15 characters and the last one, the check digit');
export const Pan = upper().regex(PAN_RE, 'A PAN is five letters, four digits and a letter');
export const Tan = upper().regex(TAN_RE, 'A TAN is four letters, five digits and a letter');
export const Cin = upper().regex(CIN_RE, 'A CIN is 21 characters: L or U, five digits, a state code, a year, three letters and six digits');
export const Ifsc = upper().regex(IFSC_RE, 'An IFSC is four letters, a zero and six letters or digits');
export const BankAccount = z.string().trim().regex(BANK_ACCOUNT_RE, 'A bank account number is 9 to 18 digits');
export const EsiCode = z.string().trim().regex(ESI_RE, 'An ESI employer code is 17 digits');
export const Registration = upper().regex(REGISTRATION_RE, 'Use letters, digits, / or -');
