import type { Db } from '../../db/tx.js';
import { getSettingValue } from '../../core/settings/service.js';
import { featureOn } from '../lifecycle/service.js';
import { addDays, daysBetween } from '../attendance/time.js';
import { calculate, CALC_VERSION, RULE_PARAMS, type Component, type RuleKind, type CalcInput } from './calc.js';
import { plannedRecoveries, applyRecoveries } from '../loans/service.js';
import { overtimeForRun } from '../overtime/service.js';

export function periodBounds(period: string) {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const start = `${period}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { start, end, days: daysBetween(start, end) + 1, month: m };
}

/** First day of the ESI contribution period holding `date`: 1 April to 30 September, 1 October to 31 March. */
export function esiContributionStart(date: string) {
  const y = Number(date.slice(0, 4)); const m = Number(date.slice(5, 7));
  return m >= 4 && m <= 9 ? `${y}-04-01` : `${m >= 10 ? y : y - 1}-10-01`;
}

/** Active, verified rule of a kind for the period (latest effective_from on or before the period end). */
async function rule(db: Db, tenantId: string, kind: RuleKind, scope: string, at: string) {
  const r = (await db.query<{ params: unknown }>(`SELECT params FROM statutory_rules WHERE tenant_id=$1 AND kind=$2 AND lower(scope)=lower($3) AND status='active'
    AND verified_by IS NOT NULL AND effective_from <= $4::date AND (effective_to IS NULL OR effective_to >= $4::date) ORDER BY effective_from DESC LIMIT 1`, [tenantId, kind, scope, at])).rows[0];
  if (!r) return undefined;
  const p = RULE_PARAMS[kind].safeParse(r.params);
  return p.success ? p.data : undefined;
}

/**
 * Loss-of-pay days from calculated attendance within [from, to]:
 * absent 1; missing punch 1 (setting); half day 0.5 for the half that was not worked, whatever covers the other half
 * (attendance only reports half_day alongside leave when the other half was NOT completed; a worked half gives present);
 * unpaid leave its fraction, also on a half_day or on a day otherwise worked or on field duty. Field duty (on_duty) is paid.
 * Days without a calculated row are paid but reported.
 */
export async function lossOfPay(db: Db, tenantId: string, employeeId: string, from: string, to: string) {
  const missingIsLop = await getSettingValue<boolean>(db, tenantId, 'payroll.missing_punch_is_lop');
  const rows = (await db.query<{ status: string; leave_fraction: string; paid: boolean | null }>(`SELECT d.status, d.leave_fraction::text, t.paid
    FROM attendance_daily d LEFT JOIN leave_types t ON t.tenant_id=d.tenant_id AND t.code=d.leave_type_code
    WHERE d.tenant_id=$1 AND d.employee_id=$2 AND d.work_date BETWEEN $3 AND $4`, [tenantId, employeeId, from, to])).rows;
  let lop = 0; let missingPunch = 0;
  for (const r of rows) {
    const lf = Number(r.leave_fraction);
    if (r.status === 'absent') lop += 1;
    else if (r.status === 'missing_punch') { missingPunch++; if (missingIsLop) lop += 1; }
    else if (r.status === 'half_day') lop += 0.5 + (r.paid === false ? lf : 0);
    else if (r.status === 'on_leave' && r.paid === false) lop += lf || 1;
    // A worked (or on-duty) day that includes half a day of unpaid leave loses that half.
    else if ((r.status === 'present' || r.status === 'on_duty') && lf > 0 && r.paid === false) lop += lf;
  }
  return { lop, missingPunch, uncalculated: Math.max(0, daysBetween(from, to) + 1 - rows.length) };
}

/**
 * The approved salaries in force over [from, to], oldest first, each with the stretch it covers. A later approval with the
 * same effective date has already superseded the earlier one. Days before the first salary belong to no stretch.
 */
export async function salaryVersions(db: Db, tenantId: string, employeeId: string, from: string, to: string) {
  const rows = (await db.query<{ id: string; amounts: Record<string, number>; effective_from: string }>(`SELECT id, amounts, effective_from::text FROM employee_salaries
    WHERE tenant_id=$1 AND employee_id=$2 AND status='active' AND effective_from <= $3::date ORDER BY effective_from`, [tenantId, employeeId, to])).rows;
  const inPeriod = rows.filter((s, x) => s.effective_from > from || !rows[x + 1] || rows[x + 1]!.effective_from > from);
  return inPeriod.map((s, x) => ({ id: s.id, amounts: s.amounts, start: s.effective_from > from ? s.effective_from : from,
    end: inPeriod[x + 1] ? addDays(inPeriod[x + 1]!.effective_from, -1) : to }));
}

/**
 * Paid days per stretch: its days less its loss of pay, then the manual loss-of-pay adjustment. Added days come off the
 * latest stretch first, and reversed days go back there first, never beyond the loss of pay it had.
 */
export function paidPerStretch(stretches: { days: number; lop: number }[], adjustment: number) {
  const paid = stretches.map((s) => Math.max(0, s.days - s.lop));
  let left = adjustment;
  for (let x = stretches.length - 1; x >= 0 && left !== 0; x--) {
    const move = left > 0 ? Math.min(left, paid[x]!) : -Math.min(-left, stretches[x]!.days - paid[x]!);
    paid[x]! -= move; left -= move;
  }
  return paid;
}

interface EmpForPay { id: string; employee_code: string; name: string; date_of_joining: string; exit_date: string | null; branch_state: string; pf_excluded: boolean | null; tax_regime: string | null; pt_state: string | null }

/** (Re)computes every item of a draft/computed run. Deterministic for the same inputs. */
export async function computeRun(db: Db, tenantId: string, runId: string) {
  const run = (await db.query<{ period: string; legal_entity_id: string; kind: string; employee_id: string | null }>(
    'SELECT period, legal_entity_id, kind, employee_id FROM payroll_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, runId])).rows[0]!;
  const p = periodBounds(run.period);
  const components = (await db.query<Component>(`SELECT code, name, kind, calc, base_codes, prorate, taxable, pf_wage, esi_wage, position FROM pay_components WHERE tenant_id=$1 AND status='active'`, [tenantId])).rows;
  const expect = (await getSettingValue<string>(db, tenantId, 'payroll.expected_statutory')).split(',').map((s) => s.trim()).filter(Boolean) as RuleKind[];
  const statutoryOn = await featureOn(db, tenantId, 'payroll.statutory');
  const attendanceOn = await featureOn(db, tenantId, 'attendance');
  const overtimeOn = await featureOn(db, tenantId, 'overtime');
  const loansOn = await featureOn(db, tenantId, 'advances_loans');
  // A recompute starts clean: overtime and loan instalments this run picked up before are offered to it again.
  await db.query('UPDATE overtime_claims SET payroll_run_id=NULL WHERE tenant_id=$1 AND payroll_run_id=$2', [tenantId, runId]);
  await db.query('DELETE FROM loan_recoveries WHERE tenant_id=$1 AND payroll_run_id=$2', [tenantId, runId]);
  const emps = (await db.query<EmpForPay>(`SELECT e.id, e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, e.date_of_joining::text, e.exit_date::text,
      b.state AS branch_state, s.pf_excluded, s.tax_regime, s.pt_state
    FROM employees e JOIN branches b ON b.tenant_id=e.tenant_id AND b.id=e.branch_id LEFT JOIN employee_statutory s ON s.tenant_id=e.tenant_id AND s.employee_id=e.id
    WHERE e.tenant_id=$1 AND e.legal_entity_id=$2 AND e.date_of_joining <= $4::date AND (e.exit_date IS NULL OR e.exit_date >= $3::date)
      AND e.status IN ('active','on_notice','exited') AND ($5::uuid IS NULL OR e.id=$5) ORDER BY e.employee_code`,
    [tenantId, run.legal_entity_id, p.start, p.end, run.kind === 'fnf' ? run.employee_id : null])).rows;
  await db.query('DELETE FROM payroll_items WHERE tenant_id=$1 AND run_id=$2', [tenantId, runId]);
  const totals = { employees: 0, gross: 0, deductions: 0, net: 0, employerCost: 0, held: 0 };
  let warningCount = 0;
  const ruleCache = new Map<string, unknown>();
  const cached = async (kind: RuleKind, scope: string) => {
    const k = `${kind}:${scope}`;
    if (!ruleCache.has(k)) ruleCache.set(k, statutoryOn ? await rule(db, tenantId, kind, scope, p.end) : undefined);
    return ruleCache.get(k) as never;
  };
  for (const e of emps) {
    const from = e.date_of_joining > p.start ? e.date_of_joining : p.start;
    const to = e.exit_date && e.exit_date < p.end ? e.exit_date : p.end;
    const versions = await salaryVersions(db, tenantId, e.id, from, to);
    if (!versions.length) continue; // not on payroll
    const employed = daysBetween(from, to) + 1;
    const warnings: string[] = [];
    if (versions[0]!.start > from) warnings.push(`no salary before ${versions[0]!.start}: earlier days are unpaid`);
    // Loss of pay falls on the stretch where it happened; each stretch is paid at its own rate.
    const stretches = versions.map((v) => ({ ...v, days: daysBetween(v.start, v.end) + 1, lop: 0 }));
    if (attendanceOn) {
      let missingPunch = 0; let uncalculated = 0;
      for (const v of stretches) {
        const l = await lossOfPay(db, tenantId, e.id, v.start, v.end);
        v.lop = l.lop; missingPunch += l.missingPunch; uncalculated += l.uncalculated;
      }
      if (missingPunch) warnings.push(`${missingPunch} unresolved missing-punch day(s)`);
      if (uncalculated) warnings.push(`attendance not calculated for ${uncalculated} day(s) — paid`);
    }
    const adj = (await db.query<{ kind: 'earning' | 'deduction' | 'lop_days'; label: string; amount: string; taxable: boolean }>(
      'SELECT kind, label, amount::text, taxable FROM payroll_adjustments WHERE tenant_id=$1 AND run_id=$2 AND employee_id=$3 ORDER BY created_at', [tenantId, runId, e.id])).rows;
    const lopAdjustment = adj.filter((a) => a.kind === 'lop_days').reduce((s, a) => s + Number(a.amount), 0);
    const lop = Math.max(0, stretches.reduce((t, v) => t + v.lop, 0) + lopAdjustment);
    const paid = paidPerStretch(stretches, lopAdjustment);
    const paidDays = paid.reduce((t, d) => t + d, 0);
    const adjustments = adj.filter((a) => a.kind !== 'lop_days').map((a) => ({ kind: a.kind as 'earning' | 'deduction', label: a.label, amount: Number(a.amount), taxable: a.taxable }));
    if (overtimeOn) {
      const ot = await overtimeForRun(db, tenantId, runId, e.id, p.end, components);
      if (ot.adjustment) adjustments.push(ot.adjustment);
      warnings.push(...ot.warnings);
    }
    const regime = (e.tax_regime ?? 'new') as 'new' | 'old';
    const ptState = e.pt_state ?? e.branch_state ?? null;
    // Salary in force when the contribution period began (or the earliest one since, for a joiner): decides ESI cover.
    const cpStart = esiContributionStart(p.start);
    const esiCover = (await db.query<{ amounts: Record<string, number> }>(`SELECT amounts FROM employee_salaries WHERE tenant_id=$1 AND employee_id=$2 AND status='active' AND effective_from <= $4::date
      ORDER BY (effective_from <= $3::date) DESC, CASE WHEN effective_from <= $3::date THEN effective_from END DESC, effective_from ASC LIMIT 1`, [tenantId, e.id, cpStart, p.end])).rows[0];
    const input: CalcInput = {
      month: p.month, esiCoverageAmounts: esiCover?.amounts, daysInPeriod: p.days, paidDays, components, amounts: stretches[stretches.length - 1]!.amounts,
      ...(stretches.length > 1 ? { segments: stretches.map((v, x) => ({ amounts: v.amounts, paidDays: paid[x]!, days: v.days, from: v.start })) } : {}),
      adjustments,
      statutory: { pfExcluded: !!e.pf_excluded, regime, ptState },
      rules: { pf: await cached('pf', 'IN'), esi: await cached('esi', 'IN'), pt: ptState ? await cached('pt', ptState) : undefined, lwf: ptState ? await cached('lwf', ptState) : undefined, tds: await cached('tds', regime) },
      expect: statutoryOn ? expect : [],
    };
    let r = calculate(input);
    if (loansOn) {
      // Loan instalments come off what is left after everything else, never taking net pay below zero.
      const planned = await plannedRecoveries(db, tenantId, runId, e.id, run.period, run.kind === 'fnf');
      if (planned.length) {
        const rec = await applyRecoveries(db, tenantId, runId, run.period, planned, r.net);
        warnings.push(...rec.warnings);
        if (rec.adjustments.length) r = calculate({ ...input, adjustments: [...adjustments, ...rec.adjustments] });
      }
    }
    warnings.push(...r.warnings);
    await db.query(`INSERT INTO payroll_items (tenant_id, run_id, employee_id, salary_id, days_in_period, employed_days, lop_days, paid_days, lines, gross, deductions, net, employer_cost, warnings, hold, calc_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [tenantId, runId, e.id, stretches[stretches.length - 1]!.id, p.days, employed, lop, paidDays, JSON.stringify(r.lines), r.gross, r.deductions, r.net, r.employerCost, JSON.stringify(warnings), r.net < 0, CALC_VERSION]);
    totals.employees++; totals.gross += r.gross; totals.deductions += r.deductions; totals.net += r.net; totals.employerCost += r.employerCost; if (r.net < 0) totals.held++;
    warningCount += warnings.length;
  }
  for (const k of ['gross', 'deductions', 'net', 'employerCost'] as const) totals[k] = Math.round(totals[k] * 100) / 100;
  await db.query(`UPDATE payroll_runs SET status='computed', totals=$3, warnings=$4, warnings_acknowledged=false, computed_at=now() WHERE tenant_id=$1 AND id=$2`,
    [tenantId, runId, JSON.stringify(totals), warningCount]);
  return { totals, warnings: warningCount };
}

/** Attendance must be locked for the whole period before payroll is finalized (when attendance is on). */
export async function attendanceLocked(db: Db, tenantId: string, period: string) {
  if (!(await featureOn(db, tenantId, 'attendance'))) return true;
  const p = periodBounds(period);
  const r = await db.query(`SELECT 1 FROM attendance_period_locks WHERE tenant_id=$1 AND period_start <= $2::date AND period_end >= $3::date`, [tenantId, p.start, p.end]);
  return (r.rowCount ?? 0) > 0;
}
