import type { Db } from '../../db/tx.js';
import { dateRange } from '../attendance/time.js';

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
