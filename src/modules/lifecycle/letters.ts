import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { only } from '../../core/features/routes.js';
import { audit } from '../../core/audit/audit.js';
import { openJson } from '../../core/crypto/index.js';
import { conflict, notFound } from '../../core/http/errors.js';
import { Uuid } from '../../core/http/pagination.js';
import { readDevice, requireFeature, tenantActor, tenantActorAny, type TenantActor } from '../../core/http/context.js';
import { BOLD, loadPdfContext, loadPdfIdentity, pdfHeaders, PdfWriter, REGULAR, type Doc, type PdfContext } from '../../core/pdf/writer.js';
import { auditL4, l3RowFilter, policyViewer, readContext, subjectVisible } from '../../core/policy/salary.js';
import type { Db } from '../../db/tx.js';
import { orgToday } from '../competency/service.js';
import { featureOn } from './service.js';

const ON = 'core.onboarding';
const OFF = 'core.offboarding';
const IdParams = z.object({ id: Uuid });
/** `?salary=1` asks for the annual CTC on an appointment letter. It prints only if this reader may see it, and then it is an L4 export. */
const AppointmentQuery = z.object({ salary: z.literal('1').optional() });

interface Subject { id: string; name: string; employee_code: string; designation: string | null; employment_type: string; date_of_joining: string; probation_end_date: string | null; department: string | null; branch: string; legal_entity: string }
const subjectOf = async (db: Db, tenantId: string, id: string) => (await db.query<Subject>(`SELECT e.id, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, e.employee_code, e.designation, e.employment_type,
    e.date_of_joining::text, e.probation_end_date::text, d.name AS department, b.name AS branch, le.name AS legal_entity
  FROM employees e JOIN branches b ON b.tenant_id=e.tenant_id AND b.id=e.branch_id JOIN legal_entities le ON le.tenant_id=e.tenant_id AND le.id=e.legal_entity_id
  LEFT JOIN departments d ON d.tenant_id=e.tenant_id AND d.id=e.department_id WHERE e.tenant_id=$1 AND e.id=$2`, [tenantId, id])).rows[0];

/** Whether this reader stands above this person as HR. Nobody issues their own letter this way. */
async function hrAbove(db: Db, a: TenantActor, id: string) {
  if (a.user.employeeId === id || !a.has('employees.manage')) return false;
  return subjectVisible(db, a.tenantId, await policyViewer(db, a.tenantId, a.user), id, l3RowFilter);
}

function letter(ctx: PdfContext, o: { title: string; today: string; subject: Subject; heading: string; paragraphs: (w: PdfWriter) => string[] }): Doc {
  const w = new PdfWriter(ctx, { title: o.title });
  const { doc, margin, usableWidth: width } = w;
  w.letterhead('short');
  doc.font(REGULAR).fontSize(10).text(`Date: ${w.date(o.today)}`, margin, doc.y, { width, align: 'right' });
  doc.moveDown(0.5);
  doc.text('To,', margin);
  doc.font(BOLD).text(w.t(o.subject.name), margin);
  doc.font(REGULAR).text(`Employee code: ${w.t(o.subject.employee_code)}`, margin);
  doc.moveDown(1);
  doc.font(BOLD).fontSize(12).fillColor(w.accent).text(o.heading, margin, doc.y, { width, align: 'center' });
  doc.moveDown(1);
  w.body(10.5);
  for (const p of o.paragraphs(w)) doc.text(w.t(p), margin, doc.y, { width, align: 'left', lineGap: 2, paragraphGap: 9 });
  w.signOff({ always: true });
  w.closingNotes();
  doc.end();
  return doc;
}

const roleOf = (s: Subject) => [s.designation, s.department && `in the ${s.department} department`].filter(Boolean).join(' ');
const EMPLOYMENT: Record<string, string> = { permanent: 'permanent', probation: 'probationary', contract: 'contract', trainee: 'trainee', intern: 'internship', consultant: 'consultancy' };

/** Letters HR gives to a person. The text is plain and factual: terms belong to the organization's own contract, and reasons for leaving (L3) are never printed. */
export function letterRoutes(app: FastifyInstance) {
  only(app, 'core.onboarding').get('/employees/:id/letters/appointment.pdf', { schema: { params: IdParams, querystring: AppointmentQuery }, config: { perm: ['employees.manage'], feature: [ON] } }, async (req, reply) => {
    const a = tenantActor(req, 'employees.manage');
    const { id } = IdParams.parse(req.params);
    const q = AppointmentQuery.parse(req.query);
    const r = await a.tx(async (db) => {
      await requireFeature(db, a.tenantId, ON);
      if (!(await hrAbove(db, a, id))) throw notFound('Employee not found');
      const subject = (await subjectOf(db, a.tenantId, id))!;
      const ctc = q.salary ? await annualCtc(db, a, id) : null;
      await issued(db, req, a, id, 'appointment', ctc !== null);
      return { subject, ctc, today: await orgToday(db, a.tenantId), identity: await loadPdfIdentity(db, a.tenantId) };
    });
    const ctx = await loadPdfContext(app, r.identity);
    const s = r.subject; const kind = EMPLOYMENT[s.employment_type];
    const doc = letter(ctx, { title: 'Appointment letter', today: r.today, subject: s, heading: 'Letter of appointment', paragraphs: (w) => [
      `We are pleased to confirm your appointment with ${ctx.legalName}${roleOf(s) ? ` as ${roleOf(s)}` : ''}, at our ${s.branch} location, with effect from ${w.date(s.date_of_joining)}.`,
      ...(kind ? [`The nature of your employment is ${kind}.`] : []),
      ...(s.probation_end_date ? [`Your probation runs until ${w.date(s.probation_end_date)}.`] : []),
      ...(r.ctc !== null ? [`Your annual cost to company is ${w.money(r.ctc)}.`] : []),
      'Your employment is subject to the terms of your contract and the policies of the organization as they apply from time to time.',
    ] });
    return pdfHeaders(reply, 'appointment-letter.pdf').header('x-salary-included', r.ctc !== null ? '1' : '0').send(doc);
  });

  only(app, 'core.offboarding').get('/employees/:id/letters/experience.pdf', { schema: { params: IdParams }, config: { permAny: ['employees.manage', 'lifecycle.self'], feature: [OFF] } }, async (req, reply) => {
    const a = tenantActorAny(req, 'employees.manage', 'lifecycle.self');
    const { id } = IdParams.parse(req.params);
    const r = await exitLetterData(req, a, id, 'experience');
    const ctx = await loadPdfContext(app, r.identity);
    const s = r.subject;
    const doc = letter(ctx, { title: 'Experience letter', today: r.today, subject: s, heading: 'To whom it may concern', paragraphs: (w) => [
      `This is to certify that ${s.name} (employee code ${s.employee_code}) was employed with ${ctx.legalName} from ${w.date(s.date_of_joining)} to ${w.date(r.lwd)}.`,
      ...(roleOf(s) ? [`At the time of leaving, the position held was ${roleOf(s)}.`] : []),
      'This letter is issued on request and states the facts of employment as recorded by the organization.',
    ] });
    return pdfHeaders(reply, 'experience-letter.pdf').send(doc);
  });

  only(app, 'core.offboarding').get('/employees/:id/letters/relieving.pdf', { schema: { params: IdParams }, config: { permAny: ['employees.manage', 'lifecycle.self'], feature: [OFF] } }, async (req, reply) => {
    const a = tenantActorAny(req, 'employees.manage', 'lifecycle.self');
    const { id } = IdParams.parse(req.params);
    const r = await exitLetterData(req, a, id, 'relieving');
    const ctx = await loadPdfContext(app, r.identity);
    const s = r.subject;
    const doc = letter(ctx, { title: 'Relieving letter', today: r.today, subject: s, heading: 'Relieving letter', paragraphs: (w) => [
      `This is to confirm that ${s.name} (employee code ${s.employee_code})${roleOf(s) ? `, ${roleOf(s)},` : ''} has been relieved from the services of ${ctx.legalName} with effect from the close of business on ${w.date(r.lwd)}.`,
      'Exit clearance has been completed.',
    ] });
    return pdfHeaders(reply, 'relieving-letter.pdf').send(doc);
  });
}

/** Salary on a letter: payroll's readers, strictly above this person, and only while payroll is in use. */
async function annualCtc(db: Db, a: TenantActor, id: string): Promise<number | null> {
  if (!a.has('payroll.read') && !a.has('payroll.manage')) return null;
  if (!(await featureOn(db, a.tenantId, 'payroll'))) return null;
  if (!(await subjectVisible(db, a.tenantId, await policyViewer(db, a.tenantId, a.user), id))) return null;
  const row = (await db.query<{ annual_ctc_enc: string | null }>(`SELECT annual_ctc_enc FROM employee_salaries WHERE tenant_id=$1 AND employee_id=$2 AND status='active' ORDER BY effective_from DESC LIMIT 1`, [a.tenantId, id])).rows[0];
  return row?.annual_ctc_enc ? openJson<number>(row.annual_ctc_enc) : null;
}

async function issued(db: Db, req: FastifyRequest, a: TenantActor, id: string, letterKind: string, salary: boolean) {
  await audit(db, { ...a.auditBase, userAgent: readDevice(req).userAgent, action: 'lifecycle.letter_issued', category: 'access', targetType: 'employee', targetId: id, metadata: { letter: letterKind, l4: salary } });
  if (salary) await auditL4(db, readContext(req, a), 'export', `lifecycle.letter.${letterKind}`, [{ employeeId: id, fields: ['annual_ctc'] }]);
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
    const sep = (await db.query<{ status: string; kind: string; lwd: string }>(`SELECT status, kind, coalesce(approved_lwd, requested_lwd)::text AS lwd FROM separations
      WHERE tenant_id=$1 AND employee_id=$2 AND status IN ('approved','completed') ORDER BY created_at DESC LIMIT 1`, [a.tenantId, id])).rows[0];
    const today = await orgToday(db, a.tenantId);
    if (!sep || sep.lwd > today) throw conflict('This letter is available from the last working day of an approved separation');
    if (kind === 'relieving') {
      if (sep.status !== 'completed') throw conflict('A relieving letter is available once the separation is complete');
      if (sep.kind === 'death' || sep.kind === 'absconding') throw conflict('A relieving letter does not apply to this separation');
    }
    await issued(db, req, a, id, kind, false);
    return { subject, lwd: sep.lwd, today, identity: await loadPdfIdentity(db, a.tenantId) };
  });
}
