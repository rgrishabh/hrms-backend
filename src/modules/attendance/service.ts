import type { Db } from '../../db/tx.js';
import { getSettingValue } from '../../core/settings/service.js';
import { calculateDay, CALC_VERSION, type ShiftPolicy, type Punch, type DayResult } from './calc.js';
import { addDays, dateRange, localDate, weekday, zonedToInstant } from './time.js';
import { notFound } from '../../core/http/errors.js';
import { approvedLeaveByDate } from '../leave/service.js';
import { approvedDutyByDate } from '../field-duty/service.js';

export interface EventInput {
  employeeId: string | null;
  source: 'web' | 'mobile' | 'biometric' | 'regularization';
  sourceRef: string;
  eventTime: Date;
  deviceTime?: Date | null;
  direction?: 'in' | 'out' | 'unknown';
  deviceId?: string | null;
  deviceUserId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  status?: 'accepted' | 'unmapped';
  createdBy?: string | null;
}

/** Idempotent insert keyed on (tenant, source, source_ref). Returns null when it was a duplicate. */
export async function recordEvent(db: Db, tenantId: string, e: EventInput): Promise<{ id: string } | null> {
  const r = await db.query<{ id: string }>(`INSERT INTO attendance_events (tenant_id, employee_id, source, source_ref, event_time, device_time,
      direction, device_id, device_user_id, latitude, longitude, status, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (tenant_id, source, source_ref) DO NOTHING RETURNING id`,
    [tenantId, e.employeeId, e.source, e.sourceRef, e.eventTime, e.deviceTime ?? null, e.direction ?? 'unknown', e.deviceId ?? null,
     e.deviceUserId ?? null, e.latitude ?? null, e.longitude ?? null, e.status ?? 'accepted', e.createdBy ?? null]);
  return r.rows[0] ?? null;
}

export async function employeeTimezone(db: Db, tenantId: string, employeeId: string): Promise<{ tz: string; branchId: string }> {
  const r = await db.query<{ branch_id: string }>('SELECT branch_id FROM employees WHERE tenant_id=$1 AND id=$2', [tenantId, employeeId]);
  if (!r.rows[0]) throw notFound('Employee not found');
  const branchId = r.rows[0].branch_id;
  return { tz: await getSettingValue<string>(db, tenantId, 'general.timezone', branchId), branchId };
}

/** Work dates whose punch window could contain `instant` (its local date and the day before, for overnight shifts). */
export function candidateDates(instant: Date, tz: string): string[] {
  const d = localDate(instant, tz);
  return [addDays(d, -1), d];
}

export async function lockedDates(db: Db, tenantId: string, from: string, to: string): Promise<Set<string>> {
  const r = await db.query<{ period_start: string; period_end: string }>(
    `SELECT period_start, period_end FROM attendance_period_locks WHERE tenant_id=$1 AND period_start <= $3 AND period_end >= $2`, [tenantId, from, to]);
  const s = new Set<string>();
  for (const l of r.rows) for (const d of dateRange(l.period_start > from ? l.period_start : from, l.period_end < to ? l.period_end : to)) s.add(d);
  return s;
}

const SHIFT_COLS = `s.id, s.code, s.start_time::text AS start_time, s.end_time::text AS end_time, s.break_minutes, s.grace_minutes,
  s.early_exit_grace_minutes, s.half_day_min_minutes, s.full_day_min_minutes, s.overtime_after_minutes`;
const toShift = (r: Record<string, unknown>): ShiftPolicy => ({
  id: r.id as string, code: r.code as string, startTime: r.start_time as string, endTime: r.end_time as string,
  breakMinutes: r.break_minutes as number, graceMinutes: r.grace_minutes as number, earlyExitGraceMinutes: r.early_exit_grace_minutes as number,
  halfDayMinMinutes: r.half_day_min_minutes as number, fullDayMinMinutes: r.full_day_min_minutes as number,
  overtimeAfterMinutes: r.overtime_after_minutes as number | null,
});

/**
 * Recalculate one employee over [from, to] using a constant number of queries.
 * Locked dates are skipped (never silently changed). Returns per-date results.
 */
export async function recalculateRange(db: Db, tenantId: string, employeeId: string, from: string, to: string) {
  const emp = await db.query<{ branch_id: string; date_of_joining: string; exit_date: string | null }>(
    'SELECT branch_id, date_of_joining, exit_date FROM employees WHERE tenant_id=$1 AND id=$2', [tenantId, employeeId]);
  const e = emp.rows[0];
  if (!e) throw notFound('Employee not found');
  const tz = await getSettingValue<string>(db, tenantId, 'general.timezone', e.branch_id);
  const weeklyOffs = await getSettingValue<number[]>(db, tenantId, 'attendance.weekly_offs', e.branch_id);
  const minGap = await getSettingValue<number>(db, tenantId, 'attendance.min_punch_gap_seconds');
  const overtimeEnabled = await getSettingValue<boolean>(db, tenantId, 'attendance.overtime_enabled');

  const assignments = (await db.query(`SELECT a.effective_from, a.effective_to, ${SHIFT_COLS} FROM shift_assignments a
      JOIN shifts s ON s.tenant_id=a.tenant_id AND s.id=a.shift_id
     WHERE a.tenant_id=$1 AND a.employee_id=$2 AND a.effective_from <= $4 AND (a.effective_to IS NULL OR a.effective_to >= $3)
     ORDER BY a.effective_from DESC, a.created_at DESC`, [tenantId, employeeId, from, to])).rows;
  const holidays = new Set((await db.query<{ holiday_date: string }>(`SELECT holiday_date FROM holidays WHERE tenant_id=$1
      AND (branch_id IS NULL OR branch_id=$2) AND NOT optional AND holiday_date BETWEEN $3 AND $4`, [tenantId, e.branch_id, from, to])).rows.map((r) => r.holiday_date));
  // Events span from (from − 1 day) to (to + 2 days) to cover overnight windows.
  const evFrom = zonedToInstant(addDays(from, -1), '00:00', tz);
  const evTo = zonedToInstant(addDays(to, 2), '00:00', tz);
  const punches: Punch[] = (await db.query<{ id: string; event_time: Date; direction: Punch['direction'] }>(
    `SELECT id, event_time, direction FROM attendance_events WHERE tenant_id=$1 AND employee_id=$2 AND status='accepted'
       AND event_time >= $3 AND event_time < $4 ORDER BY event_time`, [tenantId, employeeId, evFrom, evTo])).rows
    .map((r) => ({ id: r.id, time: r.event_time, direction: r.direction }));
  const locked = await lockedDates(db, tenantId, from, to);
  const leaves = await approvedLeaveByDate(db, tenantId, employeeId, from, to);
  const duties = await approvedDutyByDate(db, tenantId, employeeId, from, to);

  const results: (DayResult & { locked: boolean })[] = [];
  const rows: unknown[][] = [];
  for (const date of dateRange(from, to)) {
    if (locked.has(date)) { continue; }
    const asg = assignments.find((a) => a.effective_from <= date && (a.effective_to === null || a.effective_to >= date));
    const shift = asg ? toShift(asg) : null;
    const dayType = holidays.has(date) ? 'holiday' : weeklyOffs.includes(weekday(date)) ? 'weekly_off' : 'working';
    const res = calculateDay({ workDate: date, timezone: tz, shift, dayType, punches, minGapSeconds: minGap, overtimeEnabled,
      employment: { joiningDate: e.date_of_joining, exitDate: e.exit_date }, leave: leaves.get(date) ?? null, duty: duties.get(date) ?? null });
    results.push({ ...res, locked: false });
    rows.push([date, res.shiftId, res.dayType, res.status, res.firstIn, res.lastOut, res.punchCount, res.workedMinutes, res.lateMinutes,
      res.earlyExitMinutes, res.overtimeMinutes, res.exceptions,
      JSON.stringify({ timezone: tz, weeklyOffs, minGapSeconds: minGap, overtimeEnabled, shift: shift?.code ?? null }), res.leaveFraction, res.leaveTypeCode, res.dutyFraction]);
  }
  if (rows.length) {
    const values: unknown[] = [tenantId, employeeId, CALC_VERSION];
    const tuples = rows.map((r) => {
      const base = values.length;
      values.push(...r);
      return `($1,$2,${r.map((_, i) => `$${base + i + 1}`).join(',')},$3,now())`;
    });
    await db.query(`INSERT INTO attendance_daily (tenant_id, employee_id, work_date, shift_id, day_type, status, first_in, last_out, punch_count,
        worked_minutes, late_minutes, early_exit_minutes, overtime_minutes, exceptions, policy_snapshot, leave_fraction, leave_type_code, duty_fraction, calc_version, calculated_at)
      VALUES ${tuples.join(',')}
      ON CONFLICT (tenant_id, employee_id, work_date) DO UPDATE SET shift_id=EXCLUDED.shift_id, day_type=EXCLUDED.day_type, status=EXCLUDED.status,
        first_in=EXCLUDED.first_in, last_out=EXCLUDED.last_out, punch_count=EXCLUDED.punch_count, worked_minutes=EXCLUDED.worked_minutes,
        late_minutes=EXCLUDED.late_minutes, early_exit_minutes=EXCLUDED.early_exit_minutes, overtime_minutes=EXCLUDED.overtime_minutes,
        exceptions=EXCLUDED.exceptions, policy_snapshot=EXCLUDED.policy_snapshot, leave_fraction=EXCLUDED.leave_fraction,
        leave_type_code=EXCLUDED.leave_type_code, duty_fraction=EXCLUDED.duty_fraction, calc_version=EXCLUDED.calc_version, calculated_at=now()
      WHERE NOT attendance_daily.locked`, values);
  }
  return { results, skippedLocked: [...locked] };
}

/** After an event: recalc the dates whose windows may contain it, but never past today. */
export async function recalcForEvent(db: Db, tenantId: string, employeeId: string, eventTime: Date) {
  const { tz } = await employeeTimezone(db, tenantId, employeeId);
  const [from, to] = candidateDates(eventTime, tz) as [string, string];
  return recalculateRange(db, tenantId, employeeId, from, to);
}

/** Employee ids visible to a manager: full recursive reporting subtree. */
export async function teamEmployeeIds(db: Db, tenantId: string, managerEmployeeId: string): Promise<string[]> {
  const r = await db.query<{ id: string }>(`WITH RECURSIVE sub AS (
      SELECT id FROM employees WHERE tenant_id=$1 AND reporting_manager_id=$2
      UNION SELECT e.id FROM employees e JOIN sub ON e.reporting_manager_id=sub.id WHERE e.tenant_id=$1)
    SELECT id FROM sub`, [tenantId, managerEmployeeId]);
  return r.rows.map((x) => x.id);
}
