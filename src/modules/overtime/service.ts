import { Decimal } from 'decimal.js';
import type { Db } from '../../db/tx.js';
import { openAmounts } from '../payroll/sealed.js';
import { getSettingValue } from '../../core/settings/service.js';
import { calculate, type Adjustment, type Component } from '../payroll/calc.js';

/** Organization-entered pay settings. `missing` lists what is not set; overtime cannot be paid until it is empty. */
export async function overtimePaySettings(db: Db, tenantId: string) {
  const multiplier = await getSettingValue<number | null>(db, tenantId, 'overtime.rate_multiplier');
  const basis = (await getSettingValue<string>(db, tenantId, 'overtime.rate_basis')).split(',').map((x) => x.trim()).filter(Boolean);
  const divisor = await getSettingValue<number | null>(db, tenantId, 'overtime.days_divisor');
  const hoursPerDay = await getSettingValue<number | null>(db, tenantId, 'overtime.hours_per_day');
  const esi = await getSettingValue<'' | 'include' | 'exclude'>(db, tenantId, 'overtime.esi_wages');
  const missing = [
    multiplier == null && 'pay rate', !basis.length && 'ordinary rate components', divisor == null && 'days per month',
    hoursPerDay == null && 'hours per day', !esi && 'ESI treatment',
  ].filter(Boolean) as string[];
  return { multiplier, basis, divisor, hoursPerDay, esiWage: esi === 'include', missing };
}

/** Compensatory off: the configured leave type (active), if offered. */
export async function compOffType(db: Db, tenantId: string) {
  const code = await getSettingValue<string>(db, tenantId, 'overtime.comp_off_leave_type');
  if (!code) return null;
  return (await db.query<{ id: string; code: string; name: string }>(`SELECT id, code, name FROM leave_types WHERE tenant_id=$1 AND code=$2 AND status='active'`, [tenantId, code])).rows[0] ?? null;
}

/** Days off earned by `minutes` of overtime: whole halves of the configured day, 0 if less than half a day. */
export const compOffDays = (minutes: number, dayMinutes: number) => Math.floor(minutes / (dayMinutes / 2)) / 2;

const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

/**
 * The overtime earning for one employee in a payroll run: every approved, paid-out claim
 * up to the period end not already in another live run (earlier months are paid as arrears).
 * Each claim is priced on the salary in force on the day worked. Claims are attached to the run;
 * the caller first releases claims of this run so a recompute starts clean.
 */
export async function overtimeForRun(db: Db, tenantId: string, runId: string, employeeId: string, periodEnd: string, components: Component[]):
  Promise<{ adjustment: Adjustment | null; warnings: string[] }> {
  const claims = (await db.query<{ id: string; work_date: string; minutes: number }>(`SELECT c.id, c.work_date::text, c.minutes FROM overtime_claims c
      LEFT JOIN payroll_runs r ON r.tenant_id=c.tenant_id AND r.id=c.payroll_run_id
     WHERE c.tenant_id=$1 AND c.employee_id=$2 AND c.status='approved' AND c.payout='pay' AND c.work_date <= $3::date
       AND (c.payroll_run_id IS NULL OR r.status='cancelled') ORDER BY c.work_date`, [tenantId, employeeId, periodEnd])).rows;
  if (!claims.length) return { adjustment: null, warnings: [] };
  const s = await overtimePaySettings(db, tenantId);
  const totalMinutes = claims.reduce((t, c) => t + c.minutes, 0);
  if (s.missing.length) return { adjustment: null, warnings: [`${hours(totalMinutes)} h approved overtime not paid: set the overtime ${s.missing.join(', ')}`] };
  const warnings: string[] = [];
  let amount = new Decimal(0); let paidMinutes = 0; const included: string[] = [];
  for (const c of claims) {
    const sal = (await db.query<{ amounts_enc: string }>(`SELECT amounts_enc FROM employee_salaries WHERE tenant_id=$1 AND employee_id=$2 AND status='active'
      AND effective_from <= $3::date ORDER BY effective_from DESC LIMIT 1`, [tenantId, employeeId, c.work_date])).rows[0];
    if (!sal) { warnings.push(`overtime on ${c.work_date} not paid: no salary in force that day`); continue; }
    // Monthly (unprorated) component amounts, computed exactly as payroll does.
    const monthly = calculate({ month: Number(c.work_date.slice(5, 7)), daysInPeriod: 1, paidDays: 1, components, amounts: openAmounts(sal.amounts_enc), adjustments: [],
      statutory: { pfExcluded: true, regime: 'new', ptState: null }, rules: {}, expect: [] }).lines;
    const ordinary = monthly.filter((l) => l.kind === 'earning' && s.basis.includes(l.code)).reduce((t, l) => t.plus(l.amount), new Decimal(0));
    if (ordinary.lte(0)) { warnings.push(`overtime on ${c.work_date} not paid: none of ${s.basis.join(', ')} in the salary`); continue; }
    const [y, m] = c.work_date.split('-').map(Number) as [number, number];
    const days = s.divisor === 0 ? new Date(Date.UTC(y, m, 0)).getUTCDate() : s.divisor!;
    amount = amount.plus(ordinary.div(days).div(s.hoursPerDay!).times(c.minutes).div(60).times(s.multiplier!));
    paidMinutes += c.minutes; included.push(c.id);
  }
  if (!included.length) return { adjustment: null, warnings };
  await db.query('UPDATE overtime_claims SET payroll_run_id=$3 WHERE tenant_id=$1 AND id = ANY($2)', [tenantId, included, runId]);
  const earliest = claims.find((c) => included.includes(c.id))!.work_date;
  const arrears = earliest < periodEnd.slice(0, 8) + '01' ? `, from ${earliest}` : '';
  return {
    adjustment: { kind: 'earning', code: 'OT', label: `Overtime (${hours(paidMinutes)} h${arrears})`, amount: amount.toDecimalPlaces(2).toNumber(), taxable: true,
      esiWage: s.esiWage, basis: `${hours(paidMinutes)} h × ${s.multiplier} × ordinary hourly rate (${s.basis.join('+')} ÷ ${s.divisor === 0 ? 'days in month' : s.divisor} ÷ ${s.hoursPerDay} h)` },
    warnings,
  };
}
