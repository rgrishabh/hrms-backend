import { Decimal } from 'decimal.js';
import type { Db } from '../../db/tx.js';
import { isModuleEnabled } from '../../core/features/state.js';
import type { Adjustment } from '../payroll/calc.js';
import { money } from '../../core/brand.js';

export const KIND_LABEL: Record<string, string> = { salary_advance: 'Salary advance', loan: 'Loan' };
/** The two kinds share a table and a screen, but each has its own flag. */
export const KIND_FEATURE: Record<string, string> = { salary_advance: 'salary_advance', loan: 'loans' };
export const enabledLoanKinds = () => Object.keys(KIND_FEATURE).filter((k) => isModuleEnabled(KIND_FEATURE[k]!));

/** Equal whole-rupee instalments; the last one is smaller when the amount does not divide evenly. */
export const installmentOf = (amount: number, n: number) => Math.ceil(amount / n);

/**
 * Taken back so far: direct repayments and payroll deductions in runs that are not cancelled (`committed`), and
 * of those, what is final (repayments, and deductions in finalized or paid runs where the pay is not held: until held
 * pay is released the employee has not had it, so the deduction stays in progress and the loan stays open).
 */
export async function balanceOf(db: Db, tenantId: string, loanId: string, opts: { excludeRunId?: string } = {}) {
  const loan = (await db.query<{ amount: string }>(`SELECT amount::text FROM employee_loans WHERE tenant_id=$1 AND id=$2`, [tenantId, loanId])).rows[0];
  if (!loan) return { amount: '0.00', outstanding: '0.00', recovered: '0.00', inProgress: '0.00' };
  const rows = (await db.query<{ amount: string; source: string; payroll_run_id: string | null; run_status: string | null; hold: boolean | null }>(
    `SELECT x.amount::text, x.source, x.payroll_run_id, r.status AS run_status, i.hold FROM loan_recoveries x JOIN employee_loans l ON l.tenant_id=x.tenant_id AND l.id=x.loan_id
     LEFT JOIN payroll_runs r ON r.tenant_id=x.tenant_id AND r.id=x.payroll_run_id
     LEFT JOIN payroll_items i ON i.tenant_id=x.tenant_id AND i.run_id=x.payroll_run_id AND i.employee_id=l.employee_id WHERE x.tenant_id=$1 AND x.loan_id=$2`, [tenantId, loanId])).rows;
  let committed = new Decimal(0); let final = new Decimal(0);
  for (const x of rows) {
    if (x.source === 'repayment' || (x.run_status !== 'cancelled' && x.payroll_run_id !== (opts.excludeRunId ?? null))) committed = committed.plus(x.amount);
    if (x.source === 'repayment' || (['finalized', 'paid'].includes(x.run_status ?? '') && !x.hold)) final = final.plus(x.amount);
  }
  const outstanding = Decimal.max(0, new Decimal(loan.amount).minus(committed));
  return { amount: loan.amount, outstanding: outstanding.toFixed(2), recovered: final.toFixed(2), inProgress: committed.minus(final).toFixed(2) };
}

/** Outstanding per loan, for a page of them: everything recovered that is not in a cancelled run. */
export async function outstandingOf(db: Db, tenantId: string, loans: readonly { id: string; amount: string }[]) {
  const out = new Map(loans.map((l) => [l.id, new Decimal(l.amount)]));
  if (!loans.length) return new Map<string, string>();
  const rows = (await db.query<{ loan_id: string; amount: string; source: string; run_status: string | null }>(`SELECT x.loan_id, x.amount::text, x.source, r.status AS run_status FROM loan_recoveries x
    LEFT JOIN payroll_runs r ON r.tenant_id=x.tenant_id AND r.id=x.payroll_run_id WHERE x.tenant_id=$1 AND x.loan_id = ANY($2)`, [tenantId, loans.map((l) => l.id)])).rows;
  for (const x of rows) if (x.source === 'repayment' || x.run_status !== 'cancelled') out.set(x.loan_id, out.get(x.loan_id)!.minus(x.amount));
  return new Map([...out].map(([id, v]) => [id, Decimal.max(0, v).toFixed(2)]));
}

interface Planned { loanId: string; kind: string; amount: Decimal; label: string; ref: string }

/**
 * What a payroll run should recover from one employee: the month's instalment of every disbursed loan whose
 * recovery has started (not in a deferred month), or the whole balance in a full-and-final run. Locks the loans until the
 * run's transaction ends, so a direct repayment (which locks them too) waits and then sees what this run took.
 */
export async function plannedRecoveries(db: Db, tenantId: string, runId: string, employeeId: string, period: string, fnf: boolean): Promise<Planned[]> {
  const loans = (await db.query<{ id: string; kind: string; installments: number; installment_amount: string; first_period: string; skip_periods: string[] }>(
    `SELECT id, kind, installments, installment_amount::text, first_period, skip_periods FROM employee_loans
      WHERE tenant_id=$1 AND employee_id=$2 AND status='disbursed' AND kind = ANY($3) ORDER BY disbursed_at, id FOR UPDATE`, [tenantId, employeeId, enabledLoanKinds()])).rows;
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
    if (take.lt(p.amount)) warnings.push(`${p.label}: ${money(take)} of ${money(p.amount)} recovered (net pay is not enough); the rest stays outstanding`);
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
