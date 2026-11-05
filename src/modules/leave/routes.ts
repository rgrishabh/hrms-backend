import type { FastifyInstance } from 'fastify';
import * as R from '../../core/http/responses.js';
import { z } from 'zod';
import { l3RowFilter, maskFields, policyViewer } from '../../core/policy/salary.js';
import { Decimal } from 'decimal.js';
import { tenantActor, tenantActorAny, requireFeature, type TenantActor, gateFeatures } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { IsoDate, PageQuery, offsetOf, paged, Uuid, QueryBool } from '../../core/http/pagination.js';
import { buildSteps, createApprovalRequest, registerApprovalHandler } from '../../core/workflow/engine.js';
import { orgToday } from '../../core/workflow/engine.js';
import type { Db } from '../../db/tx.js';
import { EMPLOYMENT_TYPES } from '../employees/service.js';
import { lockedDates, recalculateRange, teamEmployeeIds, employeeTimezone } from '../attendance/service.js';
import { localDate, daysBetween, addDays } from '../attendance/time.js';
import {
  LEAVE_TYPE_COLS,
  type LeaveType,
  type StartHalf,
  type EndHalf,
  leaveYearOf,
  leaveYearBounds,
  yearStartMonth,
  loadEmployee,
  nonWorkingDates,
  countDays,
  balanceOf,
  assertApplicable,
  yearClosed,
} from './service.js';
import { runAccruals, runYearEnd, insertLedgerEntry } from './jobs.js';

const Days = z.number().multipleOf(0.5).min(0).max(366);
const LeaveTypeBody = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z][A-Z0-9_]{0,9}$/, '1–10 letters/digits, starting with a letter'),
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(500).nullable().optional(),
    paid: z.boolean().default(true),
    allowHalfDay: z.boolean().default(true),
    requiresBalance: z.boolean().default(true),
    accrualMethod: z.enum(['none', 'annual', 'monthly']).default('annual'),
    annualEntitlement: Days.default(0),
    carryForwardMax: Days.default(0),
    maxBalance: Days.nullable().default(null),
    countNonWorkingDays: z.boolean().default(false),
    minNoticeDays: z.number().int().min(0).max(365).default(0),
    maxConsecutiveDays: z.number().min(0.5).max(366).nullable().default(null),
    eligibleAfterDays: z.number().int().min(0).max(3650).default(0),
    applicableEmploymentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).default([]),
    status: z.enum(['active', 'inactive']).default('active'),
  })
  .refine((t) => t.requiresBalance || t.accrualMethod === 'none', { message: 'Types without a balance (e.g. leave without pay) cannot accrue', path: ['accrualMethod'] });

const RequestBody = z.object({
  leaveTypeId: Uuid,
  startDate: IsoDate,
  endDate: IsoDate,
  startHalf: z.enum(['full', 'second_half']).default('full'),
  endHalf: z.enum(['full', 'first_half']).default('full'),
  reason: z.string().trim().min(3).max(1000).optional(),
  employeeId: Uuid.optional(), // HR applying on someone's behalf (leave.manage)
});

/** Self, reporting chain (leave.team.read) or everyone (leave.read). */
async function assertCanView(db: Db, a: TenantActor, employeeId: string) {
  if (a.user.employeeId === employeeId || a.has('leave.read') || a.has('leave.manage')) return;
  if (a.has('leave.team.read') && a.user.employeeId && (await teamEmployeeIds(db, a.tenantId, a.user.employeeId)).includes(employeeId)) return;
  throw forbidden();
}

const lockEmployeeLeave = (db: Db, tenantId: string, employeeId: string) =>
  db.query('SELECT 1 FROM employees WHERE tenant_id=$1 AND id=$2 FOR NO KEY UPDATE', [tenantId, employeeId]);

async function loadType(db: Db, tenantId: string, id: string) {
  const t = (await db.query<LeaveType>(`SELECT ${LEAVE_TYPE_COLS} FROM leave_types WHERE tenant_id=$1 AND id=$2`, [tenantId, id])).rows[0];
  if (!t) throw notFound('Leave type not found');
  return t;
}

/** Shared validation for preview and submit. */
async function evaluateRequest(db: Db, a: TenantActor, body: z.infer<typeof RequestBody>, opts: { excludeRequestId?: string; lock?: boolean } = {}) {
  const employeeId = body.employeeId ?? a.user.employeeId;
  if (!employeeId) throw badRequest('Your account is not linked to an employee record');
  if (body.employeeId && body.employeeId !== a.user.employeeId && !a.has('leave.manage')) throw forbidden('You can only apply for your own leave');
  // Submissions and approvals for one employee take turns, so the balance each one checks is still true when it writes.
  if (opts.lock) await lockEmployeeLeave(db, a.tenantId, employeeId);
  const e = await loadEmployee(db, a.tenantId, employeeId);
  if (!e) throw notFound('Employee not found');
  if (!['active', 'on_notice'].includes(e.status)) throw badRequest('Leave can only be requested for active employees');
  const t = await loadType(db, a.tenantId, body.leaveTypeId);
  if (body.endDate < body.startDate) throw badRequest('End date must be on or after start date');
  assertApplicable(t, e, body.startDate);
  if (!t.allow_half_day && (body.startHalf !== 'full' || body.endHalf !== 'full')) throw badRequest(`${t.name} cannot be taken as half days`);
  if (body.startDate === body.endDate && body.startHalf !== 'full' && body.endHalf !== 'full') throw badRequest('Choose either the first or the second half for a single day');
  if (body.startDate < e.date_of_joining) throw badRequest('Leave cannot start before the date of joining');
  if (e.exit_date && body.endDate > e.exit_date) throw badRequest('Leave cannot extend beyond the exit date');
  const startMonth = await yearStartMonth(db, a.tenantId);
  const year = leaveYearOf(body.startDate, startMonth);
  if (leaveYearOf(body.endDate, startMonth) !== year) {
    const { end } = leaveYearBounds(year, startMonth);
    throw badRequest(`Leave cannot span two leave years. Apply up to ${end} and separately from ${addDays(end, 1)}.`);
  }
  // A closed year's days have moved on; spending them there would spend them twice. Unpaid leave has no balance to protect.
  if (t.requires_balance && (await yearClosed(db, a.tenantId, year))) throw conflict(`The ${year} leave year is closed; ${t.name} can no longer be taken in it`);
  const { tz } = await employeeTimezone(db, a.tenantId, e.id);
  const today = localDate(new Date(), tz);
  if (body.startDate >= today && t.min_notice_days > 0 && daysBetween(today, body.startDate) < t.min_notice_days && !a.has('leave.manage')) {
    throw badRequest(`${t.name} must be requested at least ${t.min_notice_days} day(s) in advance`);
  }
  const nonWorking = await nonWorkingDates(db, a.tenantId, e.branch_id, body.startDate, body.endDate, e.id);
  const { days, perDate } = countDays(body.startDate, body.endDate, body.startHalf as StartHalf, body.endHalf as EndHalf, nonWorking, t.count_non_working_days);
  if (days.isZero()) throw badRequest('The selected dates contain no working days');
  if (t.max_consecutive_days !== null && days.greaterThan(t.max_consecutive_days)) throw badRequest(`${t.name} allows at most ${t.max_consecutive_days} day(s) at a time`);
  if ((await lockedDates(db, a.tenantId, body.startDate, body.endDate)).size) throw conflict('These dates are in a period locked for payroll');
  // Half days are half-day slots: a morning and an afternoon of one date fit together.
  const sameDates = (
    await db.query<{ start_date: string; end_date: string; status: string; paid: boolean; clash: boolean }>(
      `SELECT r.start_date, r.end_date, r.status, lt.paid,
      leave_half_slots(r.start_date, r.start_half, r.end_date, r.end_half) && leave_half_slots($3::date, $6, $4::date, $7) AS clash
    FROM leave_requests r JOIN leave_types lt ON lt.tenant_id=r.tenant_id AND lt.id=r.leave_type_id
    WHERE r.tenant_id=$1 AND r.employee_id=$2 AND r.status IN ('pending','approved') AND r.start_date <= $4 AND r.end_date >= $3 AND ($5::uuid IS NULL OR r.id <> $5)`,
      [a.tenantId, e.id, body.startDate, body.endDate, opts.excludeRequestId ?? null, body.startHalf, body.endHalf],
    )
  ).rows;
  const overlap = sameDates.find((x) => x.clash);
  if (overlap) throw conflict(`Overlaps an existing ${overlap.status} leave (${overlap.start_date} to ${overlap.end_date})`);
  // Attendance keeps one leave type per date, so loss of pay could not tell a paid half from an unpaid one.
  if (sameDates.some((x) => x.paid !== t.paid)) throw conflict('A paid and an unpaid half day cannot share a date; apply for the whole day as one type');
  const bal = await balanceOf(db, a.tenantId, e.id, t.id, year, opts.excludeRequestId);
  const sufficient = !t.requires_balance || bal.available.greaterThanOrEqualTo(days);
  return { employee: e, type: t, year, days, perDate, balance: bal, sufficient };
}

/** Approval effects. Registered once at startup (core/runtime), whether or not the module's routes are. */
export function registerLeaveApprovals() {
  registerApprovalHandler('leave_request', {
    feature: 'leave',
    label: 'Leave request',
    requesterLink: '/leave',
    async onApproved(db, tenantId, requestId, actorId) {
      const r = (
        await db.query<{ employee_id: string; leave_type_id: string; leave_year: number; days: string; start_date: string; end_date: string; status: string }>(
          `SELECT employee_id, leave_type_id, leave_year, days, start_date, end_date, status FROM leave_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [tenantId, requestId],
        )
      ).rows[0];
      if (!r || r.status !== 'pending') throw conflict('Leave request is no longer pending');
      if ((await lockedDates(db, tenantId, r.start_date, r.end_date)).size) throw conflict('These dates are now locked for payroll; the request cannot be approved');
      const t = await loadType(db, tenantId, r.leave_type_id);
      if (t.requires_balance) {
        // Against the ledger, not less other pending requests: otherwise two that no longer both fit would block each other.
        await lockEmployeeLeave(db, tenantId, r.employee_id);
        const bal = await balanceOf(db, tenantId, r.employee_id, r.leave_type_id, r.leave_year, requestId);
        if (bal.balance.lessThan(r.days)) throw conflict(`Insufficient ${t.name} balance (${bal.balance.toFixed(1)} available, ${r.days} requested)`);
      }
      await insertLedgerEntry(db, tenantId, {
        empId: r.employee_id,
        typeId: r.leave_type_id,
        year: r.leave_year,
        entryType: 'consumption',
        days: new Decimal(r.days).neg(),
        reference: `request:${requestId}:consume`,
        requestId,
        note: `Leave ${r.start_date} to ${r.end_date}`,
        actorId,
      });
      await db.query(`UPDATE leave_requests SET status='approved', decided_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, requestId]);
      await recalculateRange(db, tenantId, r.employee_id, r.start_date, r.end_date);
    },
    async onRejected(db, tenantId, requestId, actorId, status) {
      await db.query(
        `UPDATE leave_requests SET status=$3, decided_at=now(), cancelled_at=CASE WHEN $3='cancelled' THEN now() END,
        cancelled_by=CASE WHEN $3='cancelled' THEN $4::uuid END WHERE tenant_id=$1 AND id=$2`,
        [tenantId, requestId, status, actorId],
      );
    },
  });
}

const TypesQuery = z.object({ includeInactive: QueryBool.optional() });
const IdParams = z.object({ id: Uuid });
const BalancesQuery = z.object({ employeeId: Uuid.optional(), year: z.coerce.number().int().min(2000).max(2100).optional() });
const LedgerQuery = z.object({ employeeId: Uuid, leaveTypeId: Uuid, year: z.coerce.number().int().min(2000).max(2100) });
const RequestsQuery = PageQuery.extend({
  scope: z.enum(['mine', 'team', 'all']).default('mine'),
  status: z.enum(['pending', 'approved', 'rejected', 'returned', 'cancelled']).optional(),
  employeeId: Uuid.optional(),
});
const RequestsCancelBody = z.object({ reason: z.string().trim().max(500).optional() });
const CalendarQuery = z
  .object({ from: IsoDate, to: IsoDate, branchId: Uuid.optional() })
  .refine((x) => x.from <= x.to && daysBetween(x.from, x.to) <= 92, 'Range must be 0–92 days');
const AccrualsBody = z.object({ leaveYear: z.number().int().min(2000).max(2100), throughMonth: z.number().int().min(1).max(12).default(12) });
const YearEndBody = z.object({ leaveYear: z.number().int().min(2000).max(2100) });
const AdjustmentsBody = z.object({
  employeeId: Uuid,
  leaveTypeId: Uuid,
  leaveYear: z.number().int().min(2000).max(2100),
  days: z
    .number()
    .multipleOf(0.5)
    .min(-366)
    .max(366)
    .refine((d) => d !== 0, 'Days cannot be zero'),
  entryType: z.enum(['adjustment', 'opening']).default('adjustment'),
  note: z.string().trim().min(5).max(500),
});
export async function leaveRoutes(app: FastifyInstance) {
  gateFeatures(app, 'leave');

  // ------------------------------------------------------------ types
  app.get(
    '/types',
    { schema: { response: { 200: R.GetLeaveTypes200 }, querystring: TypesQuery }, config: { permAny: ['leave.self', 'leave.manage', 'leave.read'], feature: ['leave'] } },
    async (req) => {
      const a = tenantActorAny(req, 'leave.self', 'leave.manage', 'leave.read');
      const q = TypesQuery.parse(req.query);
      return a.tx(async (db) => {
        await requireFeature(db, a.tenantId, 'leave');
        const all = q.includeInactive && a.has('leave.manage');
        return { items: (await db.query(`SELECT ${LEAVE_TYPE_COLS} FROM leave_types WHERE tenant_id=$1 AND ($2 OR status='active') ORDER BY code`, [a.tenantId, all])).rows };
      });
    },
  );

  const typeCols = (b: z.infer<typeof LeaveTypeBody>) => [
    b.code,
    b.name,
    b.description ?? null,
    b.paid,
    b.allowHalfDay,
    b.requiresBalance,
    b.accrualMethod,
    b.annualEntitlement,
    b.carryForwardMax,
    b.maxBalance,
    b.countNonWorkingDays,
    b.minNoticeDays,
    b.maxConsecutiveDays,
    b.eligibleAfterDays,
    b.applicableEmploymentTypes,
    b.status,
  ];
  const TYPE_FIELDS = `code, name, description, paid, allow_half_day, requires_balance, accrual_method, annual_entitlement, carry_forward_max, max_balance,
    count_non_working_days, min_notice_days, max_consecutive_days, eligible_after_days, applicable_employment_types, status`;

  app.post('/types', { schema: { body: LeaveTypeBody }, config: { perm: ['leave.manage'], feature: ['leave'] } }, async (req, reply) => {
    const a = tenantActor(req, 'leave.manage');
    const b = LeaveTypeBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'leave');
      const r = await db.query<{ id: string }>(
        `INSERT INTO leave_types (tenant_id, ${TYPE_FIELDS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [a.tenantId, ...typeCols(b)],
      );
      await audit(db, { ...a.auditBase, action: 'leave.type_created', category: 'configuration', targetType: 'leave_type', targetId: r.rows[0]!.id, metadata: b });
      reply.code(201);
      return { id: r.rows[0]!.id };
    });
  });

  app.put('/types/:id', { schema: { params: IdParams, body: LeaveTypeBody }, config: { perm: ['leave.manage'], feature: ['leave'] } }, async (req) => {
    const a = tenantActor(req, 'leave.manage');
    const { id } = IdParams.parse(req.params);
    const b = LeaveTypeBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'leave');
      const prev = await loadType(db, a.tenantId, id);
      await db.query(
        `UPDATE leave_types SET (${TYPE_FIELDS}) = ($3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18), version=version+1, updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,
        [a.tenantId, id, ...typeCols(b)],
      );
      // Policy changes apply to future requests and accruals; existing ledger entries are never rewritten.
      await audit(db, { ...a.auditBase, action: 'leave.type_updated', category: 'configuration', targetType: 'leave_type', targetId: id, metadata: { from: prev, to: b } });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ balances
  app.get(
    '/balances',
    {
      schema: { response: { 200: R.GetLeaveBalances200 }, querystring: BalancesQuery },
      config: { permAny: ['leave.self', 'leave.read', 'leave.team.read', 'leave.manage'], feature: ['leave'] },
    },
    async (req) => {
      const a = tenantActorAny(req, 'leave.self', 'leave.read', 'leave.team.read', 'leave.manage');
      const q = BalancesQuery.parse(req.query);
      return a.tx(async (db) => {
        await requireFeature(db, a.tenantId, 'leave');
        const employeeId = q.employeeId ?? a.user.employeeId;
        if (!employeeId) throw badRequest('Your account is not linked to an employee record');
        await assertCanView(db, a, employeeId);
        const e = await loadEmployee(db, a.tenantId, employeeId);
        if (!e) throw notFound('Employee not found');
        const startMonth = await yearStartMonth(db, a.tenantId);
        const { tz } = await employeeTimezone(db, a.tenantId, employeeId);
        const year = q.year ?? leaveYearOf(localDate(new Date(), tz), startMonth);
        const rows = await db.query(
          `SELECT t.id, t.code, t.name, t.paid, t.requires_balance, t.annual_entitlement, t.accrual_method, t.allow_half_day,
          coalesce((SELECT sum(days) FROM leave_ledger l WHERE l.tenant_id=t.tenant_id AND l.employee_id=$2 AND l.leave_type_id=t.id AND l.leave_year=$3),0)::text AS balance,
          coalesce((SELECT sum(days) FROM leave_requests r WHERE r.tenant_id=t.tenant_id AND r.employee_id=$2 AND r.leave_type_id=t.id AND r.leave_year=$3 AND r.status='pending'),0)::text AS pending,
          coalesce((SELECT -sum(days) FROM leave_ledger l WHERE l.tenant_id=t.tenant_id AND l.employee_id=$2 AND l.leave_type_id=t.id AND l.leave_year=$3 AND (l.entry_type='consumption' OR (l.entry_type='reversal' AND l.days > 0))),0)::text AS used
        FROM leave_types t WHERE t.tenant_id=$1 AND t.status='active'
          AND (cardinality(t.applicable_employment_types)=0 OR $4 = ANY(t.applicable_employment_types)) ORDER BY t.code`,
          [a.tenantId, employeeId, year, e.employment_type],
        );
        return {
          employeeId,
          leaveYear: year,
          period: leaveYearBounds(year, startMonth),
          items: rows.rows.map((r) => ({ ...r, available: new Decimal(r.balance).minus(r.pending).toFixed(2) })),
        };
      });
    },
  );

  app.get('/ledger', { schema: { querystring: LedgerQuery }, config: { permAny: ['leave.self', 'leave.read', 'leave.team.read', 'leave.manage'] } }, async (req) => {
    const a = tenantActorAny(req, 'leave.self', 'leave.read', 'leave.team.read', 'leave.manage');
    const q = LedgerQuery.parse(req.query);
    return a.tx(async (db) => {
      await assertCanView(db, a, q.employeeId);
      return {
        items: (
          await db.query(
            `SELECT l.id, l.entry_type, l.days, l.note, l.created_at, l.request_id, u.display_name AS created_by_name
        FROM leave_ledger l LEFT JOIN users u ON u.id=l.created_by WHERE l.tenant_id=$1 AND l.employee_id=$2 AND l.leave_type_id=$3 AND l.leave_year=$4
        ORDER BY l.created_at, l.id`,
            [a.tenantId, q.employeeId, q.leaveTypeId, q.year],
          )
        ).rows,
      };
    });
  });

  // ------------------------------------------------------------ requests
  app.post(
    '/requests/preview',
    { schema: { response: { 200: R.PostLeaveRequestsPreview200 }, body: RequestBody }, config: { permAny: ['leave.self', 'leave.manage'], feature: ['leave'] } },
    async (req) => {
      const a = tenantActorAny(req, 'leave.self', 'leave.manage');
      const body = RequestBody.parse(req.body);
      return a.tx(async (db) => {
        await requireFeature(db, a.tenantId, 'leave');
        const r = await evaluateRequest(db, a, body);
        return {
          days: r.days.toFixed(2),
          leaveYear: r.year,
          perDate: r.perDate,
          available: r.balance.available.toFixed(2),
          requiresBalance: r.type.requires_balance,
          sufficient: r.sufficient,
          paid: r.type.paid,
        };
      });
    },
  );

  app.post(
    '/requests',
    { schema: { response: { 201: R.PostLeaveRequests201 }, body: RequestBody }, config: { permAny: ['leave.self', 'leave.manage'], feature: ['leave'] } },
    async (req, reply) => {
      const a = tenantActorAny(req, 'leave.self', 'leave.manage');
      const body = RequestBody.parse(req.body);
      if (!body.reason) throw badRequest('Please give a reason');
      return a.tx(async (db) => {
        await requireFeature(db, a.tenantId, 'leave');
        const r = await evaluateRequest(db, a, body, { lock: true });
        if (!r.sufficient) throw conflict(`Insufficient ${r.type.name} balance: ${r.balance.available.toFixed(1)} day(s) available, ${r.days.toFixed(1)} requested`);
        const ins = await db.query<{ id: string }>(
          `INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id, leave_year, start_date, end_date, start_half, end_half,
          days, reason, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [a.tenantId, r.employee.id, r.type.id, r.year, body.startDate, body.endDate, body.startHalf, body.endHalf, r.days.toFixed(2), body.reason, a.user.userId],
        );
        const id = ins.rows[0]!.id;
        // Routing: the employee's reporting manager (if they have a login), else HR (leave.approve).
        const mgr = await db.query<{ user_id: string | null }>(
          `SELECT m.user_id FROM employees e JOIN employees m ON m.tenant_id=e.tenant_id AND m.id=e.reporting_manager_id
        WHERE e.tenant_id=$1 AND e.id=$2 AND m.status IN ('active','on_notice')`,
          [a.tenantId, r.employee.id],
        );
        const steps = buildSteps({ requesterId: a.user.userId, subjectUserId: r.employee.user_id, managerUserId: mgr.rows[0]?.user_id, ifNoManager: ['leave.approve'] });
        const reqId = await createApprovalRequest(db, a.tenantId, {
          entityType: 'leave_request',
          entityId: id,
          requesterId: a.user.userId,
          summary: `${r.type.name}: ${r.days.toFixed(1)} day(s), ${body.startDate}${body.endDate !== body.startDate ? ' to ' + body.endDate : ''}`,
          steps,
          excludeUserIds: [r.employee.user_id],
        }); // leave applied on someone's behalf is never approved by that person
        await audit(db, {
          ...a.auditBase,
          action: 'leave.requested',
          targetType: 'leave_request',
          targetId: id,
          metadata: {
            employeeId: r.employee.id,
            type: r.type.code,
            startDate: body.startDate,
            endDate: body.endDate,
            days: r.days.toFixed(2),
            onBehalf: !!body.employeeId && body.employeeId !== a.user.employeeId,
          },
        });
        reply.code(201);
        return { id, approvalRequestId: reqId, days: r.days.toFixed(2) };
      });
    },
  );

  app.get(
    '/requests',
    {
      schema: { response: { 200: R.GetLeaveRequests200 }, querystring: RequestsQuery },
      config: { permAny: ['leave.self', 'leave.read', 'leave.team.read', 'leave.manage'], feature: ['leave'] },
    },
    async (req) => {
      const a = tenantActorAny(req, 'leave.self', 'leave.read', 'leave.team.read', 'leave.manage');
      const q = RequestsQuery.parse(req.query);
      return a.tx(async (db) => {
        await requireFeature(db, a.tenantId, 'leave');
        let ids: string[] | null = null;
        if (q.scope === 'mine') ids = a.user.employeeId ? [a.user.employeeId] : [];
        else if (q.scope === 'team') ids = a.user.employeeId && a.has('leave.team.read') ? await teamEmployeeIds(db, a.tenantId, a.user.employeeId) : [];
        else if (!a.has('leave.read') && !a.has('leave.manage')) throw forbidden();
        const team = q.scope === 'team' ? ids : null;
        if (q.employeeId) {
          await assertCanView(db, a, q.employeeId);
          ids = [q.employeeId];
        }
        const params = [a.tenantId, ids, q.status ?? null];
        const where = `r.tenant_id=$1 AND ($2::uuid[] IS NULL OR r.employee_id = ANY($2)) AND ($3::text IS NULL OR r.status=$3)`;
        const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM leave_requests r WHERE ${where}`, params)).rows[0]!.n);
        const v = await policyViewer(db, a.tenantId, a.user);
        // The reason is L3: the employee and HR above them. A manager reads it while a request of their team waits for a decision, because deciding needs it.
        const reasonOk = `(${l3RowFilter(v, 'e')} OR (coalesce(r.employee_id = ANY($6::uuid[]), false) AND r.status='pending'))`;
        const rows = await db.query(
          `SELECT r.id, r.employee_id, e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, t.code AS type_code, t.name AS type_name,
          r.start_date, r.end_date, r.start_half, r.end_half, r.days, r.reason, ${reasonOk} AS reason_ok, r.status, r.created_at, r.decided_at, ar.id AS approval_request_id
        FROM leave_requests r JOIN employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id JOIN leave_types t ON t.tenant_id=r.tenant_id AND t.id=r.leave_type_id
        LEFT JOIN approval_requests ar ON ar.tenant_id=r.tenant_id AND ar.entity_type='leave_request' AND ar.entity_id=r.id
        WHERE ${where} ORDER BY r.start_date DESC, r.created_at DESC LIMIT $4 OFFSET $5`,
          [...params, q.pageSize, offsetOf(q), team],
        );
        return paged(
          rows.rows.map(({ reason_ok, ...r }) => (reason_ok ? r : maskFields(r, ['reason']))),
          total,
          q,
        );
      });
    },
  );

  /**
   * Cancel. Pending: the requester or leave.manage. Approved: the requester before the
   * leave starts, or leave.manage at any time — the consumed days are reversed in the
   * ledger. Never for dates locked for payroll.
   */
  app.post(
    '/requests/:id/cancel',
    { schema: { response: { 200: R.PostLeaveRequestsByIdCancel200 }, params: IdParams, body: RequestsCancelBody }, config: { permAny: ['leave.self', 'leave.manage'] } },
    async (req) => {
      const a = tenantActorAny(req, 'leave.self', 'leave.manage');
      const { id } = IdParams.parse(req.params);
      const body = RequestsCancelBody.parse(req.body ?? {});
      return a.tx(async (db) => {
        const r = (
          await db.query<{
            employee_id: string;
            leave_type_id: string;
            leave_year: number;
            days: string;
            start_date: string;
            end_date: string;
            status: string;
            requested_by: string;
          }>(`SELECT employee_id, leave_type_id, leave_year, days, start_date, end_date, status, requested_by FROM leave_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [
            a.tenantId,
            id,
          ])
        ).rows[0];
        if (!r) throw notFound('Leave request not found');
        const own = r.requested_by === a.user.userId || r.employee_id === a.user.employeeId;
        if (!own && !a.has('leave.manage')) throw forbidden();
        if (!['pending', 'approved'].includes(r.status)) throw conflict(`This request is already ${r.status}`);
        if ((await lockedDates(db, a.tenantId, r.start_date, r.end_date)).size) throw conflict('These dates are locked for payroll; the leave cannot be cancelled');
        if (r.status === 'approved') {
          const { tz } = await employeeTimezone(db, a.tenantId, r.employee_id);
          if (!a.has('leave.manage') && r.start_date <= localDate(new Date(), tz)) throw forbidden('Leave that has started can only be cancelled by HR');
          await insertLedgerEntry(db, a.tenantId, {
            empId: r.employee_id,
            typeId: r.leave_type_id,
            year: r.leave_year,
            entryType: 'reversal',
            days: new Decimal(r.days),
            reference: `request:${id}:reverse`,
            requestId: id,
            note: 'Cancelled after approval',
            actorId: a.user.userId,
          });
        }
        await db.query(`UPDATE leave_requests SET status='cancelled', cancelled_at=now(), cancelled_by=$3 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, a.user.userId]);
        await db.query(
          `UPDATE approval_steps SET status='skipped' WHERE tenant_id=$1 AND status IN ('waiting','active')
        AND request_id IN (SELECT ar.id FROM approval_requests ar WHERE ar.tenant_id=$1 AND ar.entity_type='leave_request' AND ar.entity_id=$2 AND ar.status='pending')`,
          [a.tenantId, id],
        );
        await db.query(
          `UPDATE approval_requests SET status='cancelled', decided_at=now() WHERE tenant_id=$1 AND entity_type='leave_request' AND entity_id=$2 AND status='pending'`,
          [a.tenantId, id],
        );
        if (r.status === 'approved') await recalculateRange(db, a.tenantId, r.employee_id, r.start_date, r.end_date);
        await audit(db, {
          ...a.auditBase,
          action: 'leave.cancelled',
          targetType: 'leave_request',
          targetId: id,
          metadata: { previousStatus: r.status, reason: body.reason, days: r.days },
        });
        return { ok: true, reversedDays: r.status === 'approved' ? r.days : '0' };
      });
    },
  );

  // ------------------------------------------------------------ calendar
  app.get(
    '/calendar',
    {
      schema: { response: { 200: R.GetLeaveCalendar200 }, querystring: CalendarQuery },
      config: { permAny: ['leave.read', 'leave.team.read', 'leave.manage'], feature: ['leave'] },
    },
    async (req) => {
      const a = tenantActorAny(req, 'leave.read', 'leave.team.read', 'leave.manage');
      const q = CalendarQuery.parse(req.query);
      return a.tx(async (db) => {
        await requireFeature(db, a.tenantId, 'leave');
        const ids = a.has('leave.read') || a.has('leave.manage') ? null : a.user.employeeId ? await teamEmployeeIds(db, a.tenantId, a.user.employeeId) : [];
        return {
          items: (
            await db.query(
              `SELECT r.id, r.employee_id, e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, t.code AS type_code,
          r.start_date, r.end_date, r.start_half, r.end_half, r.days, r.status
        FROM leave_requests r JOIN employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id JOIN leave_types t ON t.tenant_id=r.tenant_id AND t.id=r.leave_type_id
        WHERE r.tenant_id=$1 AND r.status IN ('pending','approved') AND r.start_date <= $3 AND r.end_date >= $2
          AND ($4::uuid[] IS NULL OR r.employee_id = ANY($4)) AND ($5::uuid IS NULL OR e.branch_id=$5)
        ORDER BY r.start_date, name LIMIT 1000`,
              [a.tenantId, q.from, q.to, ids, q.branchId ?? null],
            )
          ).rows,
        };
      });
    },
  );

  // ------------------------------------------------------------ administration
  app.post('/accruals', { schema: { body: AccrualsBody }, config: { perm: ['leave.manage'], feature: ['leave'] } }, async (req) => {
    const a = tenantActor(req, 'leave.manage');
    const body = AccrualsBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'leave');
      const r = await runAccruals(db, a.tenantId, body.leaveYear, body.throughMonth, a.user.userId);
      await audit(db, { ...a.auditBase, action: 'leave.accruals_run', category: 'data', metadata: r });
      return r;
    });
  });

  app.post('/year-end', { schema: { body: YearEndBody }, config: { perm: ['leave.manage'], feature: ['leave'] } }, async (req) => {
    const a = tenantActor(req, 'leave.manage');
    const body = YearEndBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'leave');
      const r = await runYearEnd(db, a.tenantId, body.leaveYear, a.user.userId, await orgToday(db, a.tenantId));
      await audit(db, { ...a.auditBase, action: 'leave.year_closed', category: 'data', metadata: r });
      return r;
    });
  });

  app.post('/adjustments', { schema: { body: AdjustmentsBody }, config: { perm: ['leave.manage'], feature: ['leave'] } }, async (req, reply) => {
    const a = tenantActor(req, 'leave.manage');
    const body = AdjustmentsBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'leave');
      if (!(await loadEmployee(db, a.tenantId, body.employeeId))) throw notFound('Employee not found');
      if (body.employeeId === a.user.employeeId) throw forbidden('You cannot adjust your own leave balance; ask another HR administrator');
      await loadType(db, a.tenantId, body.leaveTypeId);
      if (await yearClosed(db, a.tenantId, body.leaveYear)) throw conflict(`The ${body.leaveYear} leave year is closed; adjust the current year instead`);
      const ref = `${body.entryType}:${crypto.randomUUID()}`;
      await insertLedgerEntry(db, a.tenantId, {
        empId: body.employeeId,
        typeId: body.leaveTypeId,
        year: body.leaveYear,
        entryType: body.entryType,
        days: new Decimal(body.days),
        reference: ref,
        note: body.note,
        actorId: a.user.userId,
      });
      await audit(db, { ...a.auditBase, action: 'leave.balance_adjusted', targetType: 'employee', targetId: body.employeeId, metadata: body });
      reply.code(201);
      return { ok: true };
    });
  });
}
