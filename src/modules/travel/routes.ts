import type { FastifyInstance } from 'fastify';
import * as R from '../../core/http/responses.js';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { tenantActor, tenantActorAny, gateFeatures, type TenantActor } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { IsoDate, PageQuery, offsetOf, paged, Uuid } from '../../core/http/pagination.js';
import { buildSteps, createApprovalRequest, registerApprovalHandler, cancelRequest } from '../../core/workflow/engine.js';
import { getSettingValue } from '../../core/settings/service.js';
import { notifyUsers } from '../../core/notify/service.js';
import { lockedDates, recalculateRange, teamEmployeeIds } from '../attendance/service.js';
import { addDays, daysBetween } from '../attendance/time.js';
import { orgToday } from '../competency/service.js';
import { featureOn } from '../lifecycle/service.js';
import { assertNoOverlap } from '../field-duty/service.js';
import { MODES, settlement } from './service.js';
import type { Db } from '../../db/tx.js';
import { money } from '../../core/brand.js';

const F = 'travel';
const READ_ALL = ['travel.read', 'travel.approve', 'expenses.pay'];
interface Trip {
  id: string;
  employee_id: string;
  status: string;
  start_date: string;
  end_date: string;
  destination: string;
  origin: string;
  purpose: string;
  project: string | null;
  advance_requested: string;
  advance_paid_amount: string | null;
  user_id: string | null;
  created_by: string;
  name: string;
  mark_on_duty: boolean;
}

const Money = z
  .union([z.number(), z.string()])
  .default(0)
  .transform((v, ctx) => {
    const d = new Decimal(v || 0);
    if (!d.isFinite() || d.lt(0) || d.decimalPlaces() > 2 || d.gt('9999999999.99')) {
      ctx.addIssue({ code: 'custom', message: 'Enter an amount of 0 or more with up to 2 decimals' });
      return z.NEVER;
    }
    return d;
  });
const Body = z.object({
  purpose: z.string().trim().min(3).max(1000),
  tripType: z.enum(['domestic', 'international']).default('domestic'),
  origin: z.string().trim().min(2).max(120),
  destination: z.string().trim().min(2).max(200),
  startDate: IsoDate,
  endDate: IsoDate,
  travelMode: z.enum(MODES),
  accommodation: z.boolean().default(false),
  project: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => v || null),
  estimate: z
    .object({ travel: Money, stay: Money, local: Money, meals: Money, other: Money })
    .default({ travel: new Decimal(0), stay: new Decimal(0), local: new Decimal(0), meals: new Decimal(0), other: new Decimal(0) }),
  advance: Money,
  markOnDuty: z.boolean().default(true),
});

const COLS = `t.id, t.employee_id, t.purpose, t.trip_type, t.origin, t.destination, t.start_date::text, t.end_date::text, t.travel_mode, t.accommodation, t.project,
  t.estimate_travel, t.estimate_stay, t.estimate_local, t.estimate_meals, t.estimate_other, t.estimate_total, t.advance_requested, t.mark_on_duty, t.on_duty_note,
  t.status, t.advance_paid_amount, t.advance_paid_at, t.advance_reference, t.recovered_amount, t.recovered_note, t.created_at, t.decided_at, t.completed_at, t.closed_at, t.cancel_reason,
  e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, dp.name AS department,
  (SELECT ar.id FROM approval_requests ar WHERE ar.tenant_id=t.tenant_id AND ar.entity_type='travel_request' AND ar.entity_id=t.id ORDER BY ar.created_at DESC LIMIT 1) AS approval_request_id,
  (SELECT f.id FROM field_duty_requests f WHERE f.tenant_id=t.tenant_id AND f.travel_request_id=t.id AND f.status='approved' LIMIT 1) AS field_duty_id`;
const FROM = `travel_requests t JOIN employees e ON e.tenant_id=t.tenant_id AND e.id=t.employee_id LEFT JOIN departments dp ON dp.tenant_id=e.tenant_id AND dp.id=e.department_id`;

/** The traveller, their reporting chain, travel readers and finance, or an approver of the request. */
async function loadTrip(db: Db, a: TenantActor, id: string, lock = false): Promise<Trip> {
  const t = (
    await db.query<Trip>(
      `SELECT t.id, t.employee_id, t.status, t.start_date::text, t.end_date::text, t.destination, t.origin, t.purpose, t.project, t.advance_requested,
      t.advance_paid_amount, t.created_by, t.mark_on_duty, e.user_id, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name
     FROM travel_requests t JOIN employees e ON e.tenant_id=t.tenant_id AND e.id=t.employee_id WHERE t.tenant_id=$1 AND t.id=$2${lock ? ' FOR UPDATE OF t' : ''}`,
      [a.tenantId, id],
    )
  ).rows[0];
  if (!t) throw notFound('Trip not found');
  if (t.employee_id === a.user.employeeId || READ_ALL.some((p) => a.has(p))) return t;
  if (a.has('travel.team.read') && a.user.employeeId && (await teamEmployeeIds(db, a.tenantId, a.user.employeeId)).includes(t.employee_id)) return t;
  const r = await db.query(
    `SELECT 1 FROM approval_requests r JOIN approval_steps s ON s.tenant_id=r.tenant_id AND s.request_id=r.id
    WHERE r.tenant_id=$1 AND r.entity_type='travel_request' AND r.entity_id=$2 AND (s.approver_user_id=$3 OR s.acted_by=$3)`,
    [a.tenantId, id, a.user.userId],
  );
  if (r.rowCount) return t;
  throw notFound('Trip not found');
}

/** Days of a trip that have begun are recalculated; later ones as each day closes. */
async function recalcTrip(db: Db, tenantId: string, t: { employee_id: string; start_date: string; end_date: string }) {
  const today = await orgToday(db, tenantId);
  if (t.start_date <= today) await recalculateRange(db, tenantId, t.employee_id, t.start_date, t.end_date < today ? t.end_date : today);
}

/** An approved trip becomes field duty (official work at the destination), unless something else already covers those days. */
async function recordOnDuty(db: Db, tenantId: string, tripId: string) {
  const t = (
    await db.query<{ employee_id: string; start_date: string; end_date: string; destination: string; purpose: string; mark_on_duty: boolean; created_by: string }>(
      `SELECT employee_id, start_date::text, end_date::text, destination, purpose, mark_on_duty, created_by FROM travel_requests WHERE tenant_id=$1 AND id=$2`,
      [tenantId, tripId],
    )
  ).rows[0]!;
  if (!t.mark_on_duty) return;
  let note: string | null = null;
  if (!(await featureOn(db, tenantId, 'field_duty'))) note = 'Field duty is not in use';
  else if ((await lockedDates(db, tenantId, t.start_date, t.end_date)).size) note = 'Some dates are locked for payroll';
  else {
    try {
      await assertNoOverlap(db, tenantId, t.employee_id, { startDate: t.start_date, endDate: t.end_date, dayPart: 'full' });
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      note = `Not recorded as field duty: ${e.message}`;
    }
  }
  if (note) {
    await db.query(`UPDATE travel_requests SET on_duty_note=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, tripId, note]);
    return;
  }
  await db.query(
    `INSERT INTO field_duty_requests (tenant_id, employee_id, start_date, end_date, purpose, place, reference, reason, status, created_by, decided_at, travel_request_id)
    VALUES ($1,$2,$3,$4,'official_work',$5,'Travel',$6,'approved',$7,now(),$8)`,
    [tenantId, t.employee_id, t.start_date, t.end_date, t.destination.slice(0, 200), t.purpose.slice(0, 1000), t.created_by, tripId],
  );
  await recalcTrip(db, tenantId, t);
}

/** Cancel the field duty an approved trip created (left alone where payroll has locked the dates). */
async function releaseOnDuty(db: Db, tenantId: string, tripId: string, actorId: string) {
  const f = (
    await db.query<{ id: string; employee_id: string; start_date: string; end_date: string }>(
      `SELECT id, employee_id, start_date::text, end_date::text FROM field_duty_requests
    WHERE tenant_id=$1 AND travel_request_id=$2 AND status='approved'`,
      [tenantId, tripId],
    )
  ).rows;
  for (const d of f) {
    if ((await lockedDates(db, tenantId, d.start_date, d.end_date)).size) continue;
    await db.query(`UPDATE field_duty_requests SET status='cancelled', cancelled_by=$3, cancel_reason='Trip cancelled' WHERE tenant_id=$1 AND id=$2`, [tenantId, d.id, actorId]);
    await recalcTrip(db, tenantId, d);
  }
}

/** Approval effects. Registered once at startup (core/runtime), whether or not the module's routes are. */
export function registerTravelApprovals() {
  registerApprovalHandler('travel_request', {
    feature: F,
    label: 'Travel request',
    requesterLink: '/travel',
    async onApproved(db, tenantId, id) {
      const r = await db.query(`UPDATE travel_requests SET status='approved', decided_at=now() WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [tenantId, id]);
      if (!r.rowCount) throw conflict('This travel request is no longer pending');
      await recordOnDuty(db, tenantId, id);
    },
    async onRejected(db, tenantId, id, actorId, status) {
      await db.query(
        `UPDATE travel_requests SET status=$3, decided_at=now(), cancelled_by=CASE WHEN $3='cancelled' THEN $4::uuid END
        WHERE tenant_id=$1 AND id=$2 AND status='pending'`,
        [tenantId, id, status, actorId],
      );
    },
  });
}

const RequestsQuery = PageQuery.extend({
  scope: z.enum(['mine', 'team', 'all']).default('mine'),
  status: z.enum(['pending', 'approved', 'rejected', 'returned', 'cancelled', 'completed', 'closed']).optional(),
  advance: z.enum(['to_pay', 'outstanding']).optional(),
  on: IsoDate.optional(),
});
const IdParams = z.object({ id: Uuid });
const RequestsCancelBody = z.object({ reason: z.string().trim().min(3).max(500) });
const RequestsAdvancePaidBody = z.object({ reference: z.string().trim().min(3).max(100) });
const RequestsAdvanceReturnedBody = z.object({ amount: z.union([z.number(), z.string()]).transform((v) => new Decimal(v)), note: z.string().trim().min(3).max(300) });
export async function travelRoutes(app: FastifyInstance) {
  gateFeatures(app, F);

  /** A trip's rules, and its approval from the start. A new trip, or a returned one sent again in place: its old approval stays as history. */
  const submitTrip = async (db: Db, a: TenantActor, b: z.output<typeof Body>, empId: string, existingId: string | null) => {
    if (b.endDate < b.startDate) throw badRequest('The return date is before the start date');
    const est = b.estimate;
    const total = est.travel.plus(est.stay).plus(est.local).plus(est.meals).plus(est.other);
    const today = await orgToday(db, a.tenantId);
    const notice = await getSettingValue<number>(db, a.tenantId, 'travel.min_notice_days');
    const maxDays = await getSettingValue<number>(db, a.tenantId, 'travel.max_days');
    const maxPct = await getSettingValue<number>(db, a.tenantId, 'travel.max_advance_percent');
    const threshold = await getSettingValue<number | null>(db, a.tenantId, 'travel.finance_approval_above');
    if (b.startDate < addDays(today, notice)) throw badRequest(notice ? `Request travel at least ${notice} day(s) before it starts` : 'Travel cannot be requested for past dates');
    if (daysBetween(b.startDate, b.endDate) + 1 > maxDays) throw badRequest(`A trip can last at most ${maxDays} days; split longer travel`);
    if (b.advance.gt(total.times(maxPct).div(100))) throw badRequest(`The advance can be at most ${maxPct}% of the estimate (${money(total.times(maxPct).div(100))})`);
    if (b.advance.gt(0) && total.lte(0)) throw badRequest('Enter the estimated costs to ask for an advance');
    const e = (
      await db.query<{ status: string; name: string; user_id: string | null; mgr_user: string | null; exit_date: string | null }>(
        `SELECT e.status, e.user_id, e.exit_date::text, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, CASE WHEN m.status IN ('active','on_notice') THEN m.user_id END AS mgr_user
       FROM employees e LEFT JOIN employees m ON m.tenant_id=e.tenant_id AND m.id=e.reporting_manager_id WHERE e.tenant_id=$1 AND e.id=$2`,
        [a.tenantId, empId],
      )
    ).rows[0]!;
    if (e.exit_date && b.endDate > e.exit_date) throw badRequest('The trip ends after your last working day');
    const overlap = await db.query<{ start_date: string; end_date: string; status: string }>(
      `SELECT start_date::text, end_date::text, status FROM travel_requests
      WHERE tenant_id=$1 AND employee_id=$2 AND status IN ('pending','approved') AND start_date <= $4 AND end_date >= $3`,
      [a.tenantId, empId, b.startDate, b.endDate],
    );
    if (overlap.rowCount) throw conflict(`Overlaps a ${overlap.rows[0]!.status} trip (${overlap.rows[0]!.start_date} to ${overlap.rows[0]!.end_date})`);
    if (existingId) {
      await db.query(
        `UPDATE travel_requests SET purpose=$3, trip_type=$4, origin=$5, destination=$6, start_date=$7, end_date=$8, travel_mode=$9, accommodation=$10, project=$11,
          estimate_travel=$12, estimate_stay=$13, estimate_local=$14, estimate_meals=$15, estimate_other=$16, advance_requested=$17, mark_on_duty=$18, status='pending', decided_at=NULL
        WHERE tenant_id=$1 AND id=$2 AND status='returned'`,
        [
          a.tenantId,
          existingId,
          b.purpose,
          b.tripType,
          b.origin,
          b.destination,
          b.startDate,
          b.endDate,
          b.travelMode,
          b.accommodation,
          b.project,
          est.travel.toFixed(2),
          est.stay.toFixed(2),
          est.local.toFixed(2),
          est.meals.toFixed(2),
          est.other.toFixed(2),
          b.advance.toFixed(2),
          b.markOnDuty,
        ],
      );
    }
    const id =
      existingId ??
      (
        await db.query<{ id: string }>(
          `INSERT INTO travel_requests (tenant_id, employee_id, purpose, trip_type, origin, destination, start_date, end_date, travel_mode, accommodation, project,
        estimate_travel, estimate_stay, estimate_local, estimate_meals, estimate_other, advance_requested, mark_on_duty, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
          [
            a.tenantId,
            empId,
            b.purpose,
            b.tripType,
            b.origin,
            b.destination,
            b.startDate,
            b.endDate,
            b.travelMode,
            b.accommodation,
            b.project,
            est.travel.toFixed(2),
            est.stay.toFixed(2),
            est.local.toFixed(2),
            est.meals.toFixed(2),
            est.other.toFixed(2),
            b.advance.toFixed(2),
            b.markOnDuty,
            a.user.userId,
          ],
        )
      ).rows[0]!.id;
    // The manager approves the trip; finance too when money goes out before it (an advance), it goes abroad, or the estimate is large.
    const mgr = e.mgr_user && e.mgr_user !== a.user.userId ? e.mgr_user : null;
    const finance = !mgr || b.advance.gt(0) || b.tripType === 'international' || (threshold != null && total.gte(threshold));
    const steps = buildSteps({ requesterId: a.user.userId, managerUserId: mgr, then: finance ? ['travel.approve'] : [] });
    const days = daysBetween(b.startDate, b.endDate) + 1;
    const approvalId = await createApprovalRequest(db, a.tenantId, {
      entityType: 'travel_request',
      entityId: id,
      requesterId: a.user.userId,
      summary: `${e.name}: ${b.origin} → ${b.destination}, ${b.startDate}${days > 1 ? ` to ${b.endDate}` : ''}${b.advance.gt(0) ? ', with an advance' : ''}`,
      steps,
      excludeUserIds: [a.user.userId],
    });
    await audit(db, {
      ...a.auditBase,
      action: existingId ? 'travel.resubmitted' : 'travel.requested',
      targetType: 'travel_request',
      targetId: id,
      metadata: { startDate: b.startDate, endDate: b.endDate, tripType: b.tripType, estimate: total.toFixed(2), advance: b.advance.toFixed(2), approvalId },
    });
    return id;
  };

  app.post('/requests', { schema: { body: Body }, config: { perm: ['travel.self'] } }, async (req, reply) => {
    const a = tenantActor(req, 'travel.self');
    const b = Body.parse(req.body);
    const empId = a.user.employeeId;
    if (!empId) throw badRequest('Your account is not linked to an employee record');
    return a.tx(async (db) => {
      const id = await submitTrip(db, a, b, empId, null);
      reply.code(201);
      return { id };
    });
  });

  /** A trip sent back for changes: the traveller corrects it and it goes round again, as a new approval. */
  app.post('/requests/:id/resubmit', { schema: { params: IdParams, body: Body }, config: { perm: ['travel.self'] } }, async (req) => {
    const a = tenantActor(req, 'travel.self');
    const { id } = IdParams.parse(req.params);
    const b = Body.parse(req.body);
    return a.tx(async (db) => {
      const t = await loadTrip(db, a, id, true);
      if (t.employee_id !== a.user.employeeId) throw forbidden('Only the traveller can send this again');
      if (t.status !== 'returned') throw conflict(`This request is ${t.status}`);
      await submitTrip(db, a, b, t.employee_id, id);
      return { ok: true };
    });
  });

  app.get(
    '/requests',
    { schema: { response: { 200: R.GetTravelRequests200 }, querystring: RequestsQuery }, config: { permAny: ['travel.self', 'travel.team.read'] } },
    async (req) => {
      const a = tenantActorAny(req, 'travel.self', 'travel.team.read', ...READ_ALL);
      const q = RequestsQuery.parse(req.query);
      return a.tx(async (db) => {
        let ids: string[] | null;
        if (q.scope === 'all') {
          if (!READ_ALL.some((p) => a.has(p))) throw forbidden();
          ids = null;
        } else if (q.scope === 'team') ids = a.user.employeeId && a.has('travel.team.read') ? await teamEmployeeIds(db, a.tenantId, a.user.employeeId) : [];
        else ids = a.user.employeeId ? [a.user.employeeId] : [];
        // to_pay: approved advances not yet paid. outstanding: advance paid, not yet closed.
        const where = `t.tenant_id=$1 AND ($2::uuid[] IS NULL OR t.employee_id = ANY($2)) AND ($3::text IS NULL OR t.status=$3) AND ($4::date IS NULL OR (t.start_date <= $4 AND t.end_date >= $4))
        AND ($5::text IS NULL OR ($5='to_pay' AND t.status IN ('approved','completed') AND t.advance_requested > 0 AND t.advance_paid_at IS NULL)
          OR ($5='outstanding' AND t.advance_paid_at IS NOT NULL AND t.status <> 'closed'))`;
        const args = [a.tenantId, ids, q.status ?? null, q.on ?? null, q.advance ?? null];
        const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM travel_requests t WHERE ${where}`, args)).rows[0]!.n);
        const rows = (await db.query(`SELECT ${COLS} FROM ${FROM} WHERE ${where} ORDER BY t.start_date DESC, e.employee_code LIMIT ${q.pageSize} OFFSET ${offsetOf(q)}`, args))
          .rows;
        return { ...paged(rows, total, q), today: await orgToday(db, a.tenantId) };
      });
    },
  );

  app.get('/requests/:id', { schema: { response: { 200: R.GetTravelRequestsById200 }, params: IdParams } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      await loadTrip(db, a, id);
      const trip = (await db.query(`SELECT ${COLS} FROM ${FROM} WHERE t.tenant_id=$1 AND t.id=$2`, [a.tenantId, id])).rows[0];
      return { ...trip, settlement: await settlement(db, a.tenantId, id) };
    });
  });

  app.post('/requests/:id/withdraw', { schema: { params: IdParams }, config: { perm: ['travel.self'] } }, async (req) => {
    const a = tenantActor(req, 'travel.self');
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      const t = await loadTrip(db, a, id, true);
      if (t.employee_id !== a.user.employeeId) throw forbidden('Only the traveller can withdraw this request');
      if (t.status !== 'pending') throw conflict(`This request is ${t.status}`);
      const r = (
        await db.query<{ id: string }>(`SELECT id FROM approval_requests WHERE tenant_id=$1 AND entity_type='travel_request' AND entity_id=$2 AND status='pending'`, [
          a.tenantId,
          id,
        ])
      ).rows[0];
      if (r) await cancelRequest(db, a.tenantId, r.id, a.user.userId, { requestId: a.auditBase.requestId, ip: a.auditBase.ip });
      else await db.query(`UPDATE travel_requests SET status='cancelled', cancelled_by=$3 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, a.user.userId]);
      await audit(db, { ...a.auditBase, action: 'travel.withdrawn', targetType: 'travel_request', targetId: id });
      return { ok: true };
    });
  });

  /**
   * Cancel an approved trip: the traveller before it starts, finance (travel.approve) until it is completed.
   * Its field duty is cancelled; a paid advance stays outstanding until it is returned.
   */
  app.post('/requests/:id/cancel', { schema: { params: IdParams, body: RequestsCancelBody } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    const { reason } = RequestsCancelBody.parse(req.body);
    return a.tx(async (db) => {
      const t = await loadTrip(db, a, id, true);
      if (t.status !== 'approved') throw conflict(`Only an approved trip can be cancelled (this one is ${t.status})`);
      if (t.employee_id === a.user.employeeId) {
        if (t.start_date <= (await orgToday(db, a.tenantId))) throw conflict('A trip that has started can be cancelled only by finance');
      } else if (!a.has('travel.approve')) throw forbidden();
      await db.query(`UPDATE travel_requests SET status='cancelled', cancelled_by=$3, cancel_reason=$4 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, a.user.userId, reason]);
      await releaseOnDuty(db, a.tenantId, id, a.user.userId);
      await audit(db, { ...a.auditBase, action: 'travel.cancelled', targetType: 'travel_request', targetId: id, metadata: { reason, advancePaid: t.advance_paid_amount } });
      return { ok: true, advanceOutstanding: t.advance_paid_amount };
    });
  });

  /** Finance records the advance as paid (bank transfer / cash). Never by the traveller. */
  app.post('/requests/:id/advance-paid', { schema: { params: IdParams, body: RequestsAdvancePaidBody }, config: { perm: ['expenses.pay'] } }, async (req) => {
    const a = tenantActor(req, 'expenses.pay');
    const { id } = IdParams.parse(req.params);
    const b = RequestsAdvancePaidBody.parse(req.body);
    return a.tx(async (db) => {
      const t = await loadTrip(db, a, id, true);
      if (t.employee_id === a.user.employeeId) throw forbidden('You cannot pay your own travel advance');
      if (!['approved', 'completed'].includes(t.status)) throw conflict(`The trip is ${t.status}`);
      if (new Decimal(t.advance_requested).lte(0)) throw conflict('No advance was requested for this trip');
      if (t.advance_paid_amount) throw conflict('The advance is already recorded as paid');
      await db.query(
        `UPDATE travel_requests SET advance_paid_amount=advance_requested, advance_paid_at=now(), advance_paid_by=$3, advance_reference=$4 WHERE tenant_id=$1 AND id=$2`,
        [a.tenantId, id, a.user.userId, b.reference],
      );
      if (t.user_id)
        await notifyUsers(db, a.tenantId, [t.user_id], {
          kind: 'travel.advance_paid',
          title: 'Travel advance paid',
          body: `${t.origin} → ${t.destination} · reference ${b.reference}`,
          link: '/travel',
        });
      await audit(db, {
        ...a.auditBase,
        action: 'travel.advance_paid',
        targetType: 'travel_request',
        targetId: id,
        metadata: { amount: t.advance_requested, reference: b.reference },
      });
      return { ok: true };
    });
  });

  /** Back from the trip. */
  app.post('/requests/:id/complete', { schema: { params: IdParams }, config: { perm: ['travel.self'] } }, async (req) => {
    const a = tenantActor(req, 'travel.self');
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      const t = await loadTrip(db, a, id, true);
      if (t.employee_id !== a.user.employeeId) throw forbidden('Only the traveller can mark the trip completed');
      if (t.status !== 'approved') throw conflict(`The trip is ${t.status}`);
      if (t.start_date > (await orgToday(db, a.tenantId))) throw conflict('The trip has not started yet');
      await db.query(`UPDATE travel_requests SET status='completed', completed_at=now() WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      await audit(db, { ...a.auditBase, action: 'travel.completed', targetType: 'travel_request', targetId: id });
      return { ok: true };
    });
  });

  /** Start the trip's expense claim (a draft in Expenses, linked to the trip so the advance is set off against it). */
  app.post('/requests/:id/claim', { schema: { params: IdParams }, config: { perm: ['travel.self', 'expenses.self'] } }, async (req, reply) => {
    const a = tenantActor(req, 'travel.self', 'expenses.self');
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      const t = await loadTrip(db, a, id, true);
      if (t.employee_id !== a.user.employeeId) throw forbidden('Only the traveller can claim the trip expenses');
      if (!['approved', 'completed'].includes(t.status)) throw conflict(`The trip is ${t.status}`);
      if (!(await featureOn(db, a.tenantId, 'expenses'))) throw conflict('Expenses are not in use');
      const open = (
        await db.query<{ id: string }>(`SELECT id FROM expense_claims WHERE tenant_id=$1 AND travel_request_id=$2 AND status IN ('draft','returned')`, [a.tenantId, id])
      ).rows[0];
      if (open) return { id: open.id, existing: true };
      const when = t.start_date === t.end_date ? t.start_date : `${t.start_date} to ${t.end_date}`;
      const cid = (
        await db.query<{ id: string }>(
          `INSERT INTO expense_claims (tenant_id, employee_id, title, purpose, project, created_by, travel_request_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [a.tenantId, t.employee_id, `Travel: ${t.origin} → ${t.destination} (${when})`.slice(0, 200), t.purpose, t.project, a.user.userId, id],
        )
      ).rows[0]!.id;
      await audit(db, { ...a.auditBase, action: 'travel.claim_started', targetType: 'travel_request', targetId: id, metadata: { claimId: cid } });
      reply.code(201);
      return { id: cid, existing: false };
    });
  });

  /** Unspent advance returned by the employee (cash or transfer). Recovery through payroll belongs to advances and loans. */
  app.post('/requests/:id/advance-returned', { schema: { params: IdParams, body: RequestsAdvanceReturnedBody }, config: { perm: ['expenses.pay'] } }, async (req) => {
    const a = tenantActor(req, 'expenses.pay');
    const { id } = IdParams.parse(req.params);
    const b = RequestsAdvanceReturnedBody.parse(req.body);
    return a.tx(async (db) => {
      const t = await loadTrip(db, a, id, true);
      if (t.employee_id === a.user.employeeId) throw forbidden('You cannot record your own advance as returned');
      const s = await settlement(db, a.tenantId, id);
      if (!b.amount.isFinite() || b.amount.lte(0) || b.amount.decimalPlaces() > 2) throw badRequest('Enter the amount returned');
      if (b.amount.gt(s.outstanding)) throw badRequest('That is more of the advance than is outstanding');
      await db.query(`UPDATE travel_requests SET recovered_amount=recovered_amount+$3, recovered_note=concat_ws('; ', recovered_note, $4::text) WHERE tenant_id=$1 AND id=$2`, [
        a.tenantId,
        id,
        b.amount.toFixed(2),
        `${money(b.amount)}: ${b.note}`,
      ]);
      await audit(db, { ...a.auditBase, action: 'travel.advance_returned', targetType: 'travel_request', targetId: id, metadata: { amount: b.amount.toFixed(2), note: b.note } });
      return { ok: true, outstanding: new Decimal(s.outstanding).minus(b.amount).toFixed(2) };
    });
  });

  /** Finance closes a settled trip: nothing outstanding, no claim still in progress. */
  app.post('/requests/:id/close', { schema: { params: IdParams }, config: { perm: ['expenses.pay'] } }, async (req) => {
    const a = tenantActor(req, 'expenses.pay');
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      const t = await loadTrip(db, a, id, true);
      if (t.status !== 'completed') throw conflict('Close a trip once the traveller has marked it completed');
      const s = await settlement(db, a.tenantId, id);
      if (new Decimal(s.outstanding).gt(0)) throw conflict('Part of the advance is still outstanding');
      if (s.openClaims) throw conflict('A claim for this trip is still in progress');
      await db.query(`UPDATE travel_requests SET status='closed', closed_at=now(), closed_by=$3 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, a.user.userId]);
      await audit(db, {
        ...a.auditBase,
        action: 'travel.closed',
        targetType: 'travel_request',
        targetId: id,
        metadata: { advancePaid: s.advancePaid, claimed: s.claimed, advanceAdjusted: s.advanceAdjusted, recovered: s.recovered },
      });
      return { ok: true };
    });
  });
}
