import type { Db } from '../../db/tx.js';
import { getSettingValue } from '../../core/settings/service.js';
import { featureOn } from '../lifecycle/service.js';
import { daysBetween } from '../attendance/time.js';
import { calculate, CALC_VERSION, RULE_PARAMS, type Component, type RuleKind, type CalcInput } from './calc.js';

export function periodBounds(period: string) {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const start = `${period}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { start, end, days: daysBetween(start, end) + 1, month: m };
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
 * absent 1; missing punch 1 (setting) ; half day 0.5 unless the other half is paid leave; unpaid leave its fraction.
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
    else if (r.status === 'half_day') lop += lf > 0 && r.paid !== false ? 0 : 0.5;
    else if (r.status === 'on_leave' && r.paid === false) lop += lf || 1;
  }
  return { lop, missingPunch, uncalculated: Math.max(0, daysBetween(from, to) + 1 - rows.length) };
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
    const sal = (await db.query<{ id: string; amounts: Record<string, number> }>(`SELECT id, amounts FROM employee_salaries WHERE tenant_id=$1 AND employee_id=$2 AND status='active'
      AND effective_from <= $3::date ORDER BY effective_from DESC LIMIT 1`, [tenantId, e.id, p.end])).rows[0];
    if (!sal) continue; // not on payroll
    const from = e.date_of_joining > p.start ? e.date_of_joining : p.start;
    const to = e.exit_date && e.exit_date < p.end ? e.exit_date : p.end;
    const employed = daysBetween(from, to) + 1;
    const warnings: string[] = [];
    let lop = 0;
    if (attendanceOn) {
      const l = await lossOfPay(db, tenantId, e.id, from, to);
      lop = l.lop;
      if (l.missingPunch) warnings.push(`${l.missingPunch} unresolved missing-punch day(s)`);
      if (l.uncalculated) warnings.push(`attendance not calculated for ${l.uncalculated} day(s) — paid`);
    }
    const adj = (await db.query<{ kind: 'earning' | 'deduction' | 'lop_days'; label: string; amount: string; taxable: boolean }>(
      'SELECT kind, label, amount::text, taxable FROM payroll_adjustments WHERE tenant_id=$1 AND run_id=$2 AND employee_id=$3 ORDER BY created_at', [tenantId, runId, e.id])).rows;
    lop = Math.max(0, lop + adj.filter((a) => a.kind === 'lop_days').reduce((s, a) => s + Number(a.amount), 0));
    const paidDays = Math.max(0, employed - lop);
    const regime = (e.tax_regime ?? 'new') as 'new' | 'old';
    const ptState = e.pt_state ?? e.branch_state ?? null;
    const input: CalcInput = {
      month: p.month, daysInPeriod: p.days, paidDays, components, amounts: sal.amounts,
      adjustments: adj.filter((a) => a.kind !== 'lop_days').map((a) => ({ kind: a.kind as 'earning' | 'deduction', label: a.label, amount: Number(a.amount), taxable: a.taxable })),
      statutory: { pfExcluded: !!e.pf_excluded, regime, ptState },
      rules: { pf: await cached('pf', 'IN'), esi: await cached('esi', 'IN'), pt: ptState ? await cached('pt', ptState) : undefined, lwf: ptState ? await cached('lwf', ptState) : undefined, tds: await cached('tds', regime) },
      expect: statutoryOn ? expect : [],
    };
    const r = calculate(input);
    warnings.push(...r.warnings);
    await db.query(`INSERT INTO payroll_items (tenant_id, run_id, employee_id, salary_id, days_in_period, employed_days, lop_days, paid_days, lines, gross, deductions, net, employer_cost, warnings, hold, calc_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [tenantId, runId, e.id, sal.id, p.days, employed, lop, paidDays, JSON.stringify(r.lines), r.gross, r.deductions, r.net, r.employerCost, JSON.stringify(warnings), r.net < 0, CALC_VERSION]);
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
