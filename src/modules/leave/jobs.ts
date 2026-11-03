import { Decimal } from 'decimal.js';
import type { Db } from '../../db/tx.js';
import { conflict } from '../../core/http/errors.js';
import { addDays } from '../attendance/time.js';
import { leaveYearBounds, yearStartMonth, LEAVE_TYPE_COLS, type LeaveType } from './service.js';

/** First day of the k-th month (1-based) of a leave year. */
function monthStart(year: number, startMonth: number, k: number) {
  const m0 = startMonth - 1 + (k - 1);
  const y = year + Math.floor(m0 / 12);
  return `${y}-${String((m0 % 12) + 1).padStart(2, '0')}-01`;
}
function monthEnd(year: number, startMonth: number, k: number) {
  return addDays(monthStart(year, startMonth, k + 1), -1);
}

interface Emp { id: string; employment_type: string; date_of_joining: string; exit_date: string | null }

async function currentBalance(db: Db, tenantId: string, empId: string, typeId: string, year: number) {
  const r = await db.query<{ s: string }>(`SELECT coalesce(sum(days),0)::text AS s FROM leave_ledger
    WHERE tenant_id=$1 AND employee_id=$2 AND leave_type_id=$3 AND leave_year=$4`, [tenantId, empId, typeId, year]);
  return new Decimal(r.rows[0]!.s);
}

/** Insert a ledger entry once (by reference). Returns true if it was inserted. */
async function credit(db: Db, tenantId: string, e: { empId: string; typeId: string; year: number; entryType: string; days: Decimal; reference: string; note?: string; actorId: string | null; requestId?: string }) {
  if (e.days.isZero()) return false;
  const r = await db.query(`INSERT INTO leave_ledger (tenant_id, employee_id, leave_type_id, leave_year, entry_type, days, request_id, reference, note, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (tenant_id, reference) DO NOTHING`,
    [tenantId, e.empId, e.typeId, e.year, e.entryType, e.days.toFixed(2), e.requestId ?? null, e.reference, e.note ?? null, e.actorId]);
  return (r.rowCount ?? 0) > 0;
}
export { credit as insertLedgerEntry };

/** Cap a credit so the balance never exceeds the type's max_balance. */
async function capped(db: Db, tenantId: string, t: LeaveType, empId: string, year: number, amount: Decimal) {
  if (t.max_balance === null) return amount;
  const room = new Decimal(t.max_balance).minus(await currentBalance(db, tenantId, empId, t.id, year));
  return Decimal.max(0, Decimal.min(amount, room));
}

/**
 * Accrue entitlements for a leave year, up to `throughMonth` (1–12 within the year).
 * annual:  full entitlement once; joiners within the year get it pro-rated by remaining
 *          whole months (joining month counts), rounded DOWN to 0.5 day.
 * monthly: entitlement/12 (2 dp) for each month the employee was employed in.
 * Idempotent: each credit has a unique ledger reference.
 */
export async function runAccruals(db: Db, tenantId: string, year: number, throughMonth: number, actorId: string | null) {
  const startMonth = await yearStartMonth(db, tenantId);
  const { start: yStart, end: yEnd } = leaveYearBounds(year, startMonth);
  const types = (await db.query<LeaveType>(`SELECT ${LEAVE_TYPE_COLS} FROM leave_types WHERE tenant_id=$1 AND status='active' AND accrual_method <> 'none'`, [tenantId])).rows;
  const emps = (await db.query<Emp>(`SELECT id, employment_type, date_of_joining, exit_date FROM employees WHERE tenant_id=$1
    AND status IN ('active','on_notice','pre_joining') AND date_of_joining <= $3 AND (exit_date IS NULL OR exit_date >= $2)`, [tenantId, yStart, yEnd])).rows;
  let credited = 0; let skipped = 0;
  for (const t of types) {
    const ent = new Decimal(t.annual_entitlement);
    for (const e of emps) {
      if (t.applicable_employment_types.length && !t.applicable_employment_types.includes(e.employment_type)) continue;
      if (t.accrual_method === 'annual') {
        let amount = ent;
        if (e.date_of_joining > yStart) {
          let remaining = 0;
          for (let k = 1; k <= 12; k++) if (monthEnd(year, startMonth, k) >= e.date_of_joining) remaining++;
          amount = ent.times(remaining).div(12).times(2).floor().div(2);
        }
        amount = await capped(db, tenantId, t, e.id, year, amount);
        (await credit(db, tenantId, { empId: e.id, typeId: t.id, year, entryType: 'accrual', days: amount, reference: `accrual:${t.id}:${e.id}:${year}`,
          note: e.date_of_joining > yStart ? 'Annual entitlement (pro-rated for joining date)' : 'Annual entitlement', actorId })) ? credited++ : skipped++;
      } else {
        const perMonth = ent.div(12).toDecimalPlaces(2);
        for (let k = 1; k <= Math.min(12, throughMonth); k++) {
          const ms = monthStart(year, startMonth, k); const me = monthEnd(year, startMonth, k);
          if (e.date_of_joining > me || (e.exit_date && e.exit_date < ms)) continue;
          const amount = await capped(db, tenantId, t, e.id, year, perMonth);
          (await credit(db, tenantId, { empId: e.id, typeId: t.id, year, entryType: 'accrual', days: amount, reference: `accrual:${t.id}:${e.id}:${year}-m${k}`,
            note: `Monthly accrual ${ms.slice(0, 7)}`, actorId })) ? credited++ : skipped++;
        }
      }
    }
  }
  return { leaveYear: year, throughMonth, types: types.length, employees: emps.length, credited, alreadyCredited: skipped };
}

/**
 * Close a leave year: carry forward up to carry_forward_max into the next year and
 * lapse the rest. Refuses while requests of that year are pending. Idempotent.
 */
export async function runYearEnd(db: Db, tenantId: string, year: number, actorId: string | null) {
  const pending = await db.query<{ n: string }>(`SELECT count(*) AS n FROM leave_requests WHERE tenant_id=$1 AND leave_year=$2 AND status='pending'`, [tenantId, year]);
  if (Number(pending.rows[0]!.n) > 0) throw conflict(`${pending.rows[0]!.n} leave request(s) for ${year} are still pending. Resolve them before closing the year.`);
  const rows = (await db.query<{ employee_id: string; leave_type_id: string; closing: string }>(`SELECT employee_id, leave_type_id, sum(days)::text AS closing
    FROM leave_ledger WHERE tenant_id=$1 AND leave_year=$2 GROUP BY employee_id, leave_type_id HAVING sum(days) > 0`, [tenantId, year])).rows;
  const types = new Map((await db.query<LeaveType>(`SELECT ${LEAVE_TYPE_COLS} FROM leave_types WHERE tenant_id=$1`, [tenantId])).rows.map((t) => [t.id, t]));
  let carried = new Decimal(0); let lapsed = new Decimal(0); let processed = 0;
  for (const r of rows) {
    const t = types.get(r.leave_type_id)!;
    const closing = new Decimal(r.closing);
    const carry = Decimal.min(closing, new Decimal(t.carry_forward_max));
    const lapse = closing.minus(carry);
    const base = `${t.id}:${r.employee_id}:${year}`;
    const a = await credit(db, tenantId, { empId: r.employee_id, typeId: t.id, year, entryType: 'lapse', days: lapse.neg(), reference: `yearend:lapse:${base}`, note: `Lapsed at close of ${year}`, actorId });
    const b = await credit(db, tenantId, { empId: r.employee_id, typeId: t.id, year: year + 1, entryType: 'carry_forward', days: carry, reference: `yearend:carry:${base}`, note: `Carried forward from ${year}`, actorId });
    if (a || b) { processed++; carried = carried.plus(carry); lapsed = lapsed.plus(lapse); }
  }
  return { leaveYear: year, balancesProcessed: processed, daysCarried: carried.toFixed(2), daysLapsed: lapsed.toFixed(2) };
}
