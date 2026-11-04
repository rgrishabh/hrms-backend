import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantActor, tenantActorAny, requireFeature, type TenantActor } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { IsoDate, PageQuery, offsetOf, paged, Uuid } from '../../core/http/pagination.js';
import { getSettingValue } from '../../core/settings/service.js';
import { createApprovalRequest, registerApprovalHandler, type StepSpec } from '../../core/workflow/engine.js';
import { randomToken, sha256 } from '../../core/crypto/index.js';
import type { Db } from '../../db/tx.js';
import { employeeTimezone, lockedDates, recalcForEvent, recalculateRange, recordEvent, teamEmployeeIds } from './service.js';
import { daysBetween, localDate, addDays, zonedToInstant, todaysPunches } from './time.js';
import { evaluateFeatures } from '../../core/features/state.js';

const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const ShiftBody = z.object({
  code: z.string().trim().regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/), name: z.string().trim().min(2).max(100),
  startTime: TimeOfDay, endTime: TimeOfDay, breakMinutes: z.number().int().min(0).max(240).default(0),
  graceMinutes: z.number().int().min(0).max(240).default(0), earlyExitGraceMinutes: z.number().int().min(0).max(240).default(0),
  halfDayMinMinutes: z.number().int().min(30).max(1440), fullDayMinMinutes: z.number().int().min(60).max(1440),
  overtimeAfterMinutes: z.number().int().min(60).max(1440).nullable().default(null), status: z.enum(['active', 'inactive']).default('active'),
}).refine((s) => s.startTime !== s.endTime, { message: 'Start and end time cannot be equal', path: ['endTime'] })
  .refine((s) => s.fullDayMinMinutes >= s.halfDayMinMinutes, { message: 'Full-day minimum must be ≥ half-day minimum', path: ['fullDayMinMinutes'] });

const Range = z.object({ from: IsoDate, to: IsoDate }).refine((r) => r.from <= r.to, 'from must be on or before to')
  .refine((r) => daysBetween(r.from, r.to) <= 62, 'Range cannot exceed 62 days');

/** Who may view a given employee's attendance: self, their manager chain, or attendance.read. */
async function assertCanViewEmployee(db: Db, a: TenantActor, employeeId: string) {
  if (a.has('attendance.read') || a.user.employeeId === employeeId) return;
  if (a.has('attendance.team.read') && a.user.employeeId && (await teamEmployeeIds(db, a.tenantId, a.user.employeeId)).includes(employeeId)) return;
  throw forbidden();
}

export async function attendanceRoutes(app: FastifyInstance) {
  // Regularization approval effects.
  registerApprovalHandler('attendance_regularization', {
    feature: 'attendance.regularization', label: 'Attendance correction', requesterLink: '/attendance/me',
    async onApproved(db, tenantId, regId, actorId) {
      const r = await db.query<{ employee_id: string; work_date: string; requested_in: Date | null; requested_out: Date | null }>(
        `UPDATE attendance_regularizations SET status='approved', decided_at=now() WHERE tenant_id=$1 AND id=$2 AND status='pending'
         RETURNING employee_id, work_date, requested_in, requested_out`, [tenantId, regId]);
      const reg = r.rows[0];
      if (!reg) throw conflict('Regularization is no longer pending');
      if ((await lockedDates(db, tenantId, reg.work_date, reg.work_date)).size) throw conflict('Attendance for this date is locked for payroll; it cannot be changed');
      // Approved corrections become new source events — originals are never modified.
      if (reg.requested_in) await recordEvent(db, tenantId, { employeeId: reg.employee_id, source: 'regularization', sourceRef: `${regId}:in`, eventTime: reg.requested_in, direction: 'in', createdBy: actorId });
      if (reg.requested_out) await recordEvent(db, tenantId, { employeeId: reg.employee_id, source: 'regularization', sourceRef: `${regId}:out`, eventTime: reg.requested_out, direction: 'out', createdBy: actorId });
      await recalculateRange(db, tenantId, reg.employee_id, reg.work_date, reg.work_date);
    },
    async onRejected(db, tenantId, regId, _actor, status) {
      await db.query(`UPDATE attendance_regularizations SET status=$3, decided_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, regId, status]);
    },
  });

  // ------------------------------------------------------------ punches (web / mobile)
  const PunchBody = z.object({
    channel: z.enum(['web', 'mobile']), direction: z.enum(['in', 'out']).optional(),
    idempotencyKey: z.string().min(8).max(100), latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(),
  });
  app.post('/punch', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req) => {
    const a = tenantActor(req, 'attendance.self');
    const body = PunchBody.parse(req.body);
    const employeeId = a.user.employeeId;
    if (!employeeId) throw badRequest('Your account is not linked to an employee record');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, body.channel === 'web' ? 'attendance.web' : 'attendance.mobile');
      const emp = await db.query<{ status: string; branch_id: string }>('SELECT status, branch_id FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, employeeId]);
      if (!['active', 'on_notice'].includes(emp.rows[0]!.status)) throw forbidden('Only active employees can record attendance');
      let lat = body.latitude ?? null; let lng = body.longitude ?? null;
      if (body.channel === 'mobile') {
        const mode = await getSettingValue<string>(db, a.tenantId, 'attendance.mobile_location_mode', emp.rows[0]!.branch_id);
        if (mode === 'required' && (lat === null || lng === null)) throw badRequest('Location is required for mobile attendance at your branch');
        if (mode === 'off') { lat = null; lng = null; }   // never store location the policy did not ask for
      } else { lat = null; lng = null; }
      // Server time is authoritative; the client clock is never trusted.
      const now = new Date();
      let direction = body.direction;
      if (!direction) {
        const last = await db.query<{ direction: string }>(`SELECT direction FROM attendance_events WHERE tenant_id=$1 AND employee_id=$2 AND status='accepted'
          AND event_time > now() - interval '16 hours' ORDER BY event_time DESC LIMIT 1`, [a.tenantId, employeeId]);
        direction = last.rows[0]?.direction === 'in' ? 'out' : 'in';
      }
      const ev = await recordEvent(db, a.tenantId, { employeeId, source: body.channel, sourceRef: `${a.user.userId}:${body.idempotencyKey}`, eventTime: now,
        direction, latitude: lat, longitude: lng, createdBy: a.user.userId });
      if (!ev) return { duplicate: true };
      await recalcForEvent(db, a.tenantId, employeeId, now);
      return { duplicate: false, id: ev.id, direction, eventTime: now };
    });
  });

  // ------------------------------------------------------------ views
  app.get('/me', async (req) => {
    const a = tenantActor(req, 'attendance.self');
    const q = Range.parse(req.query);
    if (!a.user.employeeId) throw badRequest('Your account is not linked to an employee record');
    return a.tx((db) => employeeAttendance(db, a.tenantId, a.user.employeeId!, q.from, q.to));
  });

  app.get('/me/today', async (req) => {
    const a = tenantActor(req, 'attendance.self');
    if (!a.user.employeeId) return { linked: false };
    return a.tx(async (db) => {
      const { tz } = await employeeTimezone(db, a.tenantId, a.user.employeeId!);
      const today = localDate(new Date(), tz);
      const recent = (await db.query<{ id: string; event_time: Date; direction: string; source: string; is_today: boolean }>(`SELECT id, event_time, direction, source,
          event_time >= ($3::date::timestamp AT TIME ZONE $4) AS is_today
        FROM attendance_events WHERE tenant_id=$1 AND employee_id=$2 AND status='accepted'
        AND event_time > now() - interval '20 hours' ORDER BY event_time`, [a.tenantId, a.user.employeeId, today, tz])).rows;
      const events = { rows: todaysPunches(recent).map(({ is_today: _t, ...e }) => e) };
      const daily = await db.query(`SELECT * FROM attendance_daily WHERE tenant_id=$1 AND employee_id=$2 AND work_date=$3`, [a.tenantId, a.user.employeeId, today]);
      const states = await evaluateFeatures(db, a.tenantId);
      const last = recent[recent.length - 1];
      return { linked: true, today, timezone: tz, events: events.rows, daily: daily.rows[0] ?? null, nextDirection: last?.direction === 'in' ? 'out' : 'in',
        channels: { web: states.get('attendance.web')!.usable, mobile: states.get('attendance.mobile')!.usable },
        locationMode: await getSettingValue<string>(db, a.tenantId, 'attendance.mobile_location_mode') };
    });
  });

  app.get('/employees/:id', async (req) => {
    const a = tenantActorAny(req, 'attendance.self', 'attendance.read', 'attendance.team.read');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const q = Range.parse(req.query);
    return a.tx(async (db) => { await assertCanViewEmployee(db, a, id); return employeeAttendance(db, a.tenantId, id, q.from, q.to); });
  });

  app.get('/daily', async (req) => {
    const a = tenantActorAny(req, 'attendance.read', 'attendance.team.read');
    const q = PageQuery.extend({ date: IsoDate, branchId: Uuid.optional(), status: z.string().max(20).optional(), exceptionsOnly: z.coerce.boolean().optional() }).parse(req.query);
    return a.tx(async (db) => {
      let scope: string[] | null = null;
      if (!a.has('attendance.read')) scope = a.user.employeeId ? await teamEmployeeIds(db, a.tenantId, a.user.employeeId) : [];
      const params = [a.tenantId, q.date, q.branchId ?? null, q.status ?? null, scope, q.exceptionsOnly ?? false];
      // Left join so employees without a calculated row still appear ("not calculated").
      const where = `e.tenant_id=$1 AND e.status IN ('active','on_notice') AND e.date_of_joining <= $2
        AND ($3::uuid IS NULL OR e.branch_id=$3) AND ($5::uuid[] IS NULL OR e.id = ANY($5))
        AND ($4::text IS NULL OR coalesce(d.status,'not_calculated')=$4) AND (NOT $6 OR cardinality(d.exceptions) > 0)`;
      const from = `FROM employees e LEFT JOIN attendance_daily d ON d.tenant_id=e.tenant_id AND d.employee_id=e.id AND d.work_date=$2
        JOIN branches b ON b.tenant_id=e.tenant_id AND b.id=e.branch_id LEFT JOIN shifts s ON s.tenant_id=d.tenant_id AND s.id=d.shift_id`;
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n ${from} WHERE ${where}`, params)).rows[0]!.n);
      const summary = (await db.query(`SELECT coalesce(d.status,'not_calculated') AS status, count(*)::int AS count ${from}
        WHERE e.tenant_id=$1 AND e.status IN ('active','on_notice') AND e.date_of_joining <= $2 AND ($3::uuid IS NULL OR e.branch_id=$3)
        AND ($5::uuid[] IS NULL OR e.id = ANY($5)) AND ($4::text IS NULL OR true) AND ($6 OR true) GROUP BY 1`, params)).rows;
      const rows = await db.query(`SELECT e.id AS employee_id, e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, b.name AS branch_name,
          coalesce(d.status,'not_calculated') AS status, d.first_in, d.last_out, d.worked_minutes, d.late_minutes, d.early_exit_minutes, d.overtime_minutes,
          d.exceptions, d.locked, s.code AS shift_code
        ${from} WHERE ${where} ORDER BY e.first_name, e.employee_code LIMIT $7 OFFSET $8`, [...params, q.pageSize, offsetOf(q)]);
      return { ...paged(rows.rows, total, q), summary };
    });
  });

  // ------------------------------------------------------------ recalculation & locking
  app.post('/recalculate', async (req) => {
    const a = tenantActor(req, 'attendance.recalculate');
    const body = z.object({ from: IsoDate, to: IsoDate, employeeId: Uuid.optional(), branchId: Uuid.optional() }).parse(req.body);
    Range.parse(body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'attendance');
      const emps = await db.query<{ id: string }>(`SELECT id FROM employees WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id=$2) AND ($3::uuid IS NULL OR branch_id=$3)
        AND date_of_joining <= $5 AND (exit_date IS NULL OR exit_date >= $4)`, [a.tenantId, body.employeeId ?? null, body.branchId ?? null, body.from, body.to]);
      let days = 0; let skipped = 0;
      for (const e of emps.rows) {
        const r = await recalculateRange(db, a.tenantId, e.id, body.from, body.to);
        days += r.results.length; skipped += r.skippedLocked.length;
      }
      await audit(db, { ...a.auditBase, action: 'attendance.recalculated', metadata: { ...body, employees: emps.rowCount, days, skippedLockedDays: skipped } });
      return { employees: emps.rowCount, daysCalculated: days, lockedDaysSkipped: skipped };
    });
  });

  app.get('/locks', async (req) => {
    const a = tenantActorAny(req, 'attendance.read', 'attendance.lock');
    return a.tx(async (db) => ({ items: (await db.query(`SELECT l.id, l.period_start, l.period_end, l.locked_at, u.display_name AS locked_by
      FROM attendance_period_locks l JOIN users u ON u.id=l.locked_by WHERE l.tenant_id=$1 ORDER BY l.period_start DESC`, [a.tenantId])).rows }));
  });

  /** Freeze a period for payroll: calculate everything first, then lock. Corrections after this need an audited adjustment. */
  app.post('/locks', async (req, reply) => {
    const a = tenantActor(req, 'attendance.lock');
    const body = z.object({ periodStart: IsoDate, periodEnd: IsoDate }).parse(req.body);
    Range.parse({ from: body.periodStart, to: body.periodEnd });
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'attendance');
      const overlap = await db.query('SELECT 1 FROM attendance_period_locks WHERE tenant_id=$1 AND period_start <= $3 AND period_end >= $2', [a.tenantId, body.periodStart, body.periodEnd]);
      if (overlap.rowCount) throw conflict('This period overlaps an existing lock');
      const pending = await db.query<{ n: string }>(`SELECT count(*) AS n FROM attendance_regularizations WHERE tenant_id=$1 AND status='pending' AND work_date BETWEEN $2 AND $3`,
        [a.tenantId, body.periodStart, body.periodEnd]);
      if (Number(pending.rows[0]!.n) > 0) throw conflict(`${pending.rows[0]!.n} regularization request(s) in this period are still pending. Resolve them before locking.`);
      const emps = await db.query<{ id: string }>(`SELECT id FROM employees WHERE tenant_id=$1 AND date_of_joining <= $3 AND (exit_date IS NULL OR exit_date >= $2)`,
        [a.tenantId, body.periodStart, body.periodEnd]);
      for (const e of emps.rows) await recalculateRange(db, a.tenantId, e.id, body.periodStart, body.periodEnd);
      const r = await db.query<{ id: string }>(`INSERT INTO attendance_period_locks (tenant_id, period_start, period_end, locked_by) VALUES ($1,$2,$3,$4) RETURNING id`,
        [a.tenantId, body.periodStart, body.periodEnd, a.user.userId]);
      const locked = await db.query(`UPDATE attendance_daily SET locked=true WHERE tenant_id=$1 AND work_date BETWEEN $2 AND $3`, [a.tenantId, body.periodStart, body.periodEnd]);
      await audit(db, { ...a.auditBase, action: 'attendance.period_locked', targetType: 'attendance_lock', targetId: r.rows[0]!.id, metadata: { ...body, rows: locked.rowCount } });
      reply.code(201); return { id: r.rows[0]!.id, rowsLocked: locked.rowCount };
    });
  });

  // ------------------------------------------------------------ regularization
  const RegBody = z.object({ workDate: IsoDate, requestedIn: z.iso.datetime({ offset: true }).optional(), requestedOut: z.iso.datetime({ offset: true }).optional(),
    reason: z.string().trim().min(5).max(1000) }).refine((b) => b.requestedIn || b.requestedOut, 'Provide an in time, an out time, or both');
  app.post('/regularizations', async (req, reply) => {
    const a = tenantActor(req, 'attendance.self');
    const body = RegBody.parse(req.body);
    const employeeId = a.user.employeeId;
    if (!employeeId) throw badRequest('Your account is not linked to an employee record');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'attendance.regularization');
      const { tz } = await employeeTimezone(db, a.tenantId, employeeId);
      const today = localDate(new Date(), tz);
      const windowDays = await getSettingValue<number>(db, a.tenantId, 'attendance.regularization_window_days');
      if (body.workDate > today) throw badRequest('You cannot regularize a future date');
      if (daysBetween(body.workDate, today) > windowDays) throw badRequest(`Corrections are allowed only for the last ${windowDays} days`);
      if ((await lockedDates(db, a.tenantId, body.workDate, body.workDate)).size) throw conflict('Attendance for this date is locked for payroll');
      const inT = body.requestedIn ? new Date(body.requestedIn) : null; const outT = body.requestedOut ? new Date(body.requestedOut) : null;
      if (inT && outT && outT <= inT) throw badRequest('Out time must be after in time');
      for (const t of [inT, outT]) if (t && t > new Date()) throw badRequest('Times cannot be in the future');
      for (const t of [inT, outT]) if (t && Math.abs(daysBetween(body.workDate, localDate(t, tz))) > 1) throw badRequest('Times must fall on or next to the work date');
      const reg = await db.query<{ id: string }>(`INSERT INTO attendance_regularizations (tenant_id, employee_id, work_date, requested_in, requested_out, reason, requested_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [a.tenantId, employeeId, body.workDate, inT, outT, body.reason, a.user.userId]);
      // Routing: reporting manager (if they have a login), otherwise HR (attendance.approve).
      const mgr = await db.query<{ user_id: string | null }>(`SELECT m.user_id FROM employees e JOIN employees m ON m.tenant_id=e.tenant_id AND m.id=e.reporting_manager_id
        WHERE e.tenant_id=$1 AND e.id=$2 AND m.status IN ('active','on_notice')`, [a.tenantId, employeeId]);
      const steps: StepSpec[] = mgr.rows[0]?.user_id ? [{ kind: 'user', userId: mgr.rows[0].user_id }] : [{ kind: 'permission', permission: 'attendance.approve' }];
      const reqId = await createApprovalRequest(db, a.tenantId, { entityType: 'attendance_regularization', entityId: reg.rows[0]!.id, requesterId: a.user.userId,
        summary: `Attendance correction for ${body.workDate}: ${body.reason.slice(0, 80)}`, steps });
      await audit(db, { ...a.auditBase, action: 'attendance.regularization_requested', targetType: 'attendance_regularization', targetId: reg.rows[0]!.id,
        metadata: { workDate: body.workDate, approvalRequestId: reqId } });
      reply.code(201); return { id: reg.rows[0]!.id, approvalRequestId: reqId };
    });
  });

  app.get('/regularizations', async (req) => {
    const a = tenantActorAny(req, 'attendance.self', 'attendance.read');
    const q = PageQuery.extend({ scope: z.enum(['mine', 'all']).default('mine'), status: z.string().max(20).optional() }).parse(req.query);
    if (q.scope === 'all' && !a.has('attendance.read')) throw forbidden();
    return a.tx(async (db) => {
      const params = [a.tenantId, q.scope === 'mine' ? a.user.employeeId ?? '00000000-0000-0000-0000-000000000000' : null, q.status ?? null];
      const where = `r.tenant_id=$1 AND ($2::uuid IS NULL OR r.employee_id=$2) AND ($3::text IS NULL OR r.status=$3)`;
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM attendance_regularizations r WHERE ${where}`, params)).rows[0]!.n);
      const rows = await db.query(`SELECT r.id, r.work_date, r.requested_in, r.requested_out, r.reason, r.status, r.created_at, r.decided_at, e.employee_code,
          trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, ar.id AS approval_request_id
        FROM attendance_regularizations r JOIN employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id
        LEFT JOIN approval_requests ar ON ar.tenant_id=r.tenant_id AND ar.entity_type='attendance_regularization' AND ar.entity_id=r.id
        WHERE ${where} ORDER BY r.created_at DESC LIMIT $4 OFFSET $5`, [...params, q.pageSize, offsetOf(q)]);
      return paged(rows.rows, total, q);
    });
  });

  // ------------------------------------------------------------ shifts
  app.get('/shifts', async (req) => {
    const a = tenantActorAny(req, 'attendance.configure', 'attendance.read', 'attendance.self');
    return a.tx(async (db) => ({ items: (await db.query(`SELECT id, code, name, start_time::text, end_time::text, break_minutes, grace_minutes, early_exit_grace_minutes,
      half_day_min_minutes, full_day_min_minutes, overtime_after_minutes, status, end_time <= start_time AS overnight FROM shifts WHERE tenant_id=$1 ORDER BY code`, [a.tenantId])).rows }));
  });

  const shiftCols = (s: z.infer<typeof ShiftBody>) => [s.code, s.name, s.startTime, s.endTime, s.breakMinutes, s.graceMinutes, s.earlyExitGraceMinutes,
    s.halfDayMinMinutes, s.fullDayMinMinutes, s.overtimeAfterMinutes, s.status];
  app.post('/shifts', async (req, reply) => {
    const a = tenantActor(req, 'attendance.configure');
    const body = ShiftBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'shifts');
      const r = await db.query<{ id: string }>(`INSERT INTO shifts (tenant_id, code, name, start_time, end_time, break_minutes, grace_minutes, early_exit_grace_minutes,
        half_day_min_minutes, full_day_min_minutes, overtime_after_minutes, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [a.tenantId, ...shiftCols(body)]);
      await audit(db, { ...a.auditBase, action: 'attendance.shift_created', category: 'configuration', targetType: 'shift', targetId: r.rows[0]!.id, metadata: body });
      reply.code(201); return { id: r.rows[0]!.id };
    });
  });

  app.put('/shifts/:id', async (req) => {
    const a = tenantActor(req, 'attendance.configure');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const body = ShiftBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'shifts');
      const prev = await db.query('SELECT * FROM shifts WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id]);
      if (!prev.rowCount) throw notFound('Shift not found');
      await db.query(`UPDATE shifts SET code=$3, name=$4, start_time=$5, end_time=$6, break_minutes=$7, grace_minutes=$8, early_exit_grace_minutes=$9,
        half_day_min_minutes=$10, full_day_min_minutes=$11, overtime_after_minutes=$12, status=$13 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, ...shiftCols(body)]);
      // Existing daily results keep their stored values; HR recalculates explicitly (locked periods are never touched).
      await audit(db, { ...a.auditBase, action: 'attendance.shift_updated', category: 'configuration', targetType: 'shift', targetId: id, metadata: { from: prev.rows[0], to: body } });
      return { ok: true };
    });
  });

  app.post('/shift-assignments', async (req) => {
    const a = tenantActor(req, 'attendance.configure');
    const body = z.object({ employeeIds: z.array(Uuid).min(1).max(1000), shiftId: Uuid, effectiveFrom: IsoDate, effectiveTo: IsoDate.nullable().optional() }).parse(req.body);
    if (body.effectiveTo && body.effectiveTo < body.effectiveFrom) throw badRequest('effectiveTo must be on or after effectiveFrom');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'shifts');
      const s = await db.query(`SELECT 1 FROM shifts WHERE tenant_id=$1 AND id=$2 AND status='active'`, [a.tenantId, body.shiftId]);
      if (!s.rowCount) throw badRequest('Shift not found or inactive');
      if ((await lockedDates(db, a.tenantId, body.effectiveFrom, body.effectiveFrom)).size) throw conflict('Cannot change shifts starting inside a locked period');
      for (const empId of body.employeeIds) {
        // Close any open-ended or overlapping earlier assignment the day before the new one starts.
        await db.query(`UPDATE shift_assignments SET effective_to = $3::date - 1 WHERE tenant_id=$1 AND employee_id=$2
          AND effective_from < $3 AND (effective_to IS NULL OR effective_to >= $3)`, [a.tenantId, empId, body.effectiveFrom]);
        await db.query(`INSERT INTO shift_assignments (tenant_id, employee_id, shift_id, effective_from, effective_to, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
          [a.tenantId, empId, body.shiftId, body.effectiveFrom, body.effectiveTo ?? null, a.user.userId]);
      }
      await audit(db, { ...a.auditBase, action: 'attendance.shift_assigned', category: 'configuration', targetType: 'shift', targetId: body.shiftId,
        metadata: { employees: body.employeeIds.length, effectiveFrom: body.effectiveFrom, effectiveTo: body.effectiveTo ?? null } });
      return { assigned: body.employeeIds.length };
    });
  });

  // ------------------------------------------------------------ holidays
  app.get('/holidays', async (req) => {
    const a = tenantActor(req);
    const q = z.object({ year: z.coerce.number().int().min(2000).max(2100) }).parse(req.query);
    return a.tx(async (db) => ({ items: (await db.query(`SELECT h.id, h.holiday_date, h.name, h.optional, h.branch_id, b.name AS branch_name
      FROM holidays h LEFT JOIN branches b ON b.tenant_id=h.tenant_id AND b.id=h.branch_id
      WHERE h.tenant_id=$1 AND extract(year FROM h.holiday_date)=$2 ORDER BY h.holiday_date`, [a.tenantId, q.year])).rows }));
  });

  app.post('/holidays', async (req, reply) => {
    const a = tenantActor(req, 'attendance.configure');
    const body = z.object({ holidayDate: IsoDate, name: z.string().trim().min(2).max(120), branchId: Uuid.nullable().optional(), optional: z.boolean().default(false) }).parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'holidays');
      if ((await lockedDates(db, a.tenantId, body.holidayDate, body.holidayDate)).size) throw conflict('This date is in a locked attendance period');
      const r = await db.query<{ id: string }>(`INSERT INTO holidays (tenant_id, branch_id, holiday_date, name, optional) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [a.tenantId, body.branchId ?? null, body.holidayDate, body.name, body.optional]);
      await audit(db, { ...a.auditBase, action: 'attendance.holiday_created', category: 'configuration', targetType: 'holiday', targetId: r.rows[0]!.id, metadata: body });
      reply.code(201); return { id: r.rows[0]!.id };
    });
  });

  app.delete('/holidays/:id', async (req) => {
    const a = tenantActor(req, 'attendance.configure');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const h = await db.query<{ holiday_date: string }>('SELECT holiday_date FROM holidays WHERE tenant_id=$1 AND id=$2', [a.tenantId, id]);
      if (!h.rowCount) throw notFound();
      if ((await lockedDates(db, a.tenantId, h.rows[0]!.holiday_date, h.rows[0]!.holiday_date)).size) throw conflict('This date is in a locked attendance period');
      await db.query('DELETE FROM holidays WHERE tenant_id=$1 AND id=$2', [a.tenantId, id]);
      await audit(db, { ...a.auditBase, action: 'attendance.holiday_deleted', category: 'configuration', targetType: 'holiday', targetId: id, metadata: h.rows[0] });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ biometric devices (management)
  app.get('/devices', async (req) => {
    const a = tenantActorAny(req, 'attendance.devices.manage', 'attendance.configure');
    return a.tx(async (db) => ({ items: (await db.query(`SELECT d.id, d.serial_number, d.name, d.adapter_key, d.status, d.last_sync_at, d.last_clock_drift_seconds,
        d.last_error, d.api_key_prefix, b.name AS branch_name, d.branch_id,
        (SELECT count(*)::int FROM attendance_events ev WHERE ev.tenant_id=d.tenant_id AND ev.device_id=d.id AND ev.status='unmapped') AS unmapped_events
      FROM attendance_devices d JOIN branches b ON b.tenant_id=d.tenant_id AND b.id=d.branch_id WHERE d.tenant_id=$1 ORDER BY d.name`, [a.tenantId])).rows }));
  });

  app.post('/devices', async (req, reply) => {
    const a = tenantActor(req, 'attendance.devices.manage');
    const body = z.object({ branchId: Uuid, serialNumber: z.string().trim().min(3).max(64), name: z.string().trim().min(2).max(100),
      adapterKey: z.enum(['generic_push_v1']) }).parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'attendance');
      const s = (await evaluateFeatures(db, a.tenantId)).get('attendance.biometric')!;
      // Devices can be registered once the module is enabled for this installation; "configured" becomes true with the first device.
      if (!s.supported || !s.enabled) throw forbidden(`Biometric attendance is not available: ${s.blockers.join('; ')}`);
      const { prefix, secret, key } = newDeviceKey();
      const r = await db.query<{ id: string }>(`INSERT INTO attendance_devices (tenant_id, branch_id, serial_number, name, adapter_key, api_key_hash, api_key_prefix)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [a.tenantId, body.branchId, body.serialNumber, body.name, body.adapterKey, sha256(secret), prefix]);
      await audit(db, { ...a.auditBase, action: 'attendance.device_registered', category: 'security', targetType: 'device', targetId: r.rows[0]!.id, metadata: { ...body, keyPrefix: prefix } });
      // The full key is shown exactly once.
      reply.code(201); return { id: r.rows[0]!.id, apiKey: key };
    });
  });

  app.post('/devices/:id/rotate-key', async (req) => {
    const a = tenantActor(req, 'attendance.devices.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const { prefix, secret, key } = newDeviceKey();
      const r = await db.query(`UPDATE attendance_devices SET api_key_hash=$3, api_key_prefix=$4 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, sha256(secret), prefix]);
      if (!r.rowCount) throw notFound('Device not found');
      await audit(db, { ...a.auditBase, action: 'attendance.device_key_rotated', category: 'security', targetType: 'device', targetId: id, metadata: { keyPrefix: prefix } });
      return { apiKey: key };
    });
  });

  app.patch('/devices/:id', async (req) => {
    const a = tenantActor(req, 'attendance.devices.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const body = z.object({ status: z.enum(['active', 'disabled', 'replaced']).optional(), branchId: Uuid.optional(), name: z.string().trim().min(2).max(100).optional() }).parse(req.body);
    return a.tx(async (db) => {
      const prev = await db.query('SELECT status, branch_id, name FROM attendance_devices WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id]);
      if (!prev.rowCount) throw notFound('Device not found');
      await db.query(`UPDATE attendance_devices SET status=coalesce($3,status), branch_id=coalesce($4,branch_id), name=coalesce($5,name) WHERE tenant_id=$1 AND id=$2`,
        [a.tenantId, id, body.status ?? null, body.branchId ?? null, body.name ?? null]);
      await audit(db, { ...a.auditBase, action: 'attendance.device_updated', category: 'configuration', targetType: 'device', targetId: id, metadata: { from: prev.rows[0], to: body } });
      return { ok: true };
    });
  });

  app.get('/device-mappings', async (req) => {
    const a = tenantActor(req, 'attendance.devices.manage');
    return a.tx(async (db) => ({ items: (await db.query(`SELECT m.device_user_id, m.employee_id, e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name
      FROM device_user_mappings m JOIN employees e ON e.tenant_id=m.tenant_id AND e.id=m.employee_id WHERE m.tenant_id=$1 ORDER BY m.device_user_id`, [a.tenantId])).rows }));
  });

  /** Map a device enrolment id to an employee and re-process any events that were waiting in the unmapped queue. */
  app.put('/device-mappings/:deviceUserId', async (req) => {
    const a = tenantActor(req, 'attendance.devices.manage');
    const { deviceUserId } = z.object({ deviceUserId: z.string().min(1).max(64) }).parse(req.params);
    const body = z.object({ employeeId: Uuid }).parse(req.body);
    return a.tx(async (db) => {
      const e = await db.query('SELECT 1 FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, body.employeeId]);
      if (!e.rowCount) throw notFound('Employee not found');
      const prev = await db.query<{ employee_id: string }>('SELECT employee_id FROM device_user_mappings WHERE tenant_id=$1 AND device_user_id=$2', [a.tenantId, deviceUserId]);
      await db.query(`INSERT INTO device_user_mappings (tenant_id, device_user_id, employee_id) VALUES ($1,$2,$3)
        ON CONFLICT (tenant_id, device_user_id) DO UPDATE SET employee_id=$3`, [a.tenantId, deviceUserId, body.employeeId]);
      const remapped = await db.query<{ event_time: Date }>(`UPDATE attendance_events SET employee_id=$3, status='accepted', reject_reason=NULL
        WHERE tenant_id=$1 AND source='biometric' AND device_user_id=$2 AND status='unmapped' RETURNING event_time`, [a.tenantId, deviceUserId, body.employeeId]);
      if (remapped.rowCount) {
        const { tz } = await employeeTimezone(db, a.tenantId, body.employeeId);
        const dates = remapped.rows.map((r) => localDate(r.event_time, tz)).sort();
        await recalculateRange(db, a.tenantId, body.employeeId, addDays(dates[0]!, -1), dates[dates.length - 1]!);
      }
      await audit(db, { ...a.auditBase, action: 'attendance.device_mapping_set', category: 'configuration', targetType: 'device_mapping', targetId: deviceUserId,
        metadata: { from: prev.rows[0]?.employee_id ?? null, to: body.employeeId, reprocessedEvents: remapped.rowCount } });
      return { reprocessedEvents: remapped.rowCount };
    });
  });

  app.get('/device-events/unmapped', async (req) => {
    const a = tenantActor(req, 'attendance.devices.manage');
    return a.tx(async (db) => ({ items: (await db.query(`SELECT ev.id, ev.device_user_id, ev.event_time, ev.device_time, ev.direction, ev.received_at, d.name AS device_name, d.serial_number
      FROM attendance_events ev LEFT JOIN attendance_devices d ON d.tenant_id=ev.tenant_id AND d.id=ev.device_id
      WHERE ev.tenant_id=$1 AND ev.status='unmapped' ORDER BY ev.event_time DESC LIMIT 500`, [a.tenantId])).rows }));
  });
}

function newDeviceKey() {
  const prefix = `dev_${randomToken(6)}`;
  const secret = randomToken(32);
  return { prefix, secret, key: `${prefix}.${secret}` };
}

async function employeeAttendance(db: Db, tenantId: string, employeeId: string, from: string, to: string) {
  const days = await db.query(`SELECT d.work_date, d.day_type, d.status, d.first_in, d.last_out, d.punch_count, d.worked_minutes, d.late_minutes,
      d.early_exit_minutes, d.overtime_minutes, d.exceptions, d.locked, d.calc_version, d.leave_fraction, d.leave_type_code, s.code AS shift_code
    FROM attendance_daily d LEFT JOIN shifts s ON s.tenant_id=d.tenant_id AND s.id=d.shift_id
    WHERE d.tenant_id=$1 AND d.employee_id=$2 AND d.work_date BETWEEN $3 AND $4 ORDER BY d.work_date`, [tenantId, employeeId, from, to]);
  const { tz } = await employeeTimezone(db, tenantId, employeeId);
  const events = await db.query(`SELECT id, event_time, direction, source, status, device_time FROM attendance_events
    WHERE tenant_id=$1 AND employee_id=$2 AND event_time >= $3 AND event_time < $4 ORDER BY event_time`,
    [tenantId, employeeId, zonedToInstant(from, '00:00', tz), zonedToInstant(addDays(to, 1), '12:00', tz)]);
  return { timezone: tz, days: days.rows, events: events.rows };
}
