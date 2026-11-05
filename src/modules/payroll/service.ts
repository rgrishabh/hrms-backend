import type { Db } from '../../db/tx.js';
import { getSettingValue } from '../../core/settings/service.js';
import { featureOn } from '../lifecycle/service.js';
import { addDays, daysBetween } from '../attendance/time.js';
import { calculate, CALC_VERSION, RULE_PARAMS, type Component, type RuleKind, type CalcInput } from './calc.js';
import { plannedRecoveries, applyRecoveries, enabledLoanKinds } from '../loans/service.js';
import { overtimeForRun } from '../overtime/service.js';
import { sealJson } from '../../core/crypto/index.js';
import { openAdjustment, openAmounts, sealItem } from './sealed.js';

export function periodBounds(period: string) {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const start = `${period}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { start, end, days: daysBetween(start, end) + 1, month: m };
}

/** First day of the ESI contribution period holding `date`: 1 April to 30 September, 1 October to 31 March. */
export function esiContributionStart(date: string) {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return m >= 4 && m <= 9 ? `${y}-04-01` : `${m >= 10 ? y : y - 1}-10-01`;
}

/** Active, verified rule of a kind for the period (latest effective_from on or before the period end). */
async function rule(db: Db, tenantId: string, kind: RuleKind, scope: string, at: string) {
  const r = (
    await db.query<{ params: unknown }>(
      `SELECT params FROM statutory_rules WHERE tenant_id=$1 AND kind=$2 AND lower(scope)=lower($3) AND status='active'
    AND verified_by IS NOT NULL AND effective_from <= $4::date AND (effective_to IS NULL OR effective_to >= $4::date) ORDER BY effective_from DESC LIMIT 1`,
      [tenantId, kind, scope, at],
    )
  ).rows[0];
  if (!r) return undefined;
  const p = RULE_PARAMS[kind].safeParse(r.params);
  return p.success ? p.data : undefined;
}

/**
 * Loss-of-pay days from calculated attendance within [from, to]:
 * absent 1; missing punch 1 (setting); half day 0.5 for the half that was not worked, whatever covers the other half
 * (attendance only reports half_day alongside leave when the other half was NOT completed; a worked half gives present);
 * unpaid leave its fraction, also on a half_day, on a day otherwise worked or on field duty, and on a weekly off or holiday
 * when the leave type counts it. Field duty (on_duty) is paid.
 * Days without a calculated row are paid but reported.
 */
export async function lossOfPay(db: Db, tenantId: string, employeeId: string, from: string, to: string) {
  const missingIsLop = await getSettingValue<boolean>(db, tenantId, 'payroll.missing_punch_is_lop');
  const rows = (
    await db.query<DayForPay>(
      `SELECT d.status, d.leave_fraction::text, t.paid
    FROM attendance_daily d LEFT JOIN leave_types t ON t.tenant_id=d.tenant_id AND t.code=d.leave_type_code
    WHERE d.tenant_id=$1 AND d.employee_id=$2 AND d.work_date BETWEEN $3 AND $4`,
      [tenantId, employeeId, from, to],
    )
  ).rows;
  return lopOf(rows, missingIsLop, from, to);
}

interface DayForPay {
  status: string;
  leave_fraction: string;
  paid: boolean | null;
}

function lopOf(rows: readonly DayForPay[], missingIsLop: boolean, from: string, to: string) {
  let lop = 0;
  let missingPunch = 0;
  for (const r of rows) {
    const lf = Number(r.leave_fraction);
    if (r.status === 'absent') lop += 1;
    else if (r.status === 'missing_punch') {
      missingPunch++;
      if (missingIsLop) lop += 1;
    } else if (r.status === 'half_day') lop += 0.5 + (r.paid === false ? lf : 0);
    else if (r.status === 'on_leave' && r.paid === false) lop += lf || 1;
    // A worked (or on-duty) day that includes half a day of unpaid leave loses that half; so does an off day the unpaid leave counts.
    else if (['present', 'on_duty', 'weekly_off', 'holiday'].includes(r.status) && lf > 0 && r.paid === false) lop += lf;
  }
  return { lop, missingPunch, uncalculated: Math.max(0, daysBetween(from, to) + 1 - rows.length) };
}

interface SalaryRow {
  id: string;
  amounts_enc: string;
  effective_from: string;
}

/**
 * The approved salaries in force over [from, to], oldest first, each with the stretch it covers. A later approval with the
 * same effective date has already superseded the earlier one. Days before the first salary belong to no stretch.
 `all` is in effective-date order.
 */
function versionsOf(all: readonly SalaryRow[], from: string, to: string) {
  const rows = all.filter((r) => r.effective_from <= to).map((r) => ({ id: r.id, amounts: openAmounts(r.amounts_enc), effective_from: r.effective_from }));
  const inPeriod = rows.filter((s, x) => s.effective_from > from || !rows[x + 1] || rows[x + 1]!.effective_from > from);
  return inPeriod.map((s, x) => ({
    id: s.id,
    amounts: s.amounts,
    start: s.effective_from > from ? s.effective_from : from,
    end: inPeriod[x + 1] ? addDays(inPeriod[x + 1]!.effective_from, -1) : to,
  }));
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
    paid[x]! -= move;
    left -= move;
  }
  return paid;
}

/**
 * Which run pays a leaver's salary for the month. If a regular run has already committed it (submitted or later), that
 * run does and this returns true. If a regular run has them in a computed result that can still change, the F&F run takes
 * over and the regular run must be recomputed, which leaves them out.
 */
async function settleWithRegularRun(db: Db, tenantId: string, legalEntityId: string, period: string, employeeId: string) {
  const regular = (
    await db.query<{ id: string; status: string }>(
      `SELECT r.id, r.status FROM payroll_runs r JOIN payroll_items i ON i.tenant_id=r.tenant_id AND i.run_id=r.id AND i.employee_id=$4
    WHERE r.tenant_id=$1 AND r.legal_entity_id=$2 AND r.period=$3 AND r.kind='regular' AND r.status <> 'cancelled' FOR UPDATE OF r`,
      [tenantId, legalEntityId, period, employeeId],
    )
  ).rows[0];
  if (!regular) return false;
  if (['pending', 'approved', 'finalized', 'paid'].includes(regular.status)) return true;
  await db.query(`UPDATE payroll_runs SET status='draft' WHERE tenant_id=$1 AND id=$2 AND status='computed'`, [tenantId, regular.id]);
  return false;
}

interface EmpForPay {
  id: string;
  employee_code: string;
  name: string;
  date_of_joining: string;
  exit_date: string | null;
  branch_state: string;
  pf_excluded: boolean | null;
  tax_regime: string | null;
  pt_state: string | null;
}

/** (Re)computes every item of a draft/computed run. Deterministic for the same inputs. */
export async function computeRun(db: Db, tenantId: string, runId: string) {
  const run = (
    await db.query<{ period: string; legal_entity_id: string; kind: string; employee_id: string | null }>(
      'SELECT period, legal_entity_id, kind, employee_id FROM payroll_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [tenantId, runId],
    )
  ).rows[0]!;
  const p = periodBounds(run.period);
  const components = (
    await db.query<Component>(
      `SELECT code, name, kind, calc, base_codes, prorate, taxable, pf_wage, esi_wage, position FROM pay_components WHERE tenant_id=$1 AND status='active'`,
      [tenantId],
    )
  ).rows;
  const expect = (await getSettingValue<string>(db, tenantId, 'payroll.expected_statutory'))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as RuleKind[];
  const statutoryOn = await featureOn(db, tenantId, 'payroll.statutory');
  const attendanceOn = await featureOn(db, tenantId, 'attendance');
  const overtimeOn = await featureOn(db, tenantId, 'overtime');
  const loansOn = enabledLoanKinds().length > 0;
  // A recompute starts clean: overtime and loan instalments this run picked up before are offered to it again.
  await db.query('UPDATE overtime_claims SET payroll_run_id=NULL WHERE tenant_id=$1 AND payroll_run_id=$2', [tenantId, runId]);
  await db.query('DELETE FROM loan_recoveries WHERE tenant_id=$1 AND payroll_run_id=$2', [tenantId, runId]);
  const emps = (
    await db.query<EmpForPay>(
      `SELECT e.id, e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, e.date_of_joining::text, e.exit_date::text,
      b.state AS branch_state, s.pf_excluded, s.tax_regime, s.pt_state
    FROM employees e JOIN branches b ON b.tenant_id=e.tenant_id AND b.id=e.branch_id LEFT JOIN employee_statutory s ON s.tenant_id=e.tenant_id AND s.employee_id=e.id
    WHERE e.tenant_id=$1 AND e.legal_entity_id=$2 AND e.date_of_joining <= $4::date AND (e.exit_date IS NULL OR e.exit_date >= $3::date)
      AND e.status IN ('active','on_notice','exited') AND ($5::uuid IS NULL OR e.id=$5)
      -- A leaver's month belongs to their F&F run, unless that run has left the salary to this one (its item has no salary).
      AND ($7 <> 'regular' OR NOT EXISTS (SELECT 1 FROM payroll_runs f LEFT JOIN payroll_items fi ON fi.tenant_id=f.tenant_id AND fi.run_id=f.id AND fi.employee_id=e.id
        WHERE f.tenant_id=e.tenant_id AND f.kind='fnf' AND f.employee_id=e.id AND f.period=$6 AND f.status <> 'cancelled' AND (fi.id IS NULL OR fi.salary_id IS NOT NULL)))
      ORDER BY e.employee_code`,
      [tenantId, run.legal_entity_id, p.start, p.end, run.kind === 'fnf' ? run.employee_id : null, run.period, run.kind],
    )
  ).rows;
  await db.query('DELETE FROM payroll_items WHERE tenant_id=$1 AND run_id=$2', [tenantId, runId]);
  const totals = { employees: 0, gross: 0, deductions: 0, net: 0, employerCost: 0, held: 0 };
  let warningCount = 0;
  const ruleCache = new Map<string, unknown>();
  const cached = async (kind: RuleKind, scope: string) => {
    const k = `${kind}:${scope}`;
    if (!ruleCache.has(k)) ruleCache.set(k, statutoryOn ? await rule(db, tenantId, kind, scope, p.end) : undefined);
    return ruleCache.get(k) as never;
  };
  // What each person's item needs, read once for the run. What is left per person: their item's INSERT, and loans or overtime for those who have them.
  const ids = emps.map((e) => e.id);
  const byEmployee = <R extends { employee_id: string }>(rows: readonly R[]) => {
    const m = new Map<string, R[]>();
    for (const r of rows) m.set(r.employee_id, [...(m.get(r.employee_id) ?? []), r]);
    return m;
  };
  const salaryRows = byEmployee(
    (
      await db.query<SalaryRow & { employee_id: string }>(
        `SELECT employee_id, id, amounts_enc, effective_from::text FROM employee_salaries
    WHERE tenant_id=$1 AND employee_id = ANY($2) AND status='active' AND effective_from <= $3::date ORDER BY effective_from`,
        [tenantId, ids, p.end],
      )
    ).rows,
  );
  const adjustmentRows = byEmployee(
    (
      await db.query<{ employee_id: string; kind: 'earning' | 'deduction' | 'lop_days'; label: string; data_enc: string; taxable: boolean }>(
        'SELECT employee_id, kind, label, data_enc, taxable FROM payroll_adjustments WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at',
        [tenantId, runId],
      )
    ).rows,
  );
  const missingIsLop = attendanceOn && (await getSettingValue<boolean>(db, tenantId, 'payroll.missing_punch_is_lop'));
  const dayRows = byEmployee(
    attendanceOn
      ? (
          await db.query<DayForPay & { employee_id: string; work_date: string }>(
            `SELECT d.employee_id, d.work_date::text, d.status, d.leave_fraction::text, t.paid
    FROM attendance_daily d LEFT JOIN leave_types t ON t.tenant_id=d.tenant_id AND t.code=d.leave_type_code
    WHERE d.tenant_id=$1 AND d.employee_id = ANY($2) AND d.work_date BETWEEN $3 AND $4`,
            [tenantId, ids, p.start, p.end],
          )
        ).rows
      : [],
  );
  const withOvertime = new Set(
    overtimeOn
      ? (
          await db.query<{ employee_id: string }>(
            `SELECT DISTINCT c.employee_id FROM overtime_claims c LEFT JOIN payroll_runs r ON r.tenant_id=c.tenant_id AND r.id=c.payroll_run_id
    WHERE c.tenant_id=$1 AND c.employee_id = ANY($2) AND c.status='approved' AND c.payout='pay' AND c.work_date <= $3::date AND (c.payroll_run_id IS NULL OR r.status='cancelled')`,
            [tenantId, ids, p.end],
          )
        ).rows.map((r) => r.employee_id)
      : [],
  );
  const withLoans = new Set(
    loansOn
      ? (
          await db.query<{ employee_id: string }>(`SELECT DISTINCT employee_id FROM employee_loans WHERE tenant_id=$1 AND employee_id = ANY($2) AND status='disbursed'`, [
            tenantId,
            ids,
          ])
        ).rows.map((r) => r.employee_id)
      : [],
  );
  for (const e of emps) {
    const from = e.date_of_joining > p.start ? e.date_of_joining : p.start;
    const to = e.exit_date && e.exit_date < p.end ? e.exit_date : p.end;
    const salaries = salaryRows.get(e.id) ?? [];
    const versions = versionsOf(salaries, from, to);
    if (!versions.length) continue; // not on payroll
    const employed = daysBetween(from, to) + 1;
    const warnings: string[] = [];
    if (versions[0]!.start > from) warnings.push(`no salary before ${versions[0]!.start}: earlier days are unpaid`);
    // Loss of pay falls on the stretch where it happened; each stretch is paid at its own rate.
    const stretches = versions.map((v) => ({ ...v, days: daysBetween(v.start, v.end) + 1, lop: 0 }));
    const inRegularRun = run.kind === 'fnf' && (await settleWithRegularRun(db, tenantId, run.legal_entity_id, run.period, e.id));
    if (inRegularRun) warnings.push(`salary for ${run.period} is in the regular run: this run pays its adjustments only`);
    if (attendanceOn && !inRegularRun) {
      let missingPunch = 0;
      let uncalculated = 0;
      for (const v of stretches) {
        const l = lopOf(
          (dayRows.get(e.id) ?? []).filter((d) => d.work_date >= v.start && d.work_date <= v.end),
          missingIsLop,
          v.start,
          v.end,
        );
        v.lop = l.lop;
        missingPunch += l.missingPunch;
        uncalculated += l.uncalculated;
      }
      if (missingPunch) warnings.push(`${missingPunch} unresolved missing-punch day(s)`);
      if (uncalculated) warnings.push(`attendance not calculated for ${uncalculated} day(s) — paid`);
    }
    const adj = (adjustmentRows.get(e.id) ?? []).map((a) => ({ kind: a.kind, label: a.label, taxable: a.taxable, amount: openAdjustment(a.data_enc).amount }));
    const lopAdjustment = adj.filter((a) => a.kind === 'lop_days').reduce((s, a) => s + Number(a.amount), 0);
    const lop = inRegularRun ? 0 : Math.max(0, stretches.reduce((t, v) => t + v.lop, 0) + lopAdjustment);
    const paid = inRegularRun ? stretches.map(() => 0) : paidPerStretch(stretches, lopAdjustment);
    const paidDays = paid.reduce((t, d) => t + d, 0);
    const adjustments = adj
      .filter((a) => a.kind !== 'lop_days')
      .map((a) => ({ kind: a.kind as 'earning' | 'deduction', label: a.label, amount: Number(a.amount), taxable: a.taxable }));
    if (withOvertime.has(e.id)) {
      const ot = await overtimeForRun(db, tenantId, runId, e.id, p.end, components);
      if (ot.adjustment) adjustments.push(ot.adjustment);
      warnings.push(...ot.warnings);
    }
    const regime = (e.tax_regime ?? 'new') as 'new' | 'old';
    const ptState = e.pt_state ?? e.branch_state ?? null;
    // Salary in force when the contribution period began (or the earliest one since, for a joiner): decides ESI cover.
    const cpStart = esiContributionStart(p.start);
    const esiCover = salaries.filter((x) => x.effective_from <= cpStart).at(-1) ?? salaries[0];
    const input: CalcInput = {
      month: p.month,
      esiCoverageAmounts: esiCover ? openAmounts(esiCover.amounts_enc) : undefined,
      daysInPeriod: p.days,
      paidDays,
      components,
      amounts: stretches[stretches.length - 1]!.amounts,
      supplementary: inRegularRun,
      ...(stretches.length > 1 ? { segments: stretches.map((v, x) => ({ amounts: v.amounts, paidDays: paid[x]!, days: v.days, from: v.start })) } : {}),
      adjustments,
      statutory: { pfExcluded: !!e.pf_excluded, regime, ptState },
      rules: {
        pf: await cached('pf', 'IN'),
        esi: await cached('esi', 'IN'),
        pt: ptState ? await cached('pt', ptState) : undefined,
        lwf: ptState ? await cached('lwf', ptState) : undefined,
        tds: await cached('tds', regime),
      },
      expect: statutoryOn ? expect : [],
    };
    let r = calculate(input);
    if (withLoans.has(e.id)) {
      // Loan instalments come off what is left after everything else, never taking net pay below zero.
      const planned = await plannedRecoveries(db, tenantId, runId, e.id, run.period, run.kind === 'fnf');
      if (planned.length) {
        const rec = await applyRecoveries(db, tenantId, runId, run.period, planned, r.net);
        warnings.push(...rec.warnings);
        if (rec.adjustments.length) r = calculate({ ...input, adjustments: [...adjustments, ...rec.adjustments] });
      }
    }
    warnings.push(...r.warnings);
    await db.query(
      `INSERT INTO payroll_items (tenant_id, run_id, employee_id, salary_id, days_in_period, employed_days, lop_days, paid_days, data_enc, hold, calc_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        tenantId,
        runId,
        e.id,
        inRegularRun ? null : stretches[stretches.length - 1]!.id,
        p.days,
        employed,
        lop,
        paidDays,
        sealItem({ lines: r.lines, gross: r.gross, deductions: r.deductions, net: r.net, employerCost: r.employerCost, warnings }),
        r.net < 0,
        CALC_VERSION,
      ],
    );
    totals.employees++;
    totals.gross += r.gross;
    totals.deductions += r.deductions;
    totals.net += r.net;
    totals.employerCost += r.employerCost;
    if (r.net < 0) totals.held++;
    warningCount += warnings.length;
  }
  for (const k of ['gross', 'deductions', 'net', 'employerCost'] as const) totals[k] = Math.round(totals[k] * 100) / 100;
  await db.query(`UPDATE payroll_runs SET status='computed', totals_enc=$3, warnings=$4, warnings_acknowledged=false, computed_at=now() WHERE tenant_id=$1 AND id=$2`, [
    tenantId,
    runId,
    sealJson(totals),
    warningCount,
  ]);
  return { totals, warnings: warningCount };
}

/** Attendance must be locked for the whole period before payroll is finalized (when attendance is on). */
export async function attendanceLocked(db: Db, tenantId: string, period: string) {
  if (!(await featureOn(db, tenantId, 'attendance'))) return true;
  const p = periodBounds(period);
  const r = await db.query(`SELECT 1 FROM attendance_period_locks WHERE tenant_id=$1 AND period_start <= $2::date AND period_end >= $3::date`, [tenantId, p.start, p.end]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Why a run's stored result can no longer be finalized, or null: items are immutable after finalize, so what they were
 * computed from must still be current. A lock recalculates the whole period, so a run computed before the lock is out of
 * date; an F&F run has no lock, so the attendance of the leaver's own days is compared instead.
 */
export async function staleReason(db: Db, tenantId: string, run: { id: string; period: string; kind: string; employee_id: string | null; computed_at: Date | null }) {
  if ((await db.query('SELECT 1 FROM payroll_items WHERE tenant_id=$1 AND run_id=$2 AND calc_version <> $3 LIMIT 1', [tenantId, run.id, CALC_VERSION])).rowCount)
    return 'The run was computed by an older version of the calculation';
  if (!(await featureOn(db, tenantId, 'attendance'))) return null;
  const p = periodBounds(run.period);
  if (run.kind === 'regular') {
    const late = await db.query(`SELECT 1 FROM attendance_period_locks WHERE tenant_id=$1 AND period_start <= $2::date AND period_end >= $3::date AND locked_at > $4`, [
      tenantId,
      p.start,
      p.end,
      run.computed_at,
    ]);
    return late.rowCount ? `Attendance for ${run.period} was locked after this run was computed` : null;
  }
  const changed = await db.query(
    `SELECT 1 FROM attendance_daily d JOIN employees e ON e.tenant_id=d.tenant_id AND e.id=d.employee_id
    WHERE d.tenant_id=$1 AND d.employee_id=$2 AND d.work_date BETWEEN $3::date AND least($4::date, coalesce(e.exit_date, $4::date)) AND d.calculated_at > $5 LIMIT 1`,
    [tenantId, run.employee_id, p.start, p.end, run.computed_at],
  );
  return changed.rowCount ? 'Attendance changed after this run was computed' : null;
}
