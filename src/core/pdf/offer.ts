import type { PdfWriter } from './writer.js';

export interface OfferTerms {
  name: string;
  designation: string;
  department: string | null;
  location: string | null;
  employmentType: string | null;
  annualCtc: number | string;
  joiningDate: string;
  probationMonths: number | null;
  contractEndDate: string | null;
}

const EMPLOYMENT: Readonly<Record<string, string>> = {
  permanent: 'permanent',
  probation: 'probationary',
  contract: 'contract',
  trainee: 'trainee',
  intern: 'internship',
  consultant: 'consultancy',
};

export const OFFER_ACCEPTANCE = 'I accept this offer on the terms stated above.';

const position = (t: OfferTerms, legalName: string) =>
  `the position of ${t.designation}${t.department ? ` in the ${t.department} department` : ''} with ${legalName}${t.location ? `, at our ${t.location} location` : ''}`;
const months = (n: number) => `${n} ${n === 1 ? 'month' : 'months'}`;

/** An offer still to be taken up. */
export function offerParagraphs(w: PdfWriter, t: OfferTerms, legalName: string): string[] {
  const kind = t.employmentType && EMPLOYMENT[t.employmentType];
  return [
    `Dear ${t.name},`,
    `We are pleased to offer you ${position(t, legalName)}.`,
    `Your date of joining will be ${w.date(t.joiningDate)}.${kind ? ` The nature of your employment will be ${kind}.` : ''}`,
    ...(t.probationMonths ? [`You will be on probation for ${months(t.probationMonths)} from your date of joining.`] : []),
    ...(t.contractEndDate ? [`Your contract will run until ${w.date(t.contractEndDate)}.`] : []),
    `Your annual cost to company will be ${w.money(t.annualCtc)}, subject to deductions required by law.`,
    'This offer is subject to verification of your documents. The full terms will be set out in your letter of appointment and the policies of the organization.',
    'Please sign and return a copy of this letter to accept the offer.',
  ];
}

/** The terms of an offer already taken up. Dated the day it is written, and says so: it never passes for the original. */
export function offerRecordParagraphs(w: PdfWriter, t: OfferTerms, legalName: string, offeredOn: string, issuedOn: string): string[] {
  const kind = t.employmentType && EMPLOYMENT[t.employmentType];
  return [
    `Dear ${t.name},`,
    `This letter is issued on ${w.date(issuedOn)} and records the offer of employment made to you on ${w.date(offeredOn)}.`,
    `You were offered ${position(t, legalName)}.`,
    `The date of joining offered was ${w.date(t.joiningDate)}.${kind ? ` The nature of employment offered was ${kind}.` : ''}`,
    ...(t.probationMonths ? [`The offer provided for a probation of ${months(t.probationMonths)} from the date of joining.`] : []),
    ...(t.contractEndDate ? [`The contract offered ran until ${w.date(t.contractEndDate)}.`] : []),
    `The annual cost to company offered was ${w.money(t.annualCtc)}, subject to deductions required by law.`,
    'Your employment is governed by your letter of appointment, later changes communicated to you, and the policies of the organization.',
  ];
}
