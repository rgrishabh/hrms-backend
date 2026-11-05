import type { FastifyInstance } from 'fastify';
import { only } from '../../core/features/routes.js';
import { z } from 'zod';
import { tenantActor, requireFeature, type TenantActor, gateFeatures } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { IsoDate, Uuid } from '../../core/http/pagination.js';
import { notifyUsers, usersWithPermission } from '../../core/notify/service.js';
import { getSettingValue } from '../../core/settings/service.js';
import { orgToday } from '../competency/service.js';
import { addDays, daysBetween } from '../attendance/time.js';
import type { Db } from '../../db/tx.js';
import type { FieldCipher } from '../../core/crypto/index.js';

type Kind = 'posh' | 'grievance';
const FEATURE: Record<Kind, string> = { posh: 'posh', grievance: 'grievance' };
const POSH_CATEGORIES = ['verbal', 'physical', 'non_verbal', 'quid_pro_quo', 'hostile_environment', 'online', 'other'] as const;
const GRIEVANCE_CATEGORIES = ['pay', 'leave', 'workload', 'manager', 'colleague', 'safety', 'facilities', 'discrimination', 'policy', 'other'] as const;
/** Allowed status moves per kind. Withdrawal is by the complainant only. */
const MOVES: Record<Kind, Record<string, string[]>> = {
  posh: { received: ['conciliation', 'inquiry'], conciliation: ['closed', 'inquiry'], inquiry: ['report_submitted'], report_submitted: ['closed'], closed: [], withdrawn: [] },
  grievance: { open: ['in_progress', 'resolved'], in_progress: ['resolved'], resolved: ['closed', 'reopened'], reopened: ['in_progress', 'resolved'], closed: [], withdrawn: [] },
};
const ref = (kind: Kind, n: number) => `${kind === 'posh' ? 'IC' : 'GR'}-${String(n).padStart(4, '0')}`;

async function isCommittee(db: Db, tenantId: string, userId: string) {
  return ((await db.query('SELECT 1 FROM posh_committee_members WHERE tenant_id=$1 AND user_id=$2', [tenantId, userId])).rowCount ?? 0) > 0;
}
async function userOfEmployee(db: Db, tenantId: string, employeeId: string | null | undefined) {
  if (!employeeId) return null;
  return (await db.query<{ user_id: string | null }>('SELECT user_id FROM employees WHERE tenant_id=$1 AND id=$2', [tenantId, employeeId])).rows[0]?.user_id ?? null;
}

async function committeeUsers(db: Db, tenantId: string) {
  return (await db.query<{ user_id: string }>('SELECT user_id FROM posh_committee_members WHERE tenant_id=$1', [tenantId])).rows.map((r) => r.user_id);
}

interface CaseRow { id: string; kind: Kind; number: number; status: string; complainant_user: string | null; complainant_id: string | null; assignee_user: string | null; respondent_id: string | null; version: number }
/** Role of the actor on this case: 'handler' (IC member / grievance handler), 'complainant', or no access (404). */
async function loadCase(db: Db, a: TenantActor, id: string, lock = false) {
  const c = (await db.query<CaseRow>(`SELECT id, kind, number, status, complainant_user, complainant_id, assignee_user, respondent_id, version FROM cases WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [a.tenantId, id])).rows[0];
  if (!c) throw notFound('Case not found');
  await requireFeature(db, a.tenantId, FEATURE[c.kind]);
  const handler = c.kind === 'posh' ? await isCommittee(db, a.tenantId, a.user.userId) : a.has('grievance.manage') || c.assignee_user === a.user.userId;
  // A handler who is a party to the case must not act on it (conflict of interest).
  const party = c.complainant_user === a.user.userId || (!!c.respondent_id && c.respondent_id === a.user.employeeId);
  if (handler && !party) return { c, role: 'handler' as const };
  if (c.complainant_user === a.user.userId) return { c, role: 'complainant' as const };
  throw notFound('Case not found');
}


/**
 * Audit base for an action. A complainant's own actions are recorded without their identity or IP:
 * audit readers (administrators, HR, auditors) must not learn who filed a confidential or anonymous case.
 * Handlers' actions keep their name, so access to case files stays accountable.
 */
function caseAuditBase(a: TenantActor, role: string) {
  return role === 'complainant' ? { ...a.auditBase, actorId: null, ip: undefined, metadata: { actor: 'complainant' } } : { ...a.auditBase, metadata: {} };
}

const CommitteeBody = z.object({ members: z.array(z.object({ userId: Uuid, role: z.enum(['presiding_officer', 'member']) })).min(1).max(20)
      .refine((m) => m.filter((x) => x.role === 'presiding_officer').length === 1, 'Exactly one presiding officer'),
      external: z.array(z.object({ name: z.string().trim().min(2).max(120), organization: z.string().trim().min(2).max(200), since: IsoDate })).max(5) });
const PeopleQuery = z.object({ search: z.string().trim().max(100).optional() });
const PostRootBody = z.object({
      kind: z.enum(['posh', 'grievance']), category: z.string(), description: z.string().trim().min(20).max(10000), incidentDate: IsoDate.nullable().default(null),
      respondentEmployeeId: Uuid.nullable().default(null), respondentText: z.string().trim().max(500).nullable().default(null), anonymous: z.boolean().default(false), lateReason: z.string().trim().max(2000).nullable().default(null),
    });
const GetRootQuery = z.object({ kind: z.enum(['posh', 'grievance']), scope: z.enum(['mine', 'handling']).default('mine'), status: z.string().max(30).optional() });
const IdParams = z.object({ id: Uuid });
const EventsBody = z.object({ text: z.string().trim().min(2).max(10000), visibleToComplainant: z.boolean().default(false), toStatus: z.string().optional(), outcome: z.string().trim().max(10000).optional(),
      expectedVersion: z.number().int() });
const AssignBody = z.object({ userId: Uuid });
const WithdrawBody = z.object({ reason: z.string().trim().min(3).max(2000) });
const PoshAnnualReportQuery = z.object({ year: z.coerce.number().int().min(2013).max(2100) });
export async function caseRoutes(app: FastifyInstance) {
  gateFeatures(app, 'grievance', 'posh');
  const cipher: FieldCipher = app.deps.cipher;
  const enc = (s: string | null | undefined) => (s ? cipher.encrypt(s) : null);
  const dec = (s: string | null | undefined) => (s ? cipher.decrypt(s) : null);

  // ------------------------------------------------------------ Internal Committee
  only(app, 'posh').get('/committee', { schema: {}, config: { feature: ['posh'] } }, async (req) => {
    const a = tenantActor(req);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'posh');
      // Everyone may know who sits on the IC (the Act requires the composition to be displayed).
      const members = (await db.query(`SELECT m.user_id, u.display_name, m.role, m.added_at FROM posh_committee_members m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY m.role DESC, u.display_name`, [a.tenantId])).rows;
      const external = (await db.query(`SELECT id, name, organization, since::text, until::text FROM posh_external_members WHERE tenant_id=$1 AND (until IS NULL OR until >= current_date) ORDER BY name`, [a.tenantId])).rows;
      return { members, external, warnings: [...(members.some((m: { role: string }) => m.role === 'presiding_officer') ? [] : ['No presiding officer']), ...(external.length ? [] : ['No external member'])] };
    });
  });
  only(app, 'posh').put('/committee', { schema: { body: CommitteeBody }, config: { perm: ['posh.admin'], feature: ['posh'] } }, async (req) => {
    const a = tenantActor(req, 'posh.admin');
    const b = CommitteeBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'posh');
      const users = (await db.query(`SELECT id FROM users WHERE tenant_id=$1 AND status='active' AND id = ANY($2::uuid[])`, [a.tenantId, b.members.map((m) => m.userId)])).rows;
      if (users.length !== new Set(b.members.map((m) => m.userId)).size) throw badRequest('Every member must be an active user');
      const prev = (await db.query<{ user_id: string }>('SELECT user_id FROM posh_committee_members WHERE tenant_id=$1', [a.tenantId])).rows.map((r) => r.user_id);
      const next = b.members.map((m) => m.userId);
      const added = next.filter((u) => !prev.includes(u)); const removed = prev.filter((u) => !next.includes(u));
      // Committee members read every complaint: nobody can put themselves on it (two-person rule).
      if (added.includes(a.user.userId)) throw forbidden('Another administrator must add you to the Internal Committee');
      await db.query('DELETE FROM posh_committee_members WHERE tenant_id=$1', [a.tenantId]);
      for (const m of b.members) await db.query('INSERT INTO posh_committee_members (tenant_id, user_id, role, added_by) VALUES ($1,$2,$3,$4)', [a.tenantId, m.userId, m.role, a.user.userId]);
      await db.query(`UPDATE posh_external_members SET until=current_date - 1 WHERE tenant_id=$1 AND until IS NULL`, [a.tenantId]);
      for (const x of b.external) await db.query('INSERT INTO posh_external_members (tenant_id, name, organization, since) VALUES ($1,$2,$3,$4)', [a.tenantId, x.name, x.organization, x.since]);
      await audit(db, { ...a.auditBase, action: 'posh.committee_updated', category: 'security', metadata: { members: b.members.length, external: b.external.length, added, removed } });
      // Members old and new learn of every change, so a temporary addition cannot go unnoticed.
      if (added.length || removed.length) {
        const names = async (ids: string[]) => (await db.query<{ n: string }>('SELECT display_name AS n FROM users WHERE id = ANY($1::uuid[]) ORDER BY display_name', [ids])).rows.map((r) => r.n).join(', ');
        const body = [added.length ? `Added: ${await names(added)}.` : '', removed.length ? `Removed: ${await names(removed)}.` : ''].filter(Boolean).join(' ');
        await notifyUsers(db, a.tenantId, [...new Set([...prev, ...next])].filter((u) => u !== a.user.userId),
          { kind: 'cases.committee', title: `Internal Committee changed by ${a.user.displayName}`, body, link: '/cases', actionLabel: 'View committee' });
      }
      return { ok: true };
    });
  });

  /** Active users (name only) for picking IC members or grievance handlers. */
  app.get('/people', { schema: { querystring: PeopleQuery } }, async (req) => {
    const a = tenantActor(req);
    if (!a.has('posh.admin') && !a.has('grievance.manage')) throw forbidden();
    const q = PeopleQuery.parse(req.query);
    return a.tx(async (db) => ({ items: (await db.query(`SELECT id, display_name FROM users WHERE tenant_id=$1 AND status='active'
      AND ($2::text IS NULL OR lower(display_name) LIKE '%'||lower($2)||'%') ORDER BY display_name LIMIT 25`, [a.tenantId, q.search || null])).rows }));
  });

  // ------------------------------------------------------------ file a case
  app.post('/', { schema: { body: PostRootBody }, config: { perm: ['cases.self'] } }, async (req, reply) => {
    const a = tenantActor(req, 'cases.self');
    const b = PostRootBody.parse(req.body);
    if (!a.user.employeeId && !b.anonymous) throw badRequest('Your account is not linked to an employee record');
    const cats: readonly string[] = b.kind === 'posh' ? POSH_CATEGORIES : GRIEVANCE_CATEGORIES;
    if (!cats.includes(b.category)) throw badRequest(`Category must be one of: ${cats.join(', ')}`);
    if (b.kind === 'posh' && b.anonymous) throw badRequest('POSH complaints cannot be anonymous: the Internal Committee must be able to inquire');
    if (b.respondentEmployeeId && b.respondentEmployeeId === a.user.employeeId) throw badRequest('You cannot name yourself as the respondent');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE[b.kind]);
      const today = await orgToday(db, a.tenantId);
      if (b.incidentDate && b.incidentDate > today) throw badRequest('The incident date cannot be in the future');
      // POSH Act: within three months of the incident (the IC may extend for reasons recorded).
      const late = b.kind === 'posh' && !!b.incidentDate && daysBetween(b.incidentDate, today) > 92;
      if (late && !b.lateReason) throw badRequest('This is more than three months after the incident: explain the delay so the Committee can consider extending the time limit');
      if (b.kind === 'posh' && (await committeeUsers(db, a.tenantId)).length === 0) throw conflict('No Internal Committee is set up yet. Contact HR, or the Local Committee of your district.');
      if (b.respondentEmployeeId && !(await db.query('SELECT 1 FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, b.respondentEmployeeId])).rowCount) throw badRequest('Unknown respondent');
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`case-number:${a.tenantId}:${b.kind}`]);
      const n = (await db.query<{ n: number }>('SELECT coalesce(max(number),0)+1 AS n FROM cases WHERE tenant_id=$1 AND kind=$2', [a.tenantId, b.kind])).rows[0]!.n;
      const sla = b.kind === 'grievance' ? addDays(today, await getSettingValue<number>(db, a.tenantId, 'grievance.response_days')) : null;
      const id = (await db.query<{ id: string }>(`INSERT INTO cases (tenant_id, kind, number, category, complainant_id, complainant_user, anonymous, respondent_id, respondent_text_enc, incident_date,
          description_enc, late_reason_enc, status, inquiry_due, sla_due)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [a.tenantId, b.kind, n, b.category, b.anonymous ? null : a.user.employeeId, a.user.userId, b.anonymous, b.respondentEmployeeId, enc(b.respondentText), b.incidentDate,
          enc(b.description), enc(late ? b.lateReason : null), b.kind === 'posh' ? 'received' : 'open', b.kind === 'posh' ? addDays(today, 90) : null, sla])).rows[0]!.id;
      const respondentUser = await userOfEmployee(db, a.tenantId, b.respondentEmployeeId);
      const to = (b.kind === 'posh' ? await committeeUsers(db, a.tenantId) : await usersWithPermission(db, a.tenantId, 'grievance.manage')).filter((u) => u !== respondentUser);
      // Notifications (and email) carry no names or details.
      await notifyUsers(db, a.tenantId, to.filter((u) => u !== a.user.userId), { kind: `cases.${b.kind}`, title: `New ${b.kind === 'posh' ? 'POSH complaint' : 'grievance'} ${ref(b.kind, n)}`,
        body: 'Sign in to view it. Keep it confidential.', link: `/cases?case=${id}`, actionLabel: 'Open case' });
      // Audit: metadata only — never the narrative.
      const base = caseAuditBase(a, 'complainant');
      await audit(db, { ...base, action: `cases.${b.kind}_filed`, category: 'data', targetType: 'case', targetId: id, metadata: { ...base.metadata, number: ref(b.kind, n), category: b.category, anonymous: b.anonymous, late } });
      reply.code(201); return { id, reference: ref(b.kind, n) };
    });
  });

  // ------------------------------------------------------------ lists
  app.get('/', { schema: { querystring: GetRootQuery } }, async (req) => {
    const a = tenantActor(req);
    const q = GetRootQuery.parse(req.query);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE[q.kind]);
      if (q.scope === 'handling') {
        const ok = q.kind === 'posh' ? await isCommittee(db, a.tenantId, a.user.userId) : a.has('grievance.manage');
        if (!ok && q.kind === 'posh') throw forbidden('Only Internal Committee members can see POSH complaints');
      }
      const rows = (await db.query(`SELECT c.id, c.kind, c.number, c.category, c.status, c.anonymous, c.received_at, c.inquiry_due::text, c.report_due::text, c.sla_due::text, c.closed_at,
          c.complainant_user, c.respondent_id, CASE WHEN c.anonymous THEN NULL ELSE trim(e.first_name||' '||coalesce(e.last_name,'')) END AS complainant_name, u.display_name AS assignee_name
        FROM cases c LEFT JOIN employees e ON e.tenant_id=c.tenant_id AND e.id=c.complainant_id LEFT JOIN users u ON u.id=c.assignee_user
        WHERE c.tenant_id=$1 AND c.kind=$2 AND ($3::text IS NULL OR c.status=$3)
          AND (($4='mine' AND c.complainant_user=$5) OR ($4='handling' AND ($6 OR c.assignee_user=$5) AND c.complainant_user IS DISTINCT FROM $5 AND c.respondent_id IS DISTINCT FROM $7))
        ORDER BY (c.status IN ('closed','withdrawn')), c.received_at DESC LIMIT 200`,
        [a.tenantId, q.kind, q.status ?? null, q.scope, a.user.userId, q.kind === 'posh' || a.has('grievance.manage'), a.user.employeeId ?? null])).rows;
      return { items: rows.map(({ complainant_user: _cu, respondent_id: _r, ...r }) => ({ ...r, reference: ref(r.kind as Kind, r.number as number) })) };
    });
  });

  // Only ids, so that /committee is simply not found while POSH is off.
  app.get('/:id([0-9a-fA-F-]{36})', { schema: { params: IdParams } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      const { c, role } = await loadCase(db, a, id);
      const row = (await db.query(`SELECT c.*, c.incident_date::text, c.inquiry_due::text, c.report_due::text, c.sla_due::text,
          CASE WHEN c.anonymous THEN NULL ELSE trim(e.first_name||' '||coalesce(e.last_name,'')) END AS complainant_name,
          trim(r.first_name||' '||coalesce(r.last_name,'')) AS respondent_name, u.display_name AS assignee_name
        FROM cases c LEFT JOIN employees e ON e.tenant_id=c.tenant_id AND e.id=c.complainant_id LEFT JOIN employees r ON r.tenant_id=c.tenant_id AND r.id=c.respondent_id
        LEFT JOIN users u ON u.id=c.assignee_user WHERE c.tenant_id=$1 AND c.id=$2`, [a.tenantId, id])).rows[0]!;
      const events = (await db.query<{ text_enc: string | null; visible_to_complainant: boolean; actor: string | null }>(`SELECT v.type, v.text_enc, v.from_status, v.to_status, v.visible_to_complainant, v.at,
          CASE WHEN v.actor_user = c.complainant_user THEN 'Complainant' ELSE u.display_name END AS actor
        FROM case_events v JOIN cases c ON c.tenant_id=v.tenant_id AND c.id=v.case_id LEFT JOIN users u ON u.id=v.actor_user
        WHERE v.tenant_id=$1 AND v.case_id=$2 ORDER BY v.at`, [a.tenantId, id])).rows
        .filter((v) => role === 'handler' || v.visible_to_complainant)
        .map(({ text_enc, ...v }) => ({ ...v, text: dec(text_enc), actor: role === 'complainant' && v.actor !== 'Complainant' ? (c.kind === 'posh' ? 'Internal Committee' : 'HR') : v.actor }));
      const base = caseAuditBase(a, role);
      await audit(db, { ...base, action: 'cases.viewed', category: 'access', targetType: 'case', targetId: id, metadata: { ...base.metadata, role } });
      return {
        id: row.id, kind: row.kind, reference: ref(row.kind, row.number), category: row.category, status: row.status, anonymous: row.anonymous, role, version: row.version,
        complainantName: row.complainant_name, respondentName: role === 'handler' ? row.respondent_name : undefined, respondentText: role === 'handler' ? dec(row.respondent_text_enc) : undefined,
        incidentDate: row.incident_date, description: dec(row.description_enc), lateReason: dec(row.late_reason_enc), outcome: dec(row.outcome_enc),
        receivedAt: row.received_at, inquiryDue: row.inquiry_due, reportDue: row.report_due, slaDue: row.sla_due, closedAt: row.closed_at, assigneeName: row.assignee_name,
        allowedMoves: role === 'handler' ? MOVES[c.kind as Kind][c.status] ?? [] : [], events,
      };
    });
  });

  // ------------------------------------------------------------ actions
  app.post('/:id/events', { schema: { params: IdParams, body: EventsBody } }, async (req, reply) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    const b = EventsBody.parse(req.body);
    return a.tx(async (db) => {
      const { c, role } = await loadCase(db, a, id, true);
      if (c.version !== b.expectedVersion) throw conflict('The case changed meanwhile. Reload and try again.');
      if (['closed', 'withdrawn'].includes(c.status) && !(c.kind === 'grievance' && b.toStatus === 'reopened')) throw conflict(`The case is ${c.status}`);
      if (role === 'complainant') {
        if (b.toStatus === 'reopened' && c.kind === 'grievance' && c.status === 'resolved') { /* complainant may reopen a resolved grievance */ }
        else if (b.toStatus) throw forbidden('Only the handler changes the status');
        await db.query(`INSERT INTO case_events (tenant_id, case_id, type, text_enc, from_status, to_status, visible_to_complainant, actor_user) VALUES ($1,$2,$3,$4,$5,$6,true,$7)`,
          [a.tenantId, id, b.toStatus ? 'status' : 'comment', enc(b.text), b.toStatus ? c.status : null, b.toStatus ?? null, a.user.userId]);
        if (b.toStatus) await db.query(`UPDATE cases SET status='reopened', version=version+1 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
        else await db.query(`UPDATE cases SET version=version+1 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      } else {
        if (b.toStatus && !(MOVES[c.kind][c.status] ?? []).includes(b.toStatus)) throw conflict(`Cannot move from ${c.status} to ${b.toStatus}`);
        if (b.toStatus === 'closed' && !b.outcome && c.kind === 'posh') throw badRequest('Record the outcome / recommendation when closing');
        const today = await orgToday(db, a.tenantId);
        await db.query(`INSERT INTO case_events (tenant_id, case_id, type, text_enc, from_status, to_status, visible_to_complainant, actor_user) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [a.tenantId, id, b.toStatus ? 'status' : b.visibleToComplainant ? 'update' : 'note', enc(b.text), b.toStatus ? c.status : null, b.toStatus ?? null, b.visibleToComplainant || !!b.toStatus, a.user.userId]);
        await db.query(`UPDATE cases SET status=coalesce($3, status), outcome_enc=coalesce($4, outcome_enc),
            closed_at=CASE WHEN $3 = 'closed' THEN now() WHEN $3 = 'reopened' THEN NULL ELSE closed_at END, version=version+1 WHERE tenant_id=$1 AND id=$2`,
          [a.tenantId, id, b.toStatus ?? null, enc(b.outcome)]);
        // Inquiry finished → report due within 10 days (POSH Act s.13).
        if (c.kind === 'posh' && b.toStatus === 'report_submitted') await db.query(`UPDATE cases SET report_due=$3::date + 10 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, today]);
        if ((b.visibleToComplainant || b.toStatus) && c.complainant_user)
          await notifyUsers(db, a.tenantId, [c.complainant_user], { kind: 'cases.update', feature: FEATURE[c.kind], title: `Update on your case ${ref(c.kind, c.number)}`, body: 'Sign in to read it.', link: `/cases?case=${id}`, actionLabel: 'Open' });
      }
      const base = caseAuditBase(a, role);
      await audit(db, { ...base, action: 'cases.event_added', category: 'data', targetType: 'case', targetId: id, metadata: { ...base.metadata, role, toStatus: b.toStatus ?? null, visibleToComplainant: b.visibleToComplainant } });
      reply.code(201); return { ok: true };
    });
  });

  app.post('/:id/assign', { schema: { params: IdParams, body: AssignBody }, config: { perm: ['grievance.manage'] } }, async (req) => {
    const a = tenantActor(req, 'grievance.manage');
    const { id } = IdParams.parse(req.params);
    const { userId } = AssignBody.parse(req.body);
    return a.tx(async (db) => {
      const { c } = await loadCase(db, a, id, true);
      if (c.kind !== 'grievance') throw badRequest('POSH complaints are handled by the Internal Committee');
      // One message for every party: naming the reason would tell a handler trying IDs who filed an anonymous grievance.
      const NOT_ASSIGNABLE = 'This person cannot be assigned to this grievance';
      if (userId === c.complainant_user) throw badRequest(NOT_ASSIGNABLE);
      const u = (await db.query<{ employee_id: string | null }>(`SELECT e.id AS employee_id FROM users u LEFT JOIN employees e ON e.tenant_id=u.tenant_id AND e.user_id=u.id WHERE u.tenant_id=$1 AND u.id=$2 AND u.status='active'`, [a.tenantId, userId])).rows[0];
      if (!u) throw badRequest('Unknown user');
      if (u.employee_id && u.employee_id === c.respondent_id) throw badRequest(NOT_ASSIGNABLE);
      await db.query(`UPDATE cases SET assignee_user=$3, status=CASE WHEN status='open' THEN 'in_progress' ELSE status END, version=version+1 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, userId]);
      await db.query(`INSERT INTO case_events (tenant_id, case_id, type, actor_user) VALUES ($1,$2,'assignment',$3)`, [a.tenantId, id, a.user.userId]);
      await notifyUsers(db, a.tenantId, [userId], { kind: 'cases.assigned', title: `Grievance ${ref(c.kind, c.number)} assigned to you`, body: 'Keep it confidential.', link: `/cases?case=${id}`, actionLabel: 'Open' });
      await audit(db, { ...a.auditBase, action: 'cases.assigned', category: 'data', targetType: 'case', targetId: id, metadata: { assignee: userId } });
      return { ok: true };
    });
  });

  app.post('/:id/withdraw', { schema: { params: IdParams, body: WithdrawBody }, config: { perm: ['cases.self'] } }, async (req) => {
    const a = tenantActor(req, 'cases.self');
    const { id } = IdParams.parse(req.params);
    const { reason } = WithdrawBody.parse(req.body);
    return a.tx(async (db) => {
      const { c, role } = await loadCase(db, a, id, true);
      if (role !== 'complainant') throw forbidden('Only the complainant can withdraw');
      if (['closed', 'withdrawn'].includes(c.status)) throw conflict(`The case is ${c.status}`);
      await db.query(`UPDATE cases SET status='withdrawn', closed_at=now(), version=version+1 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      await db.query(`INSERT INTO case_events (tenant_id, case_id, type, text_enc, from_status, to_status, visible_to_complainant, actor_user) VALUES ($1,$2,'status',$3,$4,'withdrawn',true,$5)`, [a.tenantId, id, enc(reason), c.status, a.user.userId]);
      await audit(db, { ...caseAuditBase(a, 'complainant'), action: 'cases.withdrawn', category: 'data', targetType: 'case', targetId: id });
      return { ok: true };
    });
  });

  /** Counts for the annual report the IC prepares (no names). */
  only(app, 'posh').get('/posh/annual-report', { schema: { querystring: PoshAnnualReportQuery }, config: { feature: ['posh'] } }, async (req) => {
    const a = tenantActor(req);
    const q = PoshAnnualReportQuery.parse(req.query);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'posh');
      if (!(await isCommittee(db, a.tenantId, a.user.userId)) && !a.has('posh.admin')) throw forbidden();
      const from = `${q.year}-01-01`; const to = `${q.year}-12-31`;
      const r = (await db.query<{ received: number; disposed: number; pending: number; pending_over_90: number }>(`SELECT
          count(*) FILTER (WHERE received_at::date BETWEEN $2 AND $3)::int AS received,
          count(*) FILTER (WHERE status IN ('closed','withdrawn') AND closed_at::date BETWEEN $2 AND $3)::int AS disposed,
          count(*) FILTER (WHERE received_at::date <= $3 AND (closed_at IS NULL OR closed_at::date > $3))::int AS pending,
          count(*) FILTER (WHERE received_at::date <= $3 AND (closed_at IS NULL OR closed_at::date > $3) AND inquiry_due < $3::date)::int AS pending_over_90
        FROM cases WHERE tenant_id=$1 AND kind='posh'`, [a.tenantId, from, to])).rows[0]!;
      return { year: q.year, ...r, note: 'Counts for the annual report under the POSH Act; workshops and awareness programmes are recorded separately.' };
    });
  });
}

/** Daily: POSH inquiry/report due in 7 days or overdue → IC; grievances past their response target → handlers. */
export async function caseDeadlines(db: Db, tenantId: string, today: string) {
  let reminders = 0;
  const posh = (await db.query<{ id: string; number: number; due: string; what: string; respondent_id: string | null }>(`SELECT id, number, respondent_id, CASE WHEN status='report_submitted' THEN report_due ELSE inquiry_due END::text AS due,
      CASE WHEN status='report_submitted' THEN 'report' ELSE 'inquiry' END AS what
    FROM cases WHERE tenant_id=$1 AND kind='posh' AND status IN ('received','conciliation','inquiry','report_submitted')
      AND (CASE WHEN status='report_submitted' THEN report_due ELSE inquiry_due END) - $2::date IN (7, 0, -7, -14, -21, -28)`, [tenantId, today])).rows;
  const ic = posh.length ? await committeeUsers(db, tenantId) : [];
  for (const c of posh) {
    const respondent = await userOfEmployee(db, tenantId, c.respondent_id);
    const r = await notifyUsers(db, tenantId, ic.filter((u) => u !== respondent), { kind: 'cases.deadline', title: `${ref('posh', c.number)}: ${c.what} due ${c.due}`, body: 'Statutory timeline under the POSH Act.', link: `/cases?case=${c.id}`, dedupeKey: `posh:${c.id}:${c.what}:${today}` });
    reminders += r.inApp;
  }
  const gr = (await db.query<{ id: string; number: number; assignee_user: string | null; respondent_id: string | null }>(`SELECT id, number, assignee_user, respondent_id FROM cases WHERE tenant_id=$1 AND kind='grievance'
    AND status IN ('open','in_progress','reopened') AND sla_due < $2::date AND ($2::date - sla_due) % 7 = 1`, [tenantId, today])).rows;
  for (const g of gr) {
    const respondent = await userOfEmployee(db, tenantId, g.respondent_id);
    const to = (g.assignee_user ? [g.assignee_user] : await usersWithPermission(db, tenantId, 'grievance.manage')).filter((u) => u !== respondent);
    const r = await notifyUsers(db, tenantId, to, { kind: 'cases.overdue', title: `Grievance ${ref('grievance', g.number)} is past its response target`, body: 'Respond to the employee or update the case.', link: `/cases?case=${g.id}`, dedupeKey: `gr:${g.id}:${today}` });
    reminders += r.inApp;
  }
  return { reminders };
}
