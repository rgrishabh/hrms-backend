# Payroll

Modules: `payroll` (components, salaries, runs, exports), `payroll.payslips` (employee self-service), `payroll.statutory` (PF, ESI, PT, LWF, TDS from a verified rule register). None are in `default`.

> **No statutory rate ships with the product.** Every PF/ESI/PT/LWF/TDS value is entered by the organization, citing its source (notification/circular), and **verified by a second person** before it applies. When an expected rule is missing, the deduction is **not guessed**: the run shows a warning, and someone must acknowledge it before the run can be submitted. Have a qualified payroll professional review rules and the first runs.

## Setup

1. **Components** (`payroll.manage`): earnings and deductions.
   - `fixed` (a monthly amount) or `percent` of one or more fixed components (e.g. HRA = 40% of BASIC).
   - Flags per component: prorated by paid days, taxable, counts towards PF wages, counts towards ESI wages.
2. **Salaries:** effective-dated monthly amounts per component, with a reason.
   - **Maker-checker:** a change becomes active only after approval by `payroll.approve`. Nobody proposes their own salary, and the approval summary contains no figures.
   - A change cannot start inside a period already covered by a finalized run; pay arrears as an adjustment in the next run.
3. **Employee statutory details:** UAN, PF member id, PF exclusion, ESI IP number, PAN (encrypted, shown masked), tax regime (new/old), PT state (defaults to the branch state).
4. **Statutory rules** (`payroll.statutory`), each with an effective period and a source reference:

| Kind | Scope | Parameters |
|---|---|---|
| `pf` | `IN` | employee rate %, employer rate %, EPS share %, wage ceiling, ceiling applies to employee / employer |
| `esi` | `IN` | employee rate %, employer rate %, gross wage threshold, rounding (up / nearest) |
| `pt` | state | slabs on monthly gross (`upTo`, `amount`, optional per-month amounts, e.g. February) |
| `lwf` | state | employee and employer amounts, months in which it is deducted |
| `tds` | `new` / `old` regime | slabs, standard deduction, rebate limit and maximum, cess % |

   - Rules are drafted, then **verified by someone else**, which activates them and ends the previous rule the day before.
   - Active rules can't be edited: retire them and add a new one.
   - The setting `payroll.expected_statutory` (default `pf,esi,pt,tds`) lists the kinds the organization applies; a missing rule for one of them raises a warning.

## A run

`draft → computed → pending (approval) → approved → finalized (locked) → paid` (or `cancelled` before approval).

1. **Create** a run for a legal entity and month (one regular run per entity and month) and **compute** it. Every active or leaving employee of the entity with an active salary is included.
   - **Employed days** = days in the month between joining and exit.
   - **Loss of pay** (LOP) comes from calculated attendance: absent = 1, unresolved missing punch = 1 (setting `payroll.missing_punch_is_lop`), a half day not covered by paid leave = 0.5, unpaid leave = its fraction (also on a day otherwise worked or on field duty). Field duty (`on_duty`) is paid. Days without calculated attendance are paid and reported as warnings.
   - **Paid days** = employed days − LOP. Proration = paid days / calendar days of the month.
   - **Loan instalments** (module `advances_loans`, docs/ADVANCES_LOANS.md) are deducted after everything else, never taking net pay below zero; a full-and-final run deducts the whole balance.
2. **Adjust:** add one-off earnings/deductions (arrears, allowances, recoveries) and LOP corrections. Any change sends the run back to draft, so it must be recomputed.
3. **Warnings:** review them (missing rules, uncalculated attendance, negative net, which is put on hold) and **acknowledge** them with a note.
4. **Approve:** submit; a `payroll.approve` holder who is **not** the preparer approves.
5. **Finalize:** requires attendance to be **locked** for the whole month. Items and adjustments then become immutable (database trigger), and employees are notified that their payslip is available.
6. **Paid:** record the bank reference once the transfer is done.

**Exports** (finalized runs; the register is available any time; every export is audited):
- Payroll register, as CSV or Excel (`register.xlsx`: employee codes stay text, days and amounts are numbers). Bank and statutory files stay CSV, in the layouts the bank or portal expects.
- Bank file: full account numbers only with `employees.bank.read`, otherwise masked.
- PF and ESI contribution files: inputs to the portal formats. Check them against the current ECR / ESI upload specification before uploading.

**F&F:** an `fnf` run for one leaver with an approved separation.
- `GET /fnf-suggestions/:employeeId` shows notice shortfall, leave balances and the salary as inputs.
- Encashment, notice recovery and gratuity amounts are entered as adjustments after HR confirms them against policy and law.
- Paying the run marks the separation's F&F as settled.

## Calculation (`src/modules/payroll/calc.ts`, `CALC_VERSION` 1)

- Decimal arithmetic. Each line is rounded half-up to the rupee; ESI rounding follows its rule.
- **PF:** employee = rate × (PF wages, capped if configured). Employer total = rate × base; EPS = EPS% × capped wages; EPF = employer total − EPS.
- **ESI** applies when ESI wages ≤ the threshold in that month. Contribution-period continuity is **not** modelled.
- **PT** uses the slab of the month's gross, with a per-month override where set.
- **TDS** is a **simple projection**: (this month's taxable pay × 12 − standard deduction) → slabs → rebate if within the limit → cess → ÷ 12. It does **not** use investment declarations, previous employment, previous months' actuals, surcharge or marginal relief. Correct it with adjustments where needed and reconcile annually.

## Permissions

| Permission | Default roles |
|---|---|
| `payslips.self` | everyone |
| `payroll.read` | payroll manager, finance manager, HR administrator, auditor |
| `payroll.manage` | payroll manager |
| `payroll.approve` | finance manager |
| `payroll.statutory` | payroll manager, finance manager (each can verify the other's rules) |

## Not included

Form 16 / 24Q / ECR file generation, investment declarations and proofs, loans and advances, bonus and gratuity calculators, multi-period arrears computation, payslip PDF (the browser print view is provided), and accounting journal export.

## Overtime

With module `overtime`, a computed run adds one `OT` earning line per employee for approved overtime taken as pay (arrears included), priced on the salary of the day worked at the rate the organization configures. Taxable; never PF wages; ESI contribution wages only if `overtime.esi_wages` says so. Unpriced overtime (settings missing, no salary that day) is a run warning. See docs/OVERTIME.md.
