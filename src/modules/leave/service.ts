import { Decimal } from 'decimal.js';
import type { Db } from '../../db/tx.js';
import { scheduleFor } from '../attendance/roster.js';
import { getSettingValue } from '../../core/settings/service.js';
import { badRequest } from '../../core/http/errors.js';
import { addDays, dateRange, daysBetween, weekday } from '../attendance/time.js';

/**
 * Leave rules (docs/LEAVE.md):
 *  - Leave year = 12 months from `leave.year_start_month`; identified by the calendar
 *    year in which it starts (Apr 2026–Mar 2027 = 2026).
 *  - Days are counted per date: weekly offs (branch setting) and non-optional holidays
 *    (company-wide or the employee's branch) count 0 unless the type counts
 *    non-working days ("sandwich"). Half days: start in the second half, or end
 *    after the first half, count 0.5 for that date.
 *  - Balance = sum of the append-only ledger for (employee, type, leave year);
 *    available = balance − days of pending requests (reserved).
 * All arithmetic is decimal (no float drift).
 */

export interface LeaveType {
  id: string;
  code: string;
  name: string;
  paid: boolean;
  allow_half_day: boolean;
  requires_balance: boolean;
  accrual_method: 'none' | 'annual' | 'monthly';
  annual_entitlement: string;
  carry_forward_max: string;
  max_balance: string | null;
  count_non_working_days: boolean;
  min_notice_days: number;
  max_consecutive_days: string | null;
  eligible_after_days: number;
  applicable_employment_types: string[];
  status: string;
}

export const LEAVE_TYPE_COLS = `id, code, name, description, paid, allow_half_day, requires_balance, accrual_method, annual_entitlement,
  carry_forward_max, max_balance, count_non_working_days, min_notice_days, max_consecutive_days, eligible_after_days,
  applicable_employment_types, status, version`;

export const leaveYearOf = (date: string, startMonth: number) => {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return m >= startMonth ? y : y - 1;
};

export function leaveYearBounds(year: number, startMonth: number) {
  const start = `${year}-${String(startMonth).padStart(2, '0')}-01`;
  const next = startMonth === 1 ? `${year + 1}-01-01` : `${year + 1}-${String(startMonth).padStart(2, '0')}-01`;
  return { start, end: addDays(next, -1) };
}

export async function yearStartMonth(db: Db, tenantId: string) {
  return getSettingValue<number>(db, tenantId, 'leave.year_start_month');
}

export async function yearClosed(db: Db, tenantId: string, year: number) {
  return (await db.query('SELECT 1 FROM leave_year_closures WHERE tenant_id=$1 AND leave_year=$2', [tenantId, year])).rows.length > 0;
}

/** Balance per active leave type in the leave year of `asOf` (a year's balance already includes what was carried into it). */
export async function balancesAt(db: Db, tenantId: string, employeeId: string, asOf: string) {
  const leaveYear = leaveYearOf(asOf, await yearStartMonth(db, tenantId));
  const items = (
    await db.query<{ code: string; name: string; paid: boolean; balance: string }>(
      `SELECT t.code, t.name, t.paid, coalesce(sum(l.days),0)::text AS balance FROM leave_types t
    LEFT JOIN leave_ledger l ON l.tenant_id=t.tenant_id AND l.leave_type_id=t.id AND l.employee_id=$2 AND l.leave_year=$3
    WHERE t.tenant_id=$1 AND t.status='active' GROUP BY t.code, t.name, t.paid ORDER BY t.code`,
      [tenantId, employeeId, leaveYear],
    )
  ).rows;
  return { leaveYear, items };
}

export interface EmployeeLite {
  id: string;
  branch_id: string;
  employment_type: string;
  date_of_joining: string;
  exit_date: string | null;
  status: string;
  user_id: string | null;
}

export async function loadEmployee(db: Db, tenantId: string, employeeId: string): Promise<EmployeeLite | null> {
  const r = await db.query<EmployeeLite>(
    `SELECT id, branch_id, employment_type, date_of_joining, exit_date, status, user_id
    FROM employees WHERE tenant_id=$1 AND id=$2`,
    [tenantId, employeeId],
  );
  return r.rows[0] ?? null;
}

/**
 * Non-working dates (weekly offs + non-optional holidays) for an employee's branch within [from, to]. With the employee,
 * a rotating roster (or a one-day override) decides their days off instead of the weekly-off setting.
 */
export async function nonWorkingDates(db: Db, tenantId: string, branchId: string, from: string, to: string, employeeId?: string): Promise<Set<string>> {
  const weeklyOffs = await getSettingValue<number[]>(db, tenantId, 'attendance.weekly_offs', branchId);
  const hol = await db.query<{ holiday_date: string }>(
    `SELECT holiday_date FROM holidays WHERE tenant_id=$1 AND NOT optional
    AND (branch_id IS NULL OR branch_id=$2) AND holiday_date BETWEEN $3 AND $4`,
    [tenantId, branchId, from, to],
  );
  const out = new Set(hol.rows.map((h) => h.holiday_date));
  const plan = employeeId ? (await scheduleFor(db, tenantId, [employeeId], from, to)).get(employeeId) : undefined;
  for (const d of dateRange(from, to)) if (plan?.get(d)?.off ?? weeklyOffs.includes(weekday(d))) out.add(d);
  return out;
}

export type StartHalf = 'full' | 'second_half';
export type EndHalf = 'full' | 'first_half';

/** Fraction of leave on one date of a request (0, 0.5 or 1), before applying non-working days. */
export function dateFraction(date: string, r: { start_date: string; end_date: string; start_half: StartHalf; end_half: EndHalf }): number {
  if (date < r.start_date || date > r.end_date) return 0;
  let f = 1;
  if (date === r.start_date && r.start_half === 'second_half') f -= 0.5;
  if (date === r.end_date && r.end_half === 'first_half') f -= 0.5;
  return Math.max(0, f);
}

export function countDays(start: string, end: string, startHalf: StartHalf, endHalf: EndHalf, nonWorking: Set<string>, countNonWorking: boolean) {
  const perDate: { date: string; fraction: number }[] = [];
  let total = new Decimal(0);
  for (const d of dateRange(start, end)) {
    const f = nonWorking.has(d) && !countNonWorking ? 0 : dateFraction(d, { start_date: start, end_date: end, start_half: startHalf, end_half: endHalf });
    perDate.push({ date: d, fraction: f });
    total = total.plus(f);
  }
  return { days: total, perDate };
}

export async function balanceOf(db: Db, tenantId: string, employeeId: string, leaveTypeId: string, year: number, excludeRequestId?: string) {
  const r = await db.query<{ ledger: string; pending: string }>(
    `SELECT
      coalesce((SELECT sum(days) FROM leave_ledger WHERE tenant_id=$1 AND employee_id=$2 AND leave_type_id=$3 AND leave_year=$4), 0)::text AS ledger,
      coalesce((SELECT sum(days) FROM leave_requests WHERE tenant_id=$1 AND employee_id=$2 AND leave_type_id=$3 AND leave_year=$4
        AND status='pending' AND ($5::uuid IS NULL OR id <> $5)), 0)::text AS pending`,
    [tenantId, employeeId, leaveTypeId, year, excludeRequestId ?? null],
  );
  const ledger = new Decimal(r.rows[0]!.ledger);
  const pending = new Decimal(r.rows[0]!.pending);
  return { balance: ledger, pending, available: ledger.minus(pending) };
}

/** Throws a user-facing error if the type does not apply to this employee on the given date. */
export function assertApplicable(t: LeaveType, e: EmployeeLite, onDate: string) {
  if (t.status !== 'active') throw badRequest(`${t.name} is not currently available`);
  if (t.applicable_employment_types.length && !t.applicable_employment_types.includes(e.employment_type)) {
    throw badRequest(`${t.name} does not apply to ${e.employment_type.replace('_', ' ')} employees`);
  }
  if (t.eligible_after_days > 0 && daysBetween(e.date_of_joining, onDate) < t.eligible_after_days) {
    throw badRequest(`${t.name} is available after ${t.eligible_after_days} days of service`);
  }
}

/** Approved leave per date for one employee over a range (for attendance calculation). */
export async function approvedLeaveByDate(db: Db, tenantId: string, employeeId: string, from: string, to: string) {
  const r = await db.query<{ start_date: string; end_date: string; start_half: StartHalf; end_half: EndHalf; code: string; charged_off: boolean }>(
    `SELECT r.start_date, r.end_date, r.start_half, r.end_half, t.code, (t.count_non_working_days AND NOT t.paid) AS charged_off FROM leave_requests r
       JOIN leave_types t ON t.tenant_id=r.tenant_id AND t.id=r.leave_type_id
      WHERE r.tenant_id=$1 AND r.employee_id=$2 AND r.status='approved' AND r.start_date <= $4 AND r.end_date >= $3`,
    [tenantId, employeeId, from, to],
  );
  const map = new Map<string, { fraction: number; code: string; chargedOnOffDay: boolean }>();
  for (const req of r.rows) {
    for (const d of dateRange(req.start_date > from ? req.start_date : from, req.end_date < to ? req.end_date : to)) {
      // Never zero: `leave_requests_check1` refuses a one-day request made of its own two halves, the only way a date in range could count for nothing.
      const f = dateFraction(d, req);
      const prev = map.get(d);
      map.set(d, {
        fraction: Math.min(1, (prev?.fraction ?? 0) + f),
        code: prev && prev.code !== req.code ? `${prev.code}+${req.code}` : req.code,
        chargedOnOffDay: req.charged_off,
      });
    }
  }
  return map;
}
