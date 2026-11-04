# Salary advances and loans

Module `advances_loans` (depends on `payroll`). Code: `src/modules/loans/`. Tests: `test/loans.test.ts`.

The module handles **salary advances** (short, typically 1–3 months) and **interest-free loans**. Both are recovered in equal whole-rupee monthly instalments through payroll; the last instalment is smaller if the amount doesn't divide evenly. The employee can also repay directly.

## Flow

1. **Apply.** The employee applies with the kind, amount (whole rupees), number of instalments, the first payroll month to recover in, and a purpose.
   - Payroll (`loans.manage`) can also record an application for an employee.
   - Policy settings:
     - most instalments: `loans.advance_max_installments` (default 3) and `loans.max_installments` (default 24);
     - largest amounts: `loans.max_advance_amount` and `loans.max_loan_amount` (empty = no limit);
     - one advance and one loan at a time: `loans.one_at_a_time` (default on).
   - Only active employees can apply; employees on notice can't.
2. **Approve.** The reporting manager approves, then finance (`loans.approve`). Neither the employee nor whoever recorded the application can approve it. The approval summary shows the amount and the instalments.
3. **Disburse.** Payroll (`loans.manage`) records the payment with its bank reference. Nobody can disburse their own. The employee is notified. Before disbursement, an approved application can be cancelled.
4. **Recover through payroll.** Every payroll run from the first month deducts the month's instalment of each disbursed loan, as a deduction line `LOAN`, `LOAN2`, … with the text "Salary advance recovery (2 of 3)".
   - A **full-and-final** run deducts the whole balance.
   - **Net pay never goes below zero.** If net pay is too small, only part of the instalment is recovered. The run carries a warning, and the rest stays outstanding.
   - Recomputing a run replaces its recoveries, and cancelling a run releases them. Once a run is approved, its recoveries can't change; a database trigger enforces this.
   - When a run is **finalized**, loans whose balance is now fully recovered are **closed**.
5. **Repay directly.** Payroll records a direct repayment (cash or transfer, with a reference). It can't exceed the outstanding balance, which counts instalments already in runs being processed. Later instalments shrink, and the loan closes when nothing is left.
6. **Defer.** Payroll can skip a month's instalment, for example for hardship or a month with little pay. The schedule moves out by a month. A month whose instalment is already in an approved or final run can't be deferred. If the month is in a run that is only computed, the response says to recompute it.

## Balance

`GET /loans/requests/:id` returns:
- `balance`:
  - `outstanding`: still to recover, after repayments and instalments in runs that aren't cancelled;
  - `inProgress`: instalments in runs not yet final;
  - `recovered`: final.
- the planned `schedule`.
- the `recoveries` so far.

## Permissions

| Permission | Roles |
|---|---|
| `loans.self` | every employee |
| `loans.team.read` | reporting manager, laboratory manager, department head |
| `loans.read` | HR administrator, finance manager, payroll manager, auditor |
| `loans.approve` | finance manager |
| `loans.manage` (disburse, repayments, deferrals, policy) | payroll manager |

## For the organization to decide (not built)

- **Interest.** Loans are interest-free. Interest-bearing loans, and the taxable perquisite value of an interest-free or concessional loan (Income-tax Rule 3(7)(i), with its exemptions), are **not computed**. Confirm the tax treatment of loans above the exemption limit with your tax adviser, and add any perquisite to the payroll run as an adjustment.
- **Recovery limits.** Limits on deductions from wages (for example under the Payment of Wages Act, where it applies to your establishment) are not checked beyond "net pay not below zero". Set instalment amounts within what applies to you.
- **Write-off or waiver.** Not built. A waived balance may also have tax consequences.
