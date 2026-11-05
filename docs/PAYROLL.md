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
   - **Loss of pay** (LOP) comes from calculated attendance: absent = 1, unresolved missing punch = 1 (setting `payroll.missing_punch_is_lop`), a half day = 0.5 for the half not worked, whether or not leave covers the other half, unpaid leave = its fraction (also on a day otherwise worked or on field duty, and on a weekly off or holiday when the leave type counts non-working days). Field duty (`on_duty`) is paid. Days without calculated attendance are paid and reported as warnings.
   - **Salary changes within a month** are split by calendar days: each approved salary pays the days it covers, and loss of pay falls on the stretch where it happened. Non-prorated components are shared by days. Days before an employee's first salary are unpaid and flagged.
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

**Payslip PDF:** `GET /payroll/payslips/:id/payslip.pdf`, under the same rule as the JSON route, with feature `payroll.payslips`: the employee's own once final and not held, or anyone with a pay permission above them. For staff, a held slip or an unfinished run says `ON HOLD` or `NOT FINAL` on the page. It shows the brand, employer details from Settings, Company, earnings and deductions, and PAN and account number as the last four. Employer contributions are left off. Amounts print with the ISO code, `INR 68,200.00`, since the standard PDF fonts have no rupee sign. Audited as `l4.export`, one row, and limited as an export. See D52, including what happens to names the fonts cannot draw.

**Held pay:** an item on hold stays out of the bank file and payslips, and a loan instalment in it stays in progress, not recovered, so the loan does not close. After finalize, a `payroll.approve` holder releases it (`POST /payroll/runs/:id/items/:employeeId/release`, with a reason): the payslip appears, loans are re-checked, and the money goes out in `bank-released.csv` while `bank.csv` stays as it was.

**Stale results:** finalize refuses a run computed before attendance was locked, computed by an older calculation version, or (F&F) computed before the leaver's attendance last changed. `POST /payroll/runs/:id/reopen` takes an approved run back to draft to recompute and approve again.

**F&F:** an `fnf` run for one leaver with an approved separation, one per leaver unless cancelled. A leaver's salary for the month is paid once: an open F&F run takes them out of the regular run (a computed regular run goes back to draft). If the regular run was already submitted or later, the F&F run pays only its adjustments, with no second PT or LWF.
- `GET /fnf-suggestions/:employeeId` shows notice shortfall, leave balances and the salary as inputs.
- Encashment, notice recovery and gratuity amounts are entered as adjustments after HR confirms them against policy and law.
- Paying the run marks the separation's F&F as settled.

## Calculation (`src/modules/payroll/calc.ts`, `CALC_VERSION` 1)

- Decimal arithmetic. Each line is rounded half-up to the rupee; ESI rounding follows its rule.
- **PF:** employee = rate × (PF wages, capped if configured). Employer total = rate × base; EPS = EPS% × capped wages; EPF = employer total − EPS.
- **ESI** cover is fixed for each contribution period (April to September, October to March) by the full-month ESI wage at the period start, or the first salary in the period for a joiner. Contributions apply to wages actually paid. A qualified reviewer must confirm this (`DECISIONS.md` D25).
- **PT** uses the slab of the month's gross, with a per-month override where set.
- **TDS** is a **simple projection**: (this month's regular taxable pay × 12 − standard deduction) → slabs → rebate if within the limit → cess → ÷ 12. A taxable one-off (adjustment, overtime, encashment) adds the extra tax it causes for the year, all in the month paid; a qualified reviewer must confirm this (`DECISIONS.md` D25). It does **not** use investment declarations, previous employment, previous months' actuals, surcharge or marginal relief. Correct it with adjustments where needed and reconcile annually.

## Permissions

| Permission | Default roles |
|---|---|
| `payslips.self` | everyone |
| `payroll.read` | payroll manager, finance manager, HR administrator, auditor |
| `payroll.manage` | payroll manager |
| `payroll.approve` | finance manager |
| `payroll.statutory` | payroll manager, finance manager (each can verify the other's rules) |

## Not included

Form 16 / 24Q / ECR file generation, investment declarations and proofs, loans and advances, bonus and gratuity calculators, multi-period arrears computation, and accounting journal export.

## Overtime

With module `overtime`, a computed run adds one `OT` earning line per employee for approved overtime taken as pay (arrears included), priced on the salary of the day worked at the rate the organization configures. Taxable; never PF wages; ESI contribution wages only if `overtime.esi_wages` says so. Unpriced overtime (settings missing, no salary that day) is a run warning. See docs/OVERTIME.md.
