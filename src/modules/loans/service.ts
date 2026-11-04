import { Decimal } from 'decimal.js';
import type { Db } from '../../db/tx.js';
import type { Adjustment } from '../payroll/calc.js';

export const KIND_LABEL: Record<string, string> = { salary_advance: 'Salary advance', loan: 'Loan' };

/** Equal whole-rupee instalments; the last one is smaller when the amount does not divide evenly. */
export const installmentOf = (amount: number, n: number) => Math.ceil(amount / n);

/**
 * Taken back so far: direct repayments and payroll deductions in runs that are not cancelled (`committed`), and
 * of those, what is final (repayments, and deductions in finalized or paid runs where the pay is not held: until held
 * pay is released the employee has not had it, so the deduction stays in progress and the loan stays open).
 */
export async function balanceOf(db: Db, tenantId: string, loanId: string, opts: { excludeRunId?: string } = {}) {
  const r = (await db.query<{ amount: string; committed: string; final: string }>(`SELECT l.amount::text,
      coalesce(sum(x.amount) FILTER (WHERE x.source='repayment' OR (r.status <> 'cancelled' AND x.payroll_run_id IS DISTINCT FROM $3::uuid)), 0)::text AS committed,
      coalesce(sum(x.amount) FILTER (WHERE x.source='repayment' OR (r.status IN ('finalized','paid') AND NOT coalesce(i.hold, false))), 0)::text AS final
    FROM employee_loans l LEFT JOIN loan_recoveries x ON x.tenant_id=l.tenant_id AND x.loan_id=l.id
    LEFT JOIN payroll_runs r ON r.tenant_id=x.tenant_id AND r.id=x.payroll_run_id
    LEFT JOIN payroll_items i ON i.tenant_id=x.tenant_id AND i.run_id=x.payroll_run_id AND i.employee_id=l.employee_id
    WHERE l.tenant_id=$1 AND l.id=$2 GROUP BY l.amount`, [tenantId, loanId, opts.excludeRunId ?? null])).rows[0];
  if (!r) return { amount: '0.00', outstanding: '0.00', recovered: '0.00', inProgress: '0.00' };
  const outstanding = Decimal.max(0, new Decimal(r.amount).minus(r.committed));
  return { amount: r.amount, outstanding: outstanding.toFixed(2), recovered: new Decimal(r.final).toFixed(2), inProgress: new Decimal(r.committed).minus(r.final).toFixed(2) };
}

interface Planned { loanId: string; kind: string; amount: Decimal; label: string; ref: string }

/**
 * What a payroll run should recover from one employee: the month's instalment of every disbursed loan whose
 * recovery has started (not in a deferred month), or the whole balance in a full-and-final run.
 */
export async function plannedRecoveries(db: Db, tenantId: string, runId: string, employeeId: string, period: string, fnf: boolean): Promise<Planned[]> {
  const loans = (await db.query<{ id: string; kind: string; installments: number; installment_amount: string; first_period: string; skip_periods: string[] }>(
    `SELECT id, kind, installments, installment_amount::text, first_period, skip_periods FROM employee_loans
      WHERE tenant_id=$1 AND employee_id=$2 AND status='disbursed' ORDER BY disbursed_at, id`, [tenantId, employeeId])).rows;
  const out: Planned[] = [];
  for (const l of loans) {
    if (!fnf && (period < l.first_period || l.skip_periods.includes(period))) continue;
    const bal = new Decimal((await balanceOf(db, tenantId, l.id, { excludeRunId: runId })).outstanding);
    if (bal.lte(0)) continue;
    const amount = fnf ? bal : Decimal.min(bal, l.installment_amount);
    const done = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM loan_recoveries x JOIN payroll_runs r ON r.tenant_id=x.tenant_id AND r.id=x.payroll_run_id
      WHERE x.tenant_id=$1 AND x.loan_id=$2 AND r.status <> 'cancelled' AND r.id <> $3`, [tenantId, l.id, runId])).rows[0]!.n);
    const label = fnf ? `${KIND_LABEL[l.kind]} recovery — balance` : `${KIND_LABEL[l.kind]} recovery (${done + 1} of ${l.installments})`;
    out.push({ loanId: l.id, kind: l.kind, amount, label, ref: l.id });
  }
  return out;
}

/**
 * Turn planned recoveries into payslip deductions, never taking more than the net pay available, and record them
 * against the run (a recompute replaces them; cancelling the run releases them).
 */
export async function applyRecoveries(db: Db, tenantId: string, runId: string, period: string, planned: Planned[], netAvailable: number) {
  let left = new Decimal(Math.max(0, Math.floor(netAvailable)));
  const adjustments: Adjustment[] = []; const warnings: string[] = [];
  for (const [i, p] of planned.entries()) {
    const take = Decimal.min(p.amount, left);
    if (take.lt(p.amount)) warnings.push(`${p.label}: ₹${take.toFixed(0)} of ₹${p.amount.toFixed(0)} recovered (net pay is not enough); the rest stays outstanding`);
    if (take.lte(0)) continue;
    left = left.minus(take);
    await db.query(`INSERT INTO loan_recoveries (tenant_id, loan_id, source, payroll_run_id, period, amount) VALUES ($1,$2,'payroll',$3,$4,$5)`, [tenantId, p.loanId, runId, period, take.toFixed(2)]);
    adjustments.push({ kind: 'deduction', code: i ? `LOAN${i + 1}` : 'LOAN', label: p.label, amount: take.toNumber(), taxable: false });
  }
  return { adjustments, warnings };
}

/** Disbursed loans fully taken back (final recoveries cover the amount) are closed. */
export async function closeRepaid(db: Db, tenantId: string, employeeIds?: string[]) {
  const loans = (await db.query<{ id: string }>(`SELECT id FROM employee_loans WHERE tenant_id=$1 AND status='disbursed' AND ($2::uuid[] IS NULL OR employee_id = ANY($2))`,
    [tenantId, employeeIds ?? null])).rows;
  let closed = 0;
  for (const l of loans) {
    const b = await balanceOf(db, tenantId, l.id);
    if (new Decimal(b.recovered).gte(b.amount)) { await db.query(`UPDATE employee_loans SET status='closed', closed_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, l.id]); closed++; }
  }
  return closed;
}
