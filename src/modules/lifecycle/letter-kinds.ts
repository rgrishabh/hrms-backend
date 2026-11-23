import { offerParagraphs, offerRecordParagraphs, OFFER_ACCEPTANCE, type OfferTerms } from '../../core/pdf/offer.js';
import type { PdfWriter } from '../../core/pdf/writer.js';

/** What the record says about a person, for a letter. Reasons for leaving and the like (L3) are not in it, so no letter can print them. */
export interface LetterFacts {
  id: string;
  name: string;
  employee_code: string;
  designation: string | null;
  employment_type: string;
  status: string;
  date_of_joining: string;
  probation_end_date: string | null;
  confirmation_date: string | null;
  contract_end_date: string | null;
  exit_date: string | null;
  department: string | null;
  branch: string;
  legal_entity: string;
  probation_extended: boolean;
  salary_records: number;
  /** Hired from an accepted offer in recruitment. */
  hired_from_offer: boolean;
  separation: { status: string; kind: string; lwd: string; settled: boolean } | null;
  today: string;
}
/** What an authorised reader may print about pay. Absent from every other letter. */
export interface LetterPay {
  /** Recorded with the salary only if payroll entered it. */
  ctc: number | null;
  /** What the salary components come to for a full month, by payroll's own calculation. */
  monthlyGross: number;
  effectiveFrom: string;
}
export interface LetterField {
  key: string;
  label: string;
  type: 'text' | 'long' | 'date' | 'money';
  required: boolean;
  /** What the form starts with, from the record. Never a salary. */
  value: string;
}
/** The offer someone was hired from, as it was sent. */
export interface HiredOffer extends OfferTerms {
  offeredOn: string;
}
export type LetterGroup = 'employment' | 'pay' | 'conduct' | 'exit' | 'other';
export interface LetterKind {
  key: string;
  label: string;
  group: LetterGroup;
  /** Off with this feature. Without one, the letter is there whenever the module is. */
  feature?: 'core.onboarding' | 'core.offboarding';
  /** Only for someone who passes the L4 rule for this person. `record` prints the annual CTC, or the month's gross without one; `offer` the offered CTC. */
  pay?: 'record' | 'offer';
  fields: readonly LetterField[] | ((f: LetterFacts) => readonly LetterField[]);
  /** What is wrong with what was typed, beyond each field by itself. */
  check?: (f: LetterFacts, fields: Readonly<Record<string, string>>) => string | null;
  /** Why it cannot be written for this person now, from the record. A letter says nothing the record does not support. */
  unavailable?: (f: LetterFacts) => string | null;
  heading: string | ((fields: Readonly<Record<string, string>>) => string);
  paragraphs: (
    w: PdfWriter,
    f: LetterFacts,
    x: { legalName: string; fields: Readonly<Record<string, string>>; pay: LetterPay | null; offer: HiredOffer | null },
  ) => readonly string[];
  /** A line to sign under the letter. */
  acceptance?: (f: LetterFacts, fields: Readonly<Record<string, string>>) => string | undefined;
}

export const FIELD_MAX: Readonly<Record<LetterField['type'], number>> = { text: 200, long: 4000, date: 10, money: 16 };
const field = (key: string, label: string, type: LetterField['type'], required = true, value = ''): LetterField => ({ key, label, type, required, value });
export const fieldsOf = (k: LetterKind, f: LetterFacts) => (typeof k.fields === 'function' ? k.fields(f) : k.fields);
export const roleOf = (s: Pick<LetterFacts, 'designation' | 'department'>) => [s.designation, s.department && `in the ${s.department} department`].filter(Boolean).join(' ');
const as = (f: LetterFacts) => (roleOf(f) ? ` as ${roleOf(f)}` : '');
const employed = (f: LetterFacts) => (['active', 'on_notice'].includes(f.status) ? null : 'This letter is for someone currently employed');
const started = (f: LetterFacts) => (f.status === 'pre_joining' ? 'This person has not joined yet' : null);
const separated = (f: LetterFacts) => (f.separation ? null : 'This letter needs an approved separation');
const internshipEnd = (f: LetterFacts) => f.separation?.lwd ?? f.exit_date ?? f.contract_end_date;
/** The figure a letter gives: the annual CTC when there is one, otherwise the month's gross. */
export const payFigure = (w: PdfWriter, p: LetterPay) =>
  p.ctc !== null ? { what: 'annual cost to company', amount: w.money(p.ctc) } : { what: 'gross monthly salary', amount: w.money(p.monthlyGross) };
/** Letters carry the day they are written, so only an offer made that day, to someone yet to join, is written as an offer. Any other is the record of one. */
const madeToday = (f: LetterFacts, fields: Readonly<Record<string, string>>) => f.status === 'pre_joining' && !f.hired_from_offer && fields['offeredOn'] === f.today;
const about = (f: LetterFacts) => `${f.name} (employee code ${f.employee_code})`;

/** The letters written through `POST /lifecycle/employees/:id/letters/:kind`. Appointment, experience and relieving letters have their own routes. */
export const LETTER_KINDS: readonly LetterKind[] = [
  {
    key: 'offer',
    label: 'Offer letter',
    group: 'employment',
    pay: 'offer',
    // Someone hired through recruitment has the offer on record. For anyone else the record says what they are now, not what they were offered.
    fields: (f) =>
      f.hired_from_offer
        ? []
        : [
            field('offeredOn', 'Date of the offer', 'date', true, f.status === 'pre_joining' ? f.today : ''),
            field('designation', 'Position offered', 'text', true, f.designation ?? ''),
            field('location', 'Location offered', 'text', false, f.branch),
            field('joiningDate', 'Date of joining offered', 'date', true, f.date_of_joining),
            field('annualCtc', 'Annual salary offered (cost to company)', 'money'),
          ],
    check: (f, x) => {
      if (f.hired_from_offer) return null;
      if (x['offeredOn']! > f.today) return 'The date of the offer cannot be in the future';
      return x['offeredOn']! > x['joiningDate']! ? 'The date of the offer cannot be after the date of joining' : null;
    },
    heading: 'Letter of offer',
    paragraphs: (w, f, x) => {
      const t: HiredOffer = x.offer ?? {
        name: f.name,
        designation: x.fields['designation']!,
        department: null,
        location: x.fields['location'] ?? null,
        employmentType: null,
        annualCtc: x.fields['annualCtc']!,
        joiningDate: x.fields['joiningDate']!,
        probationMonths: null,
        contractEndDate: null,
        offeredOn: x.fields['offeredOn']!,
      };
      return madeToday(f, x.fields) ? offerParagraphs(w, t, x.legalName) : offerRecordParagraphs(w, t, x.legalName, t.offeredOn, f.today);
    },
    acceptance: (f, fields) => (madeToday(f, fields) ? OFFER_ACCEPTANCE : undefined),
  },
  {
    key: 'confirmation',
    label: 'Confirmation letter',
    group: 'employment',
    feature: 'core.onboarding',
    fields: [],
    unavailable: (f) => started(f) ?? (f.confirmation_date ? null : 'This person has not been confirmed yet'),
    heading: 'Confirmation of employment',
    paragraphs: (w, f, x) => [
      `We are pleased to inform you that your employment with ${x.legalName}${as(f)} is confirmed with effect from ${w.date(f.confirmation_date)}.`,
      'The other terms of your employment remain unchanged.',
      'We wish you every success.',
    ],
  },
  {
    key: 'probation-extension',
    label: 'Probation extension letter',
    group: 'employment',
    feature: 'core.onboarding',
    fields: [field('note', 'What to improve (printed on the letter)', 'long', false)],
    unavailable: (f) => employed(f) ?? (f.probation_extended && !f.confirmation_date && f.probation_end_date ? null : 'No approved extension of probation is on record'),
    heading: 'Extension of probation',
    paragraphs: (w, f, x) => [
      `This is to inform you that your probation${as(f)} with ${x.legalName} has been extended until ${w.date(f.probation_end_date)}.`,
      ...(x.fields['note'] ? [x.fields['note']] : []),
      'Your performance will be reviewed again before that date. The other terms of your employment remain unchanged.',
    ],
  },
  {
    key: 'promotion',
    label: 'Promotion letter',
    group: 'employment',
    fields: [field('effectiveDate', 'Effective date', 'date'), field('previousDesignation', 'Previous designation', 'text', false)],
    unavailable: (f) => employed(f) ?? (f.designation ? null : 'Set the new designation on the record first'),
    heading: 'Promotion',
    paragraphs: (w, f, x) => [
      `We are pleased to inform you that you have been promoted${x.fields['previousDesignation'] ? ` from ${x.fields['previousDesignation']}` : ''} to the position of ${roleOf(f)} with effect from ${w.date(x.fields['effectiveDate'])}.`,
      'The other terms of your employment remain unchanged unless communicated separately.',
      'We congratulate you and wish you continued success.',
    ],
  },
  {
    key: 'transfer',
    label: 'Transfer letter',
    group: 'employment',
    fields: [field('effectiveDate', 'Effective date', 'date'), field('previousLocation', 'Previous location or department', 'text', false)],
    unavailable: employed,
    heading: 'Transfer',
    paragraphs: (w, f, x) => [
      `This is to inform you that you are transferred${x.fields['previousLocation'] ? ` from ${x.fields['previousLocation']}` : ''} to our ${f.branch} location${f.department ? `, ${f.department} department,` : ''} with effect from ${w.date(x.fields['effectiveDate'])}.`,
      'The other terms of your employment remain unchanged unless communicated separately.',
    ],
  },
  {
    key: 'employment-certificate',
    label: 'Employment certificate',
    group: 'employment',
    fields: [field('purpose', 'Purpose (for example, a bank or a visa)', 'text', false)],
    unavailable: employed,
    heading: 'To whom it may concern',
    paragraphs: (w, f, x) => [
      `This is to certify that ${about(f)} has been employed with ${x.legalName} since ${w.date(f.date_of_joining)}${roleOf(f) ? ` and currently works as ${roleOf(f)}` : ''}, at our ${f.branch} location.`,
      `This certificate is issued on request${x.fields['purpose'] ? ` for the purpose of: ${x.fields['purpose']}` : ''} and states the facts of employment as recorded by the organization.`,
    ],
  },
  {
    key: 'noc',
    label: 'No objection certificate',
    group: 'employment',
    fields: [field('purpose', 'What the organization does not object to', 'long')],
    unavailable: employed,
    heading: 'No objection certificate',
    paragraphs: (w, f, x) => [
      `This is to certify that ${about(f)} has been employed with ${x.legalName} since ${w.date(f.date_of_joining)}${roleOf(f) ? `, currently${as(f)}` : ''}.`,
      `The organization has no objection to the following: ${x.fields['purpose']}`,
      'This certificate is issued on request and is limited to the purpose stated above.',
    ],
  },
  {
    key: 'salary-revision',
    label: 'Salary revision letter',
    group: 'pay',
    pay: 'record',
    fields: [],
    unavailable: (f) => employed(f) ?? (f.salary_records > 1 ? null : 'No revision of salary is on record'),
    heading: 'Revision of salary',
    paragraphs: (w, f, x) => {
      const p = payFigure(w, x.pay!);
      return [
        `We are pleased to inform you that your ${p.what}${roleOf(f) ? `, ${roleOf(f)},` : ''} has been revised to ${p.amount} with effect from ${w.date(x.pay!.effectiveFrom)}.`,
        'The other terms of your employment remain unchanged. Please treat this letter as confidential.',
      ];
    },
  },
  {
    key: 'salary-certificate',
    label: 'Salary certificate',
    group: 'pay',
    pay: 'record',
    fields: [field('purpose', 'Purpose (for example, a loan or a visa)', 'text', false)],
    unavailable: (f) => employed(f) ?? (f.salary_records > 0 ? null : 'No approved salary is on record'),
    heading: 'Salary certificate',
    paragraphs: (w, f, x) => [
      `This is to certify that ${about(f)} has been employed with ${x.legalName} since ${w.date(f.date_of_joining)}${roleOf(f) ? `, currently${as(f)}` : ''}.`,
      `The ${payFigure(w, x.pay!).what} on record is ${payFigure(w, x.pay!).amount}, effective from ${w.date(x.pay!.effectiveFrom)}.`,
      `This certificate is issued on request${x.fields['purpose'] ? ` for the purpose of: ${x.fields['purpose']}` : ''}.`,
    ],
  },
  {
    key: 'appreciation',
    label: 'Appreciation letter',
    group: 'conduct',
    fields: [field('body', 'What is appreciated', 'long')],
    unavailable: employed,
    heading: 'Letter of appreciation',
    paragraphs: (_w, f, x) => [`Dear ${f.name},`, x.fields['body']!, `On behalf of ${x.legalName}, thank you for your contribution.`],
  },
  {
    key: 'show-cause',
    label: 'Show cause notice',
    group: 'conduct',
    fields: [field('subject', 'Subject', 'text'), field('body', 'What happened', 'long'), field('respondBy', 'Reply due by', 'date')],
    unavailable: employed,
    heading: 'Show cause notice',
    paragraphs: (w, _f, x) => [
      `Subject: ${x.fields['subject']}`,
      x.fields['body']!,
      `Please explain in writing, by ${w.date(x.fields['respondBy'])}, why action should not be taken. If no reply is received by then, the matter may be decided on the information available.`,
    ],
  },
  {
    key: 'warning',
    label: 'Warning letter',
    group: 'conduct',
    fields: [field('subject', 'Subject', 'text'), field('body', 'What happened and what is expected', 'long')],
    unavailable: employed,
    heading: 'Warning letter',
    paragraphs: (_w, _f, x) => [
      `Subject: ${x.fields['subject']}`,
      x.fields['body']!,
      'Please treat this as a formal warning. Further occurrences may lead to disciplinary action under the policies of the organization.',
    ],
  },
  {
    key: 'resignation-acceptance',
    label: 'Resignation acceptance letter',
    group: 'exit',
    feature: 'core.offboarding',
    fields: [],
    unavailable: (f) => separated(f) ?? (f.separation!.kind === 'resignation' ? null : 'This separation is not a resignation'),
    heading: 'Acceptance of resignation',
    paragraphs: (w, f, x) => [
      `This is to confirm that ${x.legalName} has accepted your resignation${roleOf(f) ? ` from the position of ${roleOf(f)}` : ''}. Your last working day is ${w.date(f.separation!.lwd)}.`,
      'Please complete the handover and exit clearance by that date.',
    ],
  },
  {
    key: 'termination',
    label: 'Termination letter',
    group: 'exit',
    feature: 'core.offboarding',
    fields: [field('body', 'Grounds (printed on the letter)', 'long', false)],
    unavailable: (f) => separated(f) ?? (f.separation!.kind === 'termination' ? null : 'This separation is not a termination'),
    heading: 'Termination of employment',
    paragraphs: (w, f, x) => [
      `This is to inform you that your employment with ${x.legalName}${as(f)} ends with effect from the close of business on ${w.date(f.separation!.lwd)}.`,
      ...(x.fields['body'] ? [x.fields['body']] : []),
      'Please return all property of the organization and complete the exit clearance. Dues will be settled as per the policies of the organization and the law.',
    ],
  },
  {
    key: 'settlement',
    label: 'Full and final settlement letter',
    group: 'exit',
    feature: 'core.offboarding',
    fields: [],
    unavailable: (f) => separated(f) ?? (f.separation!.settled ? null : 'The full and final settlement is not marked as settled'),
    heading: 'Full and final settlement',
    paragraphs: (w, f, x) => [
      `This is to confirm that the full and final settlement of ${about(f)}, whose last working day with ${x.legalName} was ${w.date(f.separation!.lwd)}, has been completed according to the records of the organization.`,
    ],
  },
  {
    key: 'internship-certificate',
    label: 'Internship certificate',
    group: 'exit',
    fields: [field('body', 'Work done (printed on the certificate)', 'long', false)],
    unavailable: (f) => {
      if (!['intern', 'trainee'].includes(f.employment_type)) return 'This person is not an intern or a trainee';
      const end = internshipEnd(f);
      return end && end <= f.today ? null : 'The internship has not ended yet';
    },
    heading: 'Internship certificate',
    paragraphs: (w, f, x) => [
      `This is to certify that ${about(f)} completed an internship with ${x.legalName}${as(f)} from ${w.date(f.date_of_joining)} to ${w.date(internshipEnd(f))}.`,
      ...(x.fields['body'] ? [x.fields['body']] : []),
    ],
  },
  {
    key: 'recommendation',
    label: 'Recommendation letter',
    group: 'exit',
    fields: [field('body', 'Recommendation, in your own words', 'long')],
    unavailable: started,
    heading: 'Letter of recommendation',
    paragraphs: (w, f, x) => {
      const end = f.separation && f.separation.lwd <= f.today ? f.separation.lwd : null;
      return [
        `To whom it may concern,`,
        end
          ? `${f.name} worked with ${x.legalName}${as(f)} from ${w.date(f.date_of_joining)} to ${w.date(end)}.`
          : `${f.name} has worked with ${x.legalName}${as(f)} since ${w.date(f.date_of_joining)}.`,
        x.fields['body']!,
      ];
    },
  },
  {
    key: 'general',
    label: 'Other letter',
    group: 'other',
    fields: [field('heading', 'Heading', 'text'), field('body', 'Text of the letter', 'long')],
    heading: (fields) => fields['heading']!,
    paragraphs: (_w, _f, x) => [x.fields['body']!],
  },
];
export const LETTER_KIND_KEYS = LETTER_KINDS.map((k) => k.key) as [string, ...string[]];
