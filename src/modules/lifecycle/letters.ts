import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { only } from '../../core/features/routes.js';
import { audit } from '../../core/audit/audit.js';
import { openJson } from '../../core/crypto/index.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { IsoDate, Uuid } from '../../core/http/pagination.js';
import * as R from '../../core/http/responses.js';
import { readDevice, requireFeature, tenantActor, tenantActorAny, type TenantActor } from '../../core/http/context.js';
import { letterPdf } from '../../core/pdf/letter.js';
import { loadPdfContext, loadPdfIdentity, pdfHeaders, type PdfContext, type PdfWriter } from '../../core/pdf/writer.js';
import { auditL4, l3RowFilter, policyViewer, readContext, subjectVisible } from '../../core/policy/salary.js';
import type { Db } from '../../db/tx.js';
import { orgToday } from '../competency/service.js';
import { FIELD_MAX, LETTER_KIND_KEYS, LETTER_KINDS, roleOf, type LetterFacts, type LetterKind, type LetterPay } from './letter-kinds.js';
import { featureOn } from './service.js';

const ON = 'core.onboarding';
const OFF = 'core.offboarding';
const IdParams = z.object({ id: Uuid });
/** `?includePay=1` asks for the annual CTC on an appointment letter. It prints only if this reader may see it, and then it is an L4 export. */
const AppointmentQuery = z.object({ includePay: z.literal('1').optional() });

const KindParams = z.object({ id: Uuid, kind: z.enum(LETTER_KIND_KEYS) });
const LetterBody = z.strictObject({ fields: z.record(z.string().max(40), z.string().max(FIELD_MAX.long)).default({}) });

type Subject = LetterFacts;
async function subjectOf(db: Db, tenantId: string, id: string): Promise<Subject | undefined> {
  const today = await orgToday(db, tenantId);
  const row = (
    await db.query<Omit<Subject, 'separation' | 'today'> & { sep_status: string | null; sep_kind: string; sep_lwd: string; sep_settled: boolean }>(
      `SELECT e.id, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, e.employee_code, e.designation, e.employment_type, e.status,
    e.date_of_joining::text, e.probation_end_date::text, e.confirmation_date::text, e.contract_end_date::text, e.exit_date::text,
    d.name AS department, b.name AS branch, le.name AS legal_entity,
    EXISTS (SELECT 1 FROM probation_reviews p WHERE p.tenant_id=e.tenant_id AND p.employee_id=e.id AND p.status='approved' AND p.recommendation='extend') AS probation_extended,
    (SELECT count(*)::int FROM employee_salaries s WHERE s.tenant_id=e.tenant_id AND s.employee_id=e.id AND s.status IN ('active','superseded')) AS salary_records,
    sep.status AS sep_status, sep.kind AS sep_kind, sep.lwd AS sep_lwd, sep.settled AS sep_settled
  FROM employees e JOIN branches b ON b.tenant_id=e.tenant_id AND b.id=e.branch_id JOIN legal_entities le ON le.tenant_id=e.tenant_id AND le.id=e.legal_entity_id
  LEFT JOIN departments d ON d.tenant_id=e.tenant_id AND d.id=e.department_id
  LEFT JOIN LATERAL (SELECT x.status, x.kind, coalesce(x.approved_lwd, x.requested_lwd)::text AS lwd, x.fnf_status='settled' AS settled FROM separations x
    WHERE x.tenant_id=e.tenant_id AND x.employee_id=e.id AND x.status IN ('approved','completed') ORDER BY x.created_at DESC LIMIT 1) sep ON true
  WHERE e.tenant_id=$1 AND e.id=$2`,
      [tenantId, id],
    )
  ).rows[0];
  if (!row) return undefined;
  const { sep_status, sep_kind, sep_lwd, sep_settled, ...rest } = row;
  return { ...rest, today, separation: sep_status ? { status: sep_status, kind: sep_kind, lwd: sep_lwd, settled: sep_settled } : null };
}

/** Whether this reader stands above this person as HR. Nobody issues their own letter this way. */
async function hrAbove(db: Db, a: TenantActor, id: string) {
  if (a.user.employeeId === id || !a.has('employees.manage')) return false;
  return subjectVisible(db, a.tenantId, await policyViewer(db, a.tenantId, a.user), id, l3RowFilter);
}

const letter = (ctx: PdfContext, o: { title: string; today: string; subject: Subject; heading: string; paragraphs: (w: PdfWriter) => readonly string[] }) =>
  letterPdf(ctx, { ...o, to: [o.subject.name, `Employee code: ${o.subject.employee_code}`] });

const EMPLOYMENT: Record<string, string> = {
  permanent: 'permanent',
  probation: 'probationary',
  contract: 'contract',
  trainee: 'trainee',
  intern: 'internship',
  consultant: 'consultancy',
};

const NO_PAY = "Only someone who may see this person's salary can produce this letter";

/** What was typed, trimmed and checked against what the letter asks for. */
function checkFields(kind: LetterKind, given: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(given)) if (!kind.fields.some((f) => f.key === k)) throw badRequest(`This letter has no field "${k}"`);
  for (const f of kind.fields) {
    const v = (given[f.key] ?? '').trim();
    if (!v && f.required) throw badRequest(`${f.label} is required`);
    if (v.length > FIELD_MAX[f.type]) throw badRequest(`${f.label} is too long (at most ${FIELD_MAX[f.type]} characters)`);
    if (v && f.type === 'date' && !IsoDate.safeParse(v).success) throw badRequest(`${f.label} is not a date`);
    if (v) out[f.key] = v;
  }
  return out;
}

/** Letters HR gives to a person. The text is plain and factual: terms belong to the organization's own contract, and reasons for leaving (L3) are never printed. */
export function letterRoutes(app: FastifyInstance) {
  app.get(
    '/employees/:id/letters',
    { schema: { response: { 200: R.GetLifecycleEmployeesByIdLetters200 }, params: IdParams }, config: { perm: ['employees.manage'] } },
    async (req) => {
      const a = tenantActor(req, 'employees.manage');
      const { id } = IdParams.parse(req.params);
      return a.tx(async (db) => {
        if (!(await hrAbove(db, a, id))) throw notFound('Employee not found');
        const s = (await subjectOf(db, a.tenantId, id))!;
        const on = { [ON]: await featureOn(db, a.tenantId, ON), [OFF]: await featureOn(db, a.tenantId, OFF) };
        const pay = await mayPrintPay(db, a, id);
        const items = LETTER_KINDS.filter((k) => !k.feature || on[k.feature]).map((k) => ({
          key: k.key,
          label: k.label,
          group: k.group,
          fields: k.fields.map((x) => ({ ...x, maxLength: FIELD_MAX[x.type] })),
          unavailable: k.pay && !pay ? NO_PAY : (k.unavailable?.(s) ?? null),
        }));
        const due = (['experience', 'relieving'] as const).map((k) => [k, on[OFF] ? exitUnavailable(s, k) : 'Offboarding is switched off'] as const);
        return { items, exit: Object.fromEntries(due) as Record<'experience' | 'relieving', string | null> };
      });
    },
  );

  // A POST, though it changes nothing but the audit log: what is written on a letter must not be in an address, which proxies log.
  app.post(
    '/employees/:id/letters/:kind',
    { schema: { response: { 200: R.file('application/pdf') }, params: KindParams, body: LetterBody }, config: { perm: ['employees.manage'] } },
    async (req, reply) => {
      const a = tenantActor(req, 'employees.manage');
      const p = KindParams.parse(req.params);
      const kind = LETTER_KINDS.find((k) => k.key === p.kind)!;
      const fields = checkFields(kind, LetterBody.parse(req.body ?? {}).fields);
      const r = await a.tx(async (db) => {
        if (kind.feature) await requireFeature(db, a.tenantId, kind.feature);
        if (!(await hrAbove(db, a, p.id))) throw notFound('Employee not found');
        const subject = (await subjectOf(db, a.tenantId, p.id))!;
        if (kind.pay && !(await mayPrintPay(db, a, p.id))) throw forbidden(NO_PAY);
        const why = kind.unavailable?.(subject);
        if (why) throw conflict(why);
        const pay = kind.pay ? await payOf(db, a, p.id, kind.key === 'salary-certificate' ? subject.today : null) : null;
        if (kind.pay && !pay) throw conflict('No approved salary is on record');
        await issued(db, req, a, p.id, kind.key, !!pay);
        return { subject, pay, identity: await loadPdfIdentity(db, a.tenantId) };
      });
      const ctx = await loadPdfContext(app, r.identity);
      const doc = letter(ctx, {
        title: kind.label,
        today: r.subject.today,
        subject: r.subject,
        heading: typeof kind.heading === 'string' ? kind.heading : kind.heading(fields),
        paragraphs: (w) => kind.paragraphs(w, r.subject, { legalName: ctx.legalName, fields, pay: r.pay }),
      });
      return pdfHeaders(reply, `${kind.key}-letter.pdf`).send(doc);
    },
  );

  only(app, 'core.onboarding').get(
    '/employees/:id/letters/appointment.pdf',
    { schema: { params: IdParams, querystring: AppointmentQuery }, config: { perm: ['employees.manage'], feature: [ON] } },
    async (req, reply) => {
      const a = tenantActor(req, 'employees.manage');
      const { id } = IdParams.parse(req.params);
      const q = AppointmentQuery.parse(req.query);
      const r = await a.tx(async (db) => {
        await requireFeature(db, a.tenantId, ON);
        if (!(await hrAbove(db, a, id))) throw notFound('Employee not found');
        const subject = (await subjectOf(db, a.tenantId, id))!;
        const ctc = q.includePay ? ((await payOf(db, a, id))?.ctc ?? null) : null;
        await issued(db, req, a, id, 'appointment', ctc !== null);
        return { subject, ctc, today: subject.today, identity: await loadPdfIdentity(db, a.tenantId) };
      });
      const ctx = await loadPdfContext(app, r.identity);
      const s = r.subject;
      const kind = EMPLOYMENT[s.employment_type];
      const doc = letter(ctx, {
        title: 'Appointment letter',
        today: r.today,
        subject: s,
        heading: 'Letter of appointment',
        paragraphs: (w) => [
          `We are pleased to confirm your appointment with ${ctx.legalName}${roleOf(s) ? ` as ${roleOf(s)}` : ''}, at our ${s.branch} location, with effect from ${w.date(s.date_of_joining)}.`,
          ...(kind ? [`The nature of your employment is ${kind}.`] : []),
          ...(s.probation_end_date ? [`Your probation runs until ${w.date(s.probation_end_date)}.`] : []),
          ...(r.ctc !== null ? [`Your annual cost to company is ${w.money(r.ctc)}.`] : []),
          'Your employment is subject to the terms of your contract and the policies of the organization as they apply from time to time.',
        ],
      });
      return pdfHeaders(reply, 'appointment-letter.pdf')
        .header('x-pay-included', r.ctc !== null ? '1' : '0')
        .send(doc);
    },
  );

  only(app, 'core.offboarding').get(
    '/employees/:id/letters/experience.pdf',
    { schema: { params: IdParams }, config: { permAny: ['employees.manage', 'lifecycle.self'], feature: [OFF] } },
    async (req, reply) => {
      const a = tenantActorAny(req, 'employees.manage', 'lifecycle.self');
      const { id } = IdParams.parse(req.params);
      const r = await exitLetterData(req, a, id, 'experience');
      const ctx = await loadPdfContext(app, r.identity);
      const s = r.subject;
      const doc = letter(ctx, {
        title: 'Experience letter',
        today: r.today,
        subject: s,
        heading: 'To whom it may concern',
        paragraphs: (w) => [
          `This is to certify that ${s.name} (employee code ${s.employee_code}) was employed with ${ctx.legalName} from ${w.date(s.date_of_joining)} to ${w.date(r.lwd)}.`,
          ...(roleOf(s) ? [`At the time of leaving, the position held was ${roleOf(s)}.`] : []),
          'This letter is issued on request and states the facts of employment as recorded by the organization.',
        ],
      });
      return pdfHeaders(reply, 'experience-letter.pdf').send(doc);
    },
  );

  only(app, 'core.offboarding').get(
    '/employees/:id/letters/relieving.pdf',
    { schema: { params: IdParams }, config: { permAny: ['employees.manage', 'lifecycle.self'], feature: [OFF] } },
    async (req, reply) => {
      const a = tenantActorAny(req, 'employees.manage', 'lifecycle.self');
      const { id } = IdParams.parse(req.params);
      const r = await exitLetterData(req, a, id, 'relieving');
      const ctx = await loadPdfContext(app, r.identity);
      const s = r.subject;
      const doc = letter(ctx, {
        title: 'Relieving letter',
        today: r.today,
        subject: s,
        heading: 'Relieving letter',
        paragraphs: (w) => [
          `This is to confirm that ${s.name} (employee code ${s.employee_code})${roleOf(s) ? `, ${roleOf(s)},` : ''} has been relieved from the services of ${ctx.legalName} with effect from the close of business on ${w.date(r.lwd)}.`,
          'Exit clearance has been completed.',
        ],
      });
      return pdfHeaders(reply, 'relieving-letter.pdf').send(doc);
    },
  );
}

/** Salary on a letter: payroll's readers, strictly above this person, and only while payroll is in use. */
async function mayPrintPay(db: Db, a: TenantActor, id: string): Promise<boolean> {
  if (!a.has('payroll.read') && !a.has('payroll.manage')) return false;
  if (!(await featureOn(db, a.tenantId, 'payroll'))) return false;
  return subjectVisible(db, a.tenantId, await policyViewer(db, a.tenantId, a.user), id);
}
/** The latest approved salary, or with `asOf` the one in force on that day. */
async function payOf(db: Db, a: TenantActor, id: string, asOf: string | null = null): Promise<LetterPay | null> {
  if (!(await mayPrintPay(db, a, id))) return null;
  const row = (
    await db.query<{ annual_ctc_enc: string | null; effective_from: string }>(
      `SELECT annual_ctc_enc, effective_from::text FROM employee_salaries WHERE tenant_id=$1 AND employee_id=$2 AND status='active' AND ($3::date IS NULL OR effective_from <= $3::date) ORDER BY effective_from DESC LIMIT 1`,
      [a.tenantId, id, asOf],
    )
  ).rows[0];
  return row?.annual_ctc_enc ? { ctc: Number(openJson<number>(row.annual_ctc_enc)), effectiveFrom: row.effective_from } : null;
}

async function issued(db: Db, req: FastifyRequest, a: TenantActor, id: string, letterKind: string, salary: boolean) {
  await audit(db, {
    ...a.auditBase,
    userAgent: readDevice(req).userAgent,
    action: 'lifecycle.letter_issued',
    category: 'access',
    targetType: 'employee',
    targetId: id,
    metadata: { letter: letterKind, l4: salary },
  });
  if (salary) await auditL4(db, readContext(req, a), 'export', `lifecycle.letter.${letterKind}`, [{ employeeId: id, fields: ['annual_ctc'] }]);
}

/** Why an exit letter is not due yet, from the record. */
function exitUnavailable({ separation: sep, today }: Subject, kind: 'experience' | 'relieving'): string | null {
  if (!sep || sep.lwd > today) return 'This letter is available from the last working day of an approved separation';
  if (kind === 'experience') return null;
  if (sep.status !== 'completed') return 'A relieving letter is available once the separation is complete';
  return sep.kind === 'death' || sep.kind === 'absconding' ? 'A relieving letter does not apply to this separation' : null;
}

/**
 * Self, or HR above them. An experience letter is due once the last working day has come; a relieving letter once the separation is complete,
 * because it says clearance is done. A separation that ended with a death or an absconding gets no relieving letter.
 */
async function exitLetterData(req: FastifyRequest, a: TenantActor, id: string, kind: 'experience' | 'relieving') {
  return a.tx(async (db) => {
    await requireFeature(db, a.tenantId, OFF);
    const self = a.user.employeeId === id && a.has('lifecycle.self');
    if (!self && !(await hrAbove(db, a, id))) throw notFound('Employee not found');
    const subject = (await subjectOf(db, a.tenantId, id))!;
    const why = exitUnavailable(subject, kind);
    if (why) throw conflict(why);
    await issued(db, req, a, id, kind, false);
    return { subject, lwd: subject.separation!.lwd, today: subject.today, identity: await loadPdfIdentity(db, a.tenantId) };
  });
}
