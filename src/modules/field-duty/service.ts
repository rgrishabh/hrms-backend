import type { Db } from '../../db/tx.js';
import { dateRange } from '../attendance/time.js';
import { conflict } from '../../core/http/errors.js';
import { dateFraction, type StartHalf, type EndHalf } from '../leave/service.js';

export type DayPart = 'full' | 'first_half' | 'second_half';
export const PURPOSES = ['field_sampling', 'client_visit', 'site_audit', 'training', 'official_work', 'other'] as const;
export const PURPOSE_LABEL: Record<(typeof PURPOSES)[number], string> = {
  field_sampling: 'field sampling', client_visit: 'client visit', site_audit: 'site audit', training: 'training', official_work: 'official work', other: 'field duty',
};

/** Fraction of `date` a request covers: halves only exist for single-day requests. */
export const dutyFraction = (part: DayPart) => (part === 'full' ? 1 : 0.5);

/**
 * Approved field duty per date for one employee in [from, to] (fraction 0.5 or 1).
 * Approved duty always counts, whether or not the module is still switched on: it was approved.
 */
export async function approvedDutyByDate(db: Db, tenantId: string, employeeId: string, from: string, to: string) {
  const r = await db.query<{ start_date: string; end_date: string; day_part: DayPart }>(
    `SELECT start_date::text, end_date::text, day_part FROM field_duty_requests
      WHERE tenant_id=$1 AND employee_id=$2 AND status='approved' AND start_date <= $4 AND end_date >= $3`, [tenantId, employeeId, from, to]);
  const map = new Map<string, { fraction: number }>();
  for (const req of r.rows) {
    for (const d of dateRange(req.start_date > from ? req.start_date : from, req.end_date < to ? req.end_date : to)) {
      map.set(d, { fraction: Math.min(1, (map.get(d)?.fraction ?? 0) + dutyFraction(req.day_part)) });
    }
  }
  return map;
}

export const span = (d: { start_date: string; end_date: string; day_part: DayPart }) =>
  d.start_date === d.end_date ? `${d.start_date}${d.day_part === 'full' ? '' : d.day_part === 'first_half' ? ' (first half)' : ' (second half)'}` : `${d.start_date} to ${d.end_date}`;

/** Refuse a day already fully taken by other field duty or leave (pending or approved). Complementary halves are fine. */
export async function assertNoOverlap(db: Db, tenantId: string, employeeId: string, b: { startDate: string; endDate: string; dayPart: DayPart }) {
  const mine = dutyFraction(b.dayPart);
  const duties = (await db.query<{ start_date: string; end_date: string; day_part: DayPart; status: string }>(`SELECT start_date::text, end_date::text, day_part, status
    FROM field_duty_requests WHERE tenant_id=$1 AND employee_id=$2 AND status IN ('pending','approved') AND start_date <= $4 AND end_date >= $3`,
    [tenantId, employeeId, b.startDate, b.endDate])).rows;
  for (const d of duties) {
    const sameHalf = b.dayPart !== 'full' && d.day_part !== 'full' && d.day_part === b.dayPart;
    if (b.dayPart === 'full' || d.day_part === 'full' || sameHalf) throw conflict(`Overlaps ${d.status} field duty (${span(d)})`);
  }
  const leaves = (await db.query<{ start_date: string; end_date: string; start_half: StartHalf; end_half: EndHalf; status: string }>(`SELECT start_date::text, end_date::text, start_half, end_half, status
    FROM leave_requests WHERE tenant_id=$1 AND employee_id=$2 AND status IN ('pending','approved') AND start_date <= $4 AND end_date >= $3`,
    [tenantId, employeeId, b.startDate, b.endDate])).rows;
  for (const l of leaves) {
    for (const date of dateRange(b.startDate > l.start_date ? b.startDate : l.start_date, b.endDate < l.end_date ? b.endDate : l.end_date)) {
      const lf = dateFraction(date, l);
      // Half-day leave and half-day duty fit together only as opposite halves (leave's second half starts the day it begins; its first half ends the day it ends).
      const leaveHalf = lf === 0.5 ? (date === l.start_date && l.start_half === 'second_half' ? 'second_half' : 'first_half') : null;
      if (lf + mine > 1 || (leaveHalf && leaveHalf === b.dayPart)) throw conflict(`Overlaps ${l.status} leave on ${date}`);
    }
  }
}
