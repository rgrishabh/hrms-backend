import type { Db } from '../../db/tx.js';
import { dateRange, daysBetween } from './time.js';

/**
 * What an employee is scheduled to work on a date, in order of precedence:
 *   1. a one-day override (swap, cover, extra day off)       source 'override'
 *   2. the rotating roster they follow on that date            source 'roster'
 *   3. their fixed shift assignment                            source 'assignment'
 * `off` is true / false when a roster or override decides the day (it replaces the weekly-off setting),
 * null when only a fixed shift applies (the weekly-off setting decides). On a rostered day off, `shiftId`
 * is the shift of the last working day before it in the cycle, so punches that day are read in the right window.
 */
export interface PlannedDay {
  shiftId: string | null;
  off: boolean | null;
  source: 'override' | 'roster' | 'assignment' | null;
  pattern?: string;
  reason?: string;
}

interface Roster {
  employee_id: string;
  effective_from: string;
  effective_to: string | null;
  start_day: number;
  days: (string | null)[];
  code: string;
}

/** The cycle day of `date` for a roster assignment (0-based). */
export const cycleDay = (r: { effective_from: string; start_day: number; days: unknown[] }, date: string) =>
  (((daysBetween(r.effective_from, date) + r.start_day) % r.days.length) + r.days.length) % r.days.length;

function rosterDay(r: Roster, date: string): { shiftId: string | null; off: boolean } {
  const i = cycleDay(r, date);
  const shift = r.days[i] ?? null;
  if (shift) return { shiftId: shift, off: false };
  for (let k = 1; k < r.days.length; k++) {
    // last working shift before this day off
    const prev = r.days[(i - k + r.days.length) % r.days.length];
    if (prev) return { shiftId: prev, off: true };
  }
  return { shiftId: null, off: true };
}

export async function scheduleFor(db: Db, tenantId: string, employeeIds: string[], from: string, to: string): Promise<Map<string, Map<string, PlannedDay>>> {
  const out = new Map<string, Map<string, PlannedDay>>(employeeIds.map((id) => [id, new Map()]));
  if (!employeeIds.length) return out;
  const fixed = (
    await db.query<{ employee_id: string; shift_id: string; effective_from: string; effective_to: string | null }>(
      `SELECT employee_id, shift_id, effective_from::text, effective_to::text FROM shift_assignments
      WHERE tenant_id=$1 AND employee_id = ANY($2) AND effective_from <= $4 AND (effective_to IS NULL OR effective_to >= $3)
      ORDER BY effective_from DESC, created_at DESC`,
      [tenantId, employeeIds, from, to],
    )
  ).rows;
  const rosters = (
    await db.query<Roster>(
      `SELECT a.employee_id, a.effective_from::text, a.effective_to::text, a.start_day, p.days, p.code FROM roster_assignments a
       JOIN roster_patterns p ON p.tenant_id=a.tenant_id AND p.id=a.pattern_id
      WHERE a.tenant_id=$1 AND a.employee_id = ANY($2) AND a.effective_from <= $4 AND (a.effective_to IS NULL OR a.effective_to >= $3)
      ORDER BY a.effective_from DESC, a.created_at DESC`,
      [tenantId, employeeIds, from, to],
    )
  ).rows;
  const overrides = (
    await db.query<{ employee_id: string; work_date: string; shift_id: string | null; reason: string }>(
      `SELECT employee_id, work_date::text, shift_id, reason FROM roster_overrides WHERE tenant_id=$1 AND employee_id = ANY($2) AND work_date BETWEEN $3 AND $4`,
      [tenantId, employeeIds, from, to],
    )
  ).rows;
  const covers = (x: { effective_from: string; effective_to: string | null }, d: string) => x.effective_from <= d && (x.effective_to === null || x.effective_to >= d);
  for (const id of employeeIds) {
    const days = out.get(id)!;
    const myFixed = fixed.filter((x) => x.employee_id === id);
    const myRosters = rosters.filter((x) => x.employee_id === id);
    for (const d of dateRange(from, to)) {
      const o = overrides.find((x) => x.employee_id === id && x.work_date === d);
      const r = myRosters.find((x) => covers(x, d));
      const f = myFixed.find((x) => covers(x, d));
      if (o) {
        // A day off keeps the window of what would otherwise have been worked.
        const under = r ? rosterDay(r, d).shiftId : (f?.shift_id ?? null);
        days.set(d, { shiftId: o.shift_id ?? under, off: o.shift_id === null, source: 'override', reason: o.reason, pattern: r?.code });
      } else if (r) days.set(d, { ...rosterDay(r, d), source: 'roster', pattern: r.code });
      else days.set(d, { shiftId: f?.shift_id ?? null, off: null, source: f ? 'assignment' : null });
    }
  }
  return out;
}
