import { maskFields, policyViewer, reasonVisibleSql } from '../../core/policy/salary.js';
import * as R from '../../core/http/responses.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantActor, tenantActorAny, gateFeatures, type TenantActor } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { IsoDate, PageQuery, offsetOf, paged, Uuid } from '../../core/http/pagination.js';
import { buildSteps, createApprovalRequest, registerApprovalHandler, cancelRequest } from '../../core/workflow/engine.js';
import { getSettingValue } from '../../core/settings/service.js';
import { lockedDates, recalculateRange, teamEmployeeIds } from '../attendance/service.js';
import { addDays, daysBetween } from '../attendance/time.js';
import { orgToday } from '../competency/service.js';
import { PURPOSES, PURPOSE_LABEL, assertNoOverlap, span, type DayPart } from './service.js';
import type { Db } from '../../db/tx.js';

const F = 'field_duty';
const READ_ALL = ['field_duty.read', 'field_duty.approve', 'field_duty.manage'];
interface Duty { id: string; employee_id: string; start_date: string; end_date: string; day_part: DayPart; status: string; user_id: string | null; created_by: string; name: string }

const COLS = `f.id, f.employee_id, f.start_date::text, f.end_date::text, f.day_part, f.purpose, f.place, f.client_name, f.reference, f.reason, f.status,
  f.outcome, f.outcome_note, f.reported_at, f.created_at, f.decided_at, f.cancel_reason, (f.created_by <> coalesce(e.user_id, '00000000-0000-0000-0000-000000000000'::uuid)) AS recorded_by_other,
  e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, dp.name AS department,
  (SELECT ar.id FROM approval_requests ar WHERE ar.tenant_id=f.tenant_id AND ar.entity_type='field_duty' AND ar.entity_id=f.id ORDER BY ar.created_at DESC LIMIT 1) AS approval_request_id`;
const FROM = `field_duty_requests f JOIN employees e ON e.tenant_id=f.tenant_id AND e.id=f.employee_id
  LEFT JOIN departments dp ON dp.tenant_id=e.tenant_id AND dp.id=e.department_id`;

const Body = z.object({
  employeeId: Uuid.optional(),
  startDate: IsoDate, endDate: IsoDate,
  dayPart: z.enum(['full', 'first_half', 'second_half']).default('full'),
  purpose: z.enum(PURPOSES),
  place: z.string().trim().min(2).max(200),
  clientName: z.string().trim().max(200).optional().transform((v) => v || null),
  reference: z.string().trim().max(100).optional().transform((v) => v || null),
  reason: z.string().trim().min(3).max(1000),
});

/** The employee, their reporting chain, field-duty readers, the person who recorded it, or an approver of it. */
async function loadDuty(db: Db, a: TenantActor, id: string, lock = false): Promise<Duty> {
  const d = (await db.query<Duty>(`SELECT f.id, f.employee_id, f.start_date::text, f.end_date::text, f.day_part, f.status, f.created_by, e.user_id,
      trim(e.first_name||' '||coalesce(e.last_name,'')) AS name FROM field_duty_requests f JOIN employees e ON e.tenant_id=f.tenant_id AND e.id=f.employee_id
     WHERE f.tenant_id=$1 AND f.id=$2${lock ? ' FOR UPDATE OF f' : ''}`, [a.tenantId, id])).rows[0];
  if (!d) throw notFound('Field duty not found');
  if (d.employee_id === a.user.employeeId || d.created_by === a.user.userId || READ_ALL.some((p) => a.has(p))) return d;
  if (a.has('field_duty.team.read') && a.user.employeeId && (await teamEmployeeIds(db, a.tenantId, a.user.employeeId)).includes(d.employee_id)) return d;
  const r = await db.query(`SELECT 1 FROM approval_requests r JOIN approval_steps s ON s.tenant_id=r.tenant_id AND s.request_id=r.id
    WHERE r.tenant_id=$1 AND r.entity_type='field_duty' AND r.entity_id=$2 AND (s.approver_user_id=$3 OR s.acted_by=$3)`, [a.tenantId, id, a.user.userId]);
  if (r.rowCount) return d;
  throw notFound('Field duty not found');
}

/** Recalculate the days of a request that have begun; later days are calculated as they close (attendance.close_day). */
async function recalc(db: Db, tenantId: string, d: { employee_id: string; start_date: string; end_date: string }) {
  const today = await orgToday(db, tenantId);
  if (d.start_date <= today) await recalculateRange(db, tenantId, d.employee_id, d.start_date, d.end_date < today ? d.end_date : today);
}

/** Approval effects. Registered once at startup (core/runtime), whether or not the module's routes are. */
export function registerFieldDutyApprovals() {
  registerApprovalHandler('field_duty', {
    feature: F, label: 'Field duty', requesterLink: '/field-duty',
    async onApproved(db, tenantId, id) {
      const d = (await db.query<{ employee_id: string; start_date: string; end_date: string; status: string }>(
        `SELECT employee_id, start_date::text, end_date::text, status FROM field_duty_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, id])).rows[0];
      if (!d || d.status !== 'pending') throw conflict('This field duty request is no longer pending');
      if ((await lockedDates(db, tenantId, d.start_date, d.end_date)).size) throw conflict('These dates are now locked for payroll; the field duty cannot be approved');
      await db.query(`UPDATE field_duty_requests SET status='approved', decided_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
      await recalc(db, tenantId, d);
    },
    async onRejected(db, tenantId, id, actorId, status) {
      await db.query(`UPDATE field_duty_requests SET status=$3, decided_at=now(), cancelled_by=CASE WHEN $3='cancelled' THEN $4::uuid END
        WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [tenantId, id, status, actorId]);
    },
  });
}

const RequestsQuery = PageQuery.extend({ scope: z.enum(['mine', 'team', 'all']).default('mine'), status: z.enum(['pending', 'approved', 'rejected', 'returned', 'cancelled']).optional(),
      on: IsoDate.optional(), from: IsoDate.optional(), to: IsoDate.optional() });
const IdParams = z.object({ id: Uuid });
const RequestsCancelBody = z.object({ reason: z.string().trim().min(3).max(500) });
const RequestsReportBody = z.object({ outcome: z.enum(['completed', 'partly_completed', 'not_done']), note: z.string().trim().max(2000).optional().transform((v) => v || null) });
export async function fieldDutyRoutes(app: FastifyInstance) {
  gateFeatures(app, F);

  /** Request field duty for yourself, or (field_duty.manage) record it for an employee; either way the manager approves. */
  app.post('/requests', { schema: { body: Body }, config: { permAny: ['field_duty.self', 'field_duty.manage'] } }, async (req, reply) => {
    const a = tenantActorAny(req, 'field_duty.self', 'field_duty.manage');
    const b = Body.parse(req.body);
    const forOther = !!b.employeeId && b.employeeId !== a.user.employeeId;
    if (forOther && !a.has('field_duty.manage')) throw forbidden('You can request field duty only for yourself');
    if (!forOther && !a.has('field_duty.self')) throw forbidden();
    const empId = b.employeeId ?? a.user.employeeId;
    if (!empId) throw badRequest('Your account is not linked to an employee record');
    if (b.endDate < b.startDate) throw badRequest('The end date is before the start date');
    if (b.dayPart !== 'full' && b.startDate !== b.endDate) throw badRequest('Half-day field duty is for a single day');
    return a.tx(async (db) => {
      const e = (await db.query<{ status: string; date_of_joining: string; exit_date: string | null; user_id: string | null; name: string; mgr_user: string | null }>(
        `SELECT e.status, e.date_of_joining::text, e.exit_date::text, e.user_id, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name,
           CASE WHEN m.status IN ('active','on_notice') THEN m.user_id END AS mgr_user
         FROM employees e LEFT JOIN employees m ON m.tenant_id=e.tenant_id AND m.id=e.reporting_manager_id WHERE e.tenant_id=$1 AND e.id=$2`, [a.tenantId, empId])).rows[0];
      if (!e) throw notFound('Employee not found');
      if (!['active', 'on_notice'].includes(e.status)) throw conflict('Field duty can be recorded only for current employees');
      if (b.startDate < e.date_of_joining || (e.exit_date && b.endDate > e.exit_date)) throw badRequest('The dates fall outside the employment');
      const today = await orgToday(db, a.tenantId);
      const back = await getSettingValue<number>(db, a.tenantId, 'field_duty.backdate_days');
      const ahead = await getSettingValue<number>(db, a.tenantId, 'field_duty.advance_days');
      const maxDays = await getSettingValue<number>(db, a.tenantId, 'field_duty.max_days');
      if (b.startDate < addDays(today, -back)) throw badRequest(back ? `Field duty can be recorded up to ${back} days back` : 'Field duty cannot be recorded for past days');
      if (b.startDate > addDays(today, ahead)) throw badRequest(`Field duty can be planned up to ${ahead} days ahead`);
      const days = daysBetween(b.startDate, b.endDate) + 1;
      if (days > maxDays) throw badRequest(`A field duty request can cover at most ${maxDays} days; split longer assignments`);
      if ((await lockedDates(db, a.tenantId, b.startDate, b.endDate)).size) throw conflict('These dates are in a period locked for payroll');
      await assertNoOverlap(db, a.tenantId, empId, b);
      const id = (await db.query<{ id: string }>(`INSERT INTO field_duty_requests (tenant_id, employee_id, start_date, end_date, day_part, purpose, place, client_name, reference, reason, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [a.tenantId, empId, b.startDate, b.endDate, b.dayPart, b.purpose, b.place, b.clientName, b.reference, b.reason, a.user.userId])).rows[0]!.id;
      // The manager confirms the assignment; HR as well when the organization asks for it, or when there is no manager to ask.
      const hrToo = await getSettingValue<boolean>(db, a.tenantId, 'field_duty.hr_approval');
      const steps = buildSteps({ requesterId: a.user.userId, subjectUserId: e.user_id, managerUserId: e.mgr_user, then: hrToo ? ['field_duty.approve'] : [], ifNoManager: hrToo ? [] : ['field_duty.approve'] });
      const when = span({ start_date: b.startDate, end_date: b.endDate, day_part: b.dayPart });
      const approvalId = await createApprovalRequest(db, a.tenantId, { entityType: 'field_duty', entityId: id, requesterId: a.user.userId,
        summary: `${e.name}: ${PURPOSE_LABEL[b.purpose]} at ${b.place}, ${when}${days > 1 ? ` (${days} days)` : ''}`, steps, excludeUserIds: [a.user.userId, e.user_id] });
      await audit(db, { ...a.auditBase, action: 'field_duty.requested', targetType: 'field_duty', targetId: id,
        metadata: { employeeId: empId, startDate: b.startDate, endDate: b.endDate, dayPart: b.dayPart, purpose: b.purpose, onBehalf: forOther, approvalId } });
      reply.code(201); return { id };
    });
  });

  app.get('/requests', { schema: { response: { 200: R.GetFieldDutyRequests200 }, querystring: RequestsQuery }, config: { permAny: ['field_duty.self', 'field_duty.team.read'] } }, async (req) => {
    const a = tenantActorAny(req, 'field_duty.self', 'field_duty.team.read', ...READ_ALL);
    const q = RequestsQuery.parse(req.query);
    return a.tx(async (db) => {
      let ids: string[] | null;
      if (q.scope === 'all') { if (!READ_ALL.some((p) => a.has(p))) throw forbidden(); ids = null; }
      else if (q.scope === 'team') ids = a.user.employeeId && a.has('field_duty.team.read') ? await teamEmployeeIds(db, a.tenantId, a.user.employeeId) : [];
      else ids = a.user.employeeId ? [a.user.employeeId] : [];
      // `on` = covering that date; from/to = overlapping the period.
      const from = q.on ?? q.from ?? null; const to = q.on ?? q.to ?? null;
      const where = `f.tenant_id=$1 AND ($2::uuid[] IS NULL OR f.employee_id = ANY($2)) AND ($3::text IS NULL OR f.status=$3)
        AND ($4::date IS NULL OR f.end_date >= $4) AND ($5::date IS NULL OR f.start_date <= $5)`;
      const args = [a.tenantId, ids, q.status ?? null, from, to];
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM field_duty_requests f WHERE ${where}`, args)).rows[0]!.n);
      const reasonOk = reasonVisibleSql(await policyViewer(db, a.tenantId, a.user), 'e', 'f.status', q.scope === 'team' && a.has('field_duty.team.read') ? 'true' : 'false');
      const rows = (await db.query<{ reason_ok: boolean } & Record<string, unknown>>(`SELECT ${COLS}, ${reasonOk} AS reason_ok FROM ${FROM} WHERE ${where} ORDER BY f.start_date DESC, e.employee_code LIMIT ${q.pageSize} OFFSET ${offsetOf(q)}`, args)).rows
        .map(({ reason_ok, ...r }) => (reason_ok ? r : maskFields(r, ['reason'])));
      return { ...paged(rows, total, q), today: await orgToday(db, a.tenantId) };
    });
  });

  app.get('/requests/:id', { schema: { response: { 200: R.GetFieldDutyRequestsById200 }, params: IdParams } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      const d = await loadDuty(db, a, id);
      const decides = d.status === 'pending' && (
        (a.has('field_duty.team.read') && !!a.user.employeeId && (await teamEmployeeIds(db, a.tenantId, a.user.employeeId)).includes(d.employee_id))
        || !!(await db.query(`SELECT 1 FROM approval_requests r JOIN approval_steps s ON s.tenant_id=r.tenant_id AND s.request_id=r.id
            WHERE r.tenant_id=$1 AND r.entity_type='field_duty' AND r.entity_id=$2 AND s.approver_user_id=$3 AND r.status='pending'`, [a.tenantId, id, a.user.userId])).rowCount);
      const reasonOk = reasonVisibleSql(await policyViewer(db, a.tenantId, a.user), 'e', 'f.status', decides ? 'true' : 'false');
      // Whoever recorded it for someone else wrote the reason, and keeps reading it.
      const { reason_ok, ...row } = (await db.query<{ reason_ok: boolean } & Record<string, unknown>>(`SELECT ${COLS}, (${reasonOk} OR f.created_by=$3) AS reason_ok FROM ${FROM} WHERE f.tenant_id=$1 AND f.id=$2`, [a.tenantId, id, a.user.userId])).rows[0]!;
      return reason_ok ? row : maskFields(row, ['reason']);
    });
  });

  /** The employee (or whoever recorded it) takes back a request still awaiting approval. */
  app.post('/requests/:id/withdraw', { schema: { params: IdParams } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      const d = await loadDuty(db, a, id, true);
      if (d.employee_id !== a.user.employeeId && d.created_by !== a.user.userId) throw forbidden('Only the employee or whoever recorded it can withdraw this request');
      if (d.status !== 'pending') throw conflict(`This request is ${d.status}`);
      const r = (await db.query<{ id: string }>(`SELECT id FROM approval_requests WHERE tenant_id=$1 AND entity_type='field_duty' AND entity_id=$2 AND status='pending'`, [a.tenantId, id])).rows[0];
      if (r) await cancelRequest(db, a.tenantId, r.id, a.user.userId, { requestId: a.auditBase.requestId, ip: a.auditBase.ip }, { subjectMayWithdraw: d.employee_id === a.user.employeeId });
      else await db.query(`UPDATE field_duty_requests SET status='cancelled', cancelled_by=$3 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, a.user.userId]);
      await audit(db, { ...a.auditBase, action: 'field_duty.withdrawn', targetType: 'field_duty', targetId: id });
      return { ok: true };
    });
  });

  /**
   * Cancel approved field duty: the employee while it has not started; HR (field_duty.manage) at any time before the
   * dates are locked for payroll, never their own. Attendance for those dates is recalculated.
   */
  app.post('/requests/:id/cancel', { schema: { params: IdParams, body: RequestsCancelBody } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    const { reason } = RequestsCancelBody.parse(req.body);
    return a.tx(async (db) => {
      const d = await loadDuty(db, a, id, true);
      if (d.status !== 'approved') throw conflict(`Only approved field duty can be cancelled (this one is ${d.status})`);
      const own = d.employee_id === a.user.employeeId;
      if (own) {
        if (d.start_date <= await orgToday(db, a.tenantId)) throw conflict('Field duty that has started can be cancelled only by HR');
      } else if (!a.has('field_duty.manage')) throw forbidden();
      if ((await lockedDates(db, a.tenantId, d.start_date, d.end_date)).size) throw conflict('These dates are locked for payroll; the field duty cannot be cancelled');
      await db.query(`UPDATE field_duty_requests SET status='cancelled', cancelled_by=$3, cancel_reason=$4 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, a.user.userId, reason]);
      await recalc(db, a.tenantId, d);
      await audit(db, { ...a.auditBase, action: 'field_duty.cancelled', targetType: 'field_duty', targetId: id, metadata: { reason, startDate: d.start_date, endDate: d.end_date } });
      return { ok: true };
    });
  });

  /** After the duty: what was done. The employee (or HR) records it once the duty has started. */
  app.post('/requests/:id/report', { schema: { params: IdParams, body: RequestsReportBody } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    const b = RequestsReportBody.parse(req.body);
    return a.tx(async (db) => {
      const d = await loadDuty(db, a, id, true);
      if (d.employee_id !== a.user.employeeId && !a.has('field_duty.manage')) throw forbidden('Only the employee or HR can report on this field duty');
      if (d.status !== 'approved') throw conflict(`Only approved field duty can be reported on (this one is ${d.status})`);
      if (d.start_date > await orgToday(db, a.tenantId)) throw conflict('Report on field duty once it has started');
      if (b.outcome !== 'completed' && !b.note) throw badRequest('Say what was not done');
      await db.query(`UPDATE field_duty_requests SET outcome=$3, outcome_note=$4, reported_at=now() WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, b.outcome, b.note]);
      await audit(db, { ...a.auditBase, action: 'field_duty.reported', targetType: 'field_duty', targetId: id, metadata: { outcome: b.outcome } });
      return { ok: true };
    });
  });
}
