import type { FastifyInstance } from 'fastify';
import { only } from '../../core/features/routes.js';
import { z } from 'zod';
import { tenantActor, tenantActorAny, requireFeature, type TenantActor } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { badRequest, conflict, notFound } from '../../core/http/errors.js';
import { IsoDate, Uuid } from '../../core/http/pagination.js';
import type { Db } from '../../db/tx.js';
import { lockedDates, recalculateRange, teamEmployeeIds } from './service.js';
import { addDays, daysBetween, weekday } from './time.js';
import { getSettingValue } from '../../core/settings/service.js';
import { scheduleFor } from './roster.js';
import { orgToday } from '../../core/workflow/engine.js';

/**
 * Rotating shift rosters (docs/ATTENDANCE.md → Rosters). Patterns, who follows which pattern from when, one-day
 * overrides, and the roster view. Changes recalculate the affected days up to today (locked periods are never touched).
 */
const MAX_BACKDATE = 31;
const MAX_VIEW_DAYS = 42;

const PatternBody = z.object({
  code: z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/, 'Use letters, digits, - or _ (up to 20)')),
  name: z.string().trim().min(2).max(100),
  days: z.array(Uuid.nullable()).min(1).max(56),
});

async function checkShifts(db: Db, tenantId: string, days: (string | null)[]) {
  const ids = [...new Set(days.filter((d): d is string => !!d))];
  if (!ids.length) throw badRequest('A pattern needs at least one working day');
  const found = await db.query<{ id: string }>(`SELECT id FROM shifts WHERE tenant_id=$1 AND id = ANY($2) AND status='active'`, [tenantId, ids]);
  if (found.rowCount !== ids.length) throw badRequest('Every day must be an active shift or a day off');
}

/** Recalculate [from, to] up to today for these employees (results inside locked periods are left alone). */
async function recalc(db: Db, tenantId: string, employeeIds: string[], from: string, to: string | null) {
  const today = await orgToday(db, tenantId);
  const end = !to || to > today ? today : to;
  if (from > end) return 0;
  for (const id of employeeIds) await recalculateRange(db, tenantId, id, from, end);
  return employeeIds.length;
}

async function checkEmployees(db: Db, tenantId: string, ids: string[]) {
  const r = await db.query<{ id: string }>(`SELECT id FROM employees WHERE tenant_id=$1 AND id = ANY($2) AND status <> 'exited'`, [tenantId, ids]);
  if (r.rowCount !== new Set(ids).size) throw badRequest('Some employees were not found or have left');
}

async function checkStart(db: Db, a: TenantActor, date: string) {
  const today = await orgToday(db, a.tenantId);
  if (date < addDays(today, -MAX_BACKDATE)) throw badRequest(`Roster changes can go back at most ${MAX_BACKDATE} days`);
  if ((await lockedDates(db, a.tenantId, date, date)).size) throw conflict('That date is in a period locked for payroll');
}

/** End the rosters these employees follow after `lastDay` (withdrawing any not yet started). Returns how many changed. */
export async function endRosters(db: Db, tenantId: string, employeeIds: string[], lastDay: string) {
  const ended = await db.query(`UPDATE roster_assignments SET effective_to=$3 WHERE tenant_id=$1 AND employee_id = ANY($2)
      AND effective_from <= $3 AND (effective_to IS NULL OR effective_to > $3)`, [tenantId, employeeIds, lastDay]);
  const withdrawn = await db.query(`DELETE FROM roster_assignments WHERE tenant_id=$1 AND employee_id = ANY($2) AND effective_from > $3`, [tenantId, employeeIds, lastDay]);
  return (ended.rowCount ?? 0) + (withdrawn.rowCount ?? 0);
}

const IdParams = z.object({ id: Uuid });
const RosterPatternsBody = z.object({ name: z.string().trim().min(2).max(100).optional(), status: z.enum(['active', 'inactive']).optional(), days: PatternBody.shape.days.optional() });
const RosterAssignmentsBody = z.object({ employeeIds: z.array(Uuid).min(1).max(500), patternId: Uuid, effectiveFrom: IsoDate, effectiveTo: IsoDate.nullable().optional(),
      startDay: z.number().int().min(0).max(55).default(0) });
const RosterAssignmentsEndBody = z.object({ employeeIds: z.array(Uuid).min(1).max(500), lastDay: IsoDate });
const RosterOverridesBody = z.object({ employeeId: Uuid, date: IsoDate, shiftId: Uuid.nullable(), reason: z.string().trim().min(3).max(200) });
const RosterOverridesParams = z.object({ employeeId: Uuid, date: IsoDate });
const RosterQuery = z.object({ from: IsoDate, to: IsoDate, departmentId: Uuid.optional(), search: z.string().trim().max(60).optional() });
export async function rosterRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ patterns
  only(app, 'shifts').get('/roster-patterns', { schema: {}, config: { permAny: ['attendance.configure', 'attendance.read', 'attendance.team.read'], feature: ['shifts'] } }, async (req) => {
    const a = tenantActorAny(req, 'attendance.configure', 'attendance.read', 'attendance.team.read');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'shifts');
      return { items: (await db.query(`SELECT p.id, p.code, p.name, p.days, p.status, p.updated_at,
          (SELECT count(DISTINCT employee_id)::int FROM roster_assignments r WHERE r.tenant_id=p.tenant_id AND r.pattern_id=p.id
             AND (r.effective_to IS NULL OR r.effective_to >= current_date)) AS employees,
          EXISTS (SELECT 1 FROM roster_assignments r WHERE r.tenant_id=p.tenant_id AND r.pattern_id=p.id) AS used
        FROM roster_patterns p WHERE p.tenant_id=$1 ORDER BY p.status, p.code`, [a.tenantId])).rows };
    });
  });

  only(app, 'shifts').post('/roster-patterns', { schema: { body: PatternBody }, config: { perm: ['attendance.configure'], feature: ['shifts'] } }, async (req, reply) => {
    const a = tenantActor(req, 'attendance.configure');
    const b = PatternBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'shifts');
      await checkShifts(db, a.tenantId, b.days);
      if ((await db.query('SELECT 1 FROM roster_patterns WHERE tenant_id=$1 AND code=$2', [a.tenantId, b.code])).rowCount) throw conflict(`A pattern with code ${b.code} already exists`);
      const r = await db.query<{ id: string }>(`INSERT INTO roster_patterns (tenant_id, code, name, days, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [a.tenantId, b.code, b.name, b.days, a.user.userId]);
      await audit(db, { ...a.auditBase, action: 'attendance.roster_pattern_created', category: 'configuration', targetType: 'roster_pattern', targetId: r.rows[0]!.id, metadata: b });
      reply.code(201);
      return { id: r.rows[0]!.id };
    });
  });

  // Name and status can always change; the days only while nobody has followed the pattern (history must stay explainable).
  only(app, 'shifts').patch('/roster-patterns/:id', { schema: { params: IdParams, body: RosterPatternsBody }, config: { perm: ['attendance.configure'], feature: ['shifts'] } }, async (req) => {
    const a = tenantActor(req, 'attendance.configure');
    const { id } = IdParams.parse(req.params);
    const b = RosterPatternsBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'shifts');
      const cur = (await db.query<{ code: string; days: (string | null)[] }>('SELECT code, days FROM roster_patterns WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id])).rows[0];
      if (!cur) throw notFound('Pattern not found');
      if (b.days) {
        if ((await db.query('SELECT 1 FROM roster_assignments WHERE tenant_id=$1 AND pattern_id=$2 LIMIT 1', [a.tenantId, id])).rowCount)
          throw conflict('People have followed this pattern, so its days cannot change. Create a new pattern and move them to it');
        await checkShifts(db, a.tenantId, b.days);
      }
      await db.query(`UPDATE roster_patterns SET name=coalesce($3,name), status=coalesce($4,status), days=coalesce($5,days), updated_at=now() WHERE tenant_id=$1 AND id=$2`,
        [a.tenantId, id, b.name ?? null, b.status ?? null, b.days ?? null]);
      await audit(db, { ...a.auditBase, action: 'attendance.roster_pattern_updated', category: 'configuration', targetType: 'roster_pattern', targetId: id, metadata: { code: cur.code, ...b } });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ who follows which pattern
  only(app, 'shifts').post('/roster-assignments', { schema: { body: RosterAssignmentsBody }, config: { perm: ['attendance.configure'], feature: ['shifts'] } }, async (req) => {
    const a = tenantActor(req, 'attendance.configure');
    const b = RosterAssignmentsBody.parse(req.body);
    if (b.effectiveTo && b.effectiveTo < b.effectiveFrom) throw badRequest('The last day must be on or after the first day');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'shifts');
      const p = (await db.query<{ code: string; days: unknown[]; status: string }>('SELECT code, days, status FROM roster_patterns WHERE tenant_id=$1 AND id=$2', [a.tenantId, b.patternId])).rows[0];
      if (!p || p.status !== 'active') throw badRequest('Pattern not found or inactive');
      if (b.startDay >= p.days.length) throw badRequest(`Start day must be between 1 and ${p.days.length}`);
      await checkStart(db, a, b.effectiveFrom);
      await checkEmployees(db, a.tenantId, b.employeeIds);
      // The newest roster wins from its first day: earlier ones end the day before, later ones are withdrawn.
      await endRosters(db, a.tenantId, b.employeeIds, addDays(b.effectiveFrom, -1));
      for (const e of b.employeeIds) {
        await db.query(`INSERT INTO roster_assignments (tenant_id, employee_id, pattern_id, effective_from, effective_to, start_day, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [a.tenantId, e, b.patternId, b.effectiveFrom, b.effectiveTo ?? null, b.startDay, a.user.userId]);
      }
      const recalculated = await recalc(db, a.tenantId, b.employeeIds, b.effectiveFrom, b.effectiveTo ?? null);
      await audit(db, { ...a.auditBase, action: 'attendance.roster_assigned', category: 'configuration', targetType: 'roster_pattern', targetId: b.patternId,
        metadata: { pattern: p.code, employees: b.employeeIds.length, effectiveFrom: b.effectiveFrom, effectiveTo: b.effectiveTo ?? null, startDay: b.startDay + 1 } });
      return { assigned: b.employeeIds.length, recalculated };
    });
  });

  // Stop following a roster after `lastDay`; the fixed shift assignment applies again.
  only(app, 'shifts').post('/roster-assignments/end', { schema: { body: RosterAssignmentsEndBody }, config: { perm: ['attendance.configure'], feature: ['shifts'] } }, async (req) => {
    const a = tenantActor(req, 'attendance.configure');
    const b = RosterAssignmentsEndBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'shifts');
      await checkStart(db, a, addDays(b.lastDay, 1));
      const changed = await endRosters(db, a.tenantId, b.employeeIds, b.lastDay);
      if (!changed) throw conflict('None of them follows a roster after that day');
      await recalc(db, a.tenantId, b.employeeIds, addDays(b.lastDay, 1), null);
      await audit(db, { ...a.auditBase, action: 'attendance.roster_ended', category: 'configuration', targetType: 'employee', metadata: { employees: b.employeeIds.length, lastDay: b.lastDay } });
      return { ended: changed };
    });
  });

  // ------------------------------------------------------------ one-day changes (swap, cover, extra day off)
  only(app, 'shifts').put('/roster-overrides', { schema: { body: RosterOverridesBody }, config: { perm: ['attendance.configure'], feature: ['shifts'] } }, async (req) => {
    const a = tenantActor(req, 'attendance.configure');
    const b = RosterOverridesBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'shifts');
      await checkStart(db, a, b.date);
      await checkEmployees(db, a.tenantId, [b.employeeId]);
      if (b.shiftId && !(await db.query(`SELECT 1 FROM shifts WHERE tenant_id=$1 AND id=$2 AND status='active'`, [a.tenantId, b.shiftId])).rowCount) throw badRequest('Shift not found or inactive');
      await db.query(`INSERT INTO roster_overrides (tenant_id, employee_id, work_date, shift_id, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (tenant_id, employee_id, work_date) DO UPDATE SET shift_id=EXCLUDED.shift_id, reason=EXCLUDED.reason, created_by=EXCLUDED.created_by, created_at=now()`,
        [a.tenantId, b.employeeId, b.date, b.shiftId, b.reason, a.user.userId]);
      await recalc(db, a.tenantId, [b.employeeId], b.date, b.date);
      await audit(db, { ...a.auditBase, action: 'attendance.roster_override_set', category: 'configuration', targetType: 'employee', targetId: b.employeeId, metadata: b });
      return { ok: true };
    });
  });

  only(app, 'shifts').delete('/roster-overrides/:employeeId/:date', { schema: { params: RosterOverridesParams }, config: { perm: ['attendance.configure'], feature: ['shifts'] } }, async (req) => {
    const a = tenantActor(req, 'attendance.configure');
    const p = RosterOverridesParams.parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'shifts');
      await checkStart(db, a, p.date);
      const r = await db.query('DELETE FROM roster_overrides WHERE tenant_id=$1 AND employee_id=$2 AND work_date=$3', [a.tenantId, p.employeeId, p.date]);
      if (!r.rowCount) throw notFound('No change recorded for that day');
      await recalc(db, a.tenantId, [p.employeeId], p.date, p.date);
      await audit(db, { ...a.auditBase, action: 'attendance.roster_override_removed', category: 'configuration', targetType: 'employee', targetId: p.employeeId, metadata: p });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ the roster: who works what, day by day
  // Everyone (attendance.read / configure), the reporting team (attendance.team.read), or only yourself.
  only(app, 'shifts').get('/roster', { schema: { querystring: RosterQuery }, config: { permAny: ['attendance.configure', 'attendance.read', 'attendance.team.read', 'attendance.self'], feature: ['shifts'] } }, async (req) => {
    const a = tenantActorAny(req, 'attendance.configure', 'attendance.read', 'attendance.team.read', 'attendance.self');
    const q = RosterQuery.parse(req.query);
    if (q.to < q.from) throw badRequest('from must be on or before to');
    if (daysBetween(q.from, q.to) >= MAX_VIEW_DAYS) throw badRequest(`Show at most ${MAX_VIEW_DAYS} days at a time`);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'shifts');
      const all = a.has('attendance.read') || a.has('attendance.configure');
      const scope = all ? null : [...(a.has('attendance.team.read') && a.user.employeeId ? await teamEmployeeIds(db, a.tenantId, a.user.employeeId) : []), ...(a.user.employeeId ? [a.user.employeeId] : [])];
      const emps = (await db.query<{ id: string; code: string; name: string; department: string | null; branch_id: string }>(
        `SELECT e.id, e.employee_code AS code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, d.name AS department, e.branch_id
           FROM employees e LEFT JOIN departments d ON d.tenant_id=e.tenant_id AND d.id=e.department_id
          WHERE e.tenant_id=$1 AND e.status IN ('active','on_notice') AND ($2::uuid[] IS NULL OR e.id = ANY($2))
            AND ($3::uuid IS NULL OR e.department_id=$3)
            AND ($4::text IS NULL OR e.first_name||' '||coalesce(e.last_name,'') ILIKE '%'||$4||'%' OR e.employee_code ILIKE $4||'%')
          ORDER BY d.name NULLS LAST, e.first_name, e.last_name LIMIT 300`, [a.tenantId, scope, q.departmentId ?? null, q.search || null])).rows;
      const plan = await scheduleFor(db, a.tenantId, emps.map((e) => e.id), q.from, q.to);
      const shifts = (await db.query<{ id: string; code: string; name: string; start_time: string; end_time: string }>(
        `SELECT id, code, name, start_time::text, end_time::text FROM shifts WHERE tenant_id=$1 ORDER BY start_time`, [a.tenantId])).rows;
      const hol = (await db.query<{ holiday_date: string; branch_id: string | null; name: string }>(
        `SELECT holiday_date::text, branch_id, name FROM holidays WHERE tenant_id=$1 AND NOT optional AND holiday_date BETWEEN $2 AND $3`, [a.tenantId, q.from, q.to])).rows;
      const weeklyOffs = new Map<string, number[]>();
      const dates: string[] = []; for (let d = q.from; d <= q.to; d = addDays(d, 1)) dates.push(d);
      const items = [];
      for (const e of emps) {
        if (!weeklyOffs.has(e.branch_id)) weeklyOffs.set(e.branch_id, await getSettingValue<number[]>(db, a.tenantId, 'attendance.weekly_offs', e.branch_id));
        const wo = weeklyOffs.get(e.branch_id)!;
        items.push({ id: e.id, code: e.code, name: e.name, department: e.department, days: dates.map((d) => {
          const p = plan.get(e.id)!.get(d)!;
          const holiday = hol.find((h) => h.holiday_date === d && (h.branch_id === null || h.branch_id === e.branch_id))?.name ?? null;
          const off = p.off ?? wo.includes(weekday(d));
          return { date: d, shiftId: off ? null : p.shiftId, off, holiday, source: p.source, pattern: p.pattern ?? null, reason: p.reason ?? null };
        }) });
      }
      return { from: q.from, to: q.to, dates, shifts, items, canEdit: a.has('attendance.configure') };
    });
  });
}
