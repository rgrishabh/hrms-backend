# Overtime

Module `overtime` (depends on `attendance`). Code: `src/modules/overtime/`. Tests: `test/overtime.test.ts`.

The module is usable once **Calculate overtime minutes** is on in the attendance policy. Attendance then records overtime for shifts that set an overtime threshold. Without that setting, Settings → Installation shows the blocker.

## Flow

1. **Claim.** An employee claims overtime for a day they have already worked, within the claim window (`overtime.claim_window_days`, default 30).
   - The claim can't exceed the overtime attendance recorded that day, or be below `overtime.min_minutes` (default 30).
   - There is one live claim per day.
   - If attendance is wrong, the employee corrects it first with a regularization.
   - The employee chooses **pay** or **compensatory off**.
2. **Approve.** The reporting manager approves first: they confirm the work was needed and done. Then someone with `overtime.approve` (HR) checks it against policy.
   - The employee can never approve their own claim.
   - The approval summary shows hours and the date only. It never shows pay.
3. **Pay or time off.**
   - **Pay.** The next payroll run computed for the employee's legal entity adds one `OT` earning line. It covers every approved claim up to the period end that isn't in another live run, so claims from earlier months are paid as arrears.
     - Each claim is priced on the salary in force on the day worked.
     - Recomputing a run re-collects its claims, so nothing is paid twice.
     - Cancelling a run releases its claims for the next run.
   - **Compensatory off.** On approval, whole half-days are credited to the leave type named in `overtime.comp_off_leave_type`, through the leave ledger. The ledger entry is keyed by the claim, so it is written only once.
     - A full day needs `overtime.comp_off_day_minutes` of overtime (default 480); half of that earns half a day.
4. **Withdraw or cancel.**
   - The employee can withdraw a pending claim.
   - HR (`overtime.manage`) can cancel an approved claim:
     - Pay: only before its payroll run is submitted. A computed run goes back to draft, so it must be recomputed.
     - Compensatory off: the credited days are reversed, but only if they haven't been used or applied for.

## Pay rate: entered by the organization

Nothing statutory is built in. Until all of the following are set, overtime can't be claimed as pay. Any approved paid claim that a run meets is then listed as a run warning, not paid.

| Setting | Meaning |
|---|---|
| `overtime.rate_multiplier` | Multiple of the ordinary hourly rate, as your applicable law or contract requires |
| `overtime.rate_basis` | Pay component codes that make up the ordinary rate of wages, e.g. `BASIC,DA` |
| `overtime.days_divisor` | Days per month for the daily rate, e.g. 26; 0 = calendar days of the month worked |
| `overtime.hours_per_day` | Hours per day for the hourly rate |
| `overtime.esi_wages` | Whether overtime pay counts toward ESI contribution wages. It never decides ESI coverage. Confirm the treatment for your establishment |

`OT = Σ claims [ basis ÷ divisor ÷ hours_per_day × hours × multiplier ]`, rounded to the rupee on the payslip line.

Overtime is taxable. It is never part of PF wages.

`overtime.quarter_cap_hours` (default 0, meaning no limit) refuses claims beyond that many hours in a calendar quarter. Pending and approved claims both count. The limit is checked again at approval. Enter the limit that applies to your state and establishment.

## Permissions

| Permission | Roles |
|---|---|
| `overtime.self` | every employee |
| `overtime.team.read` | reporting manager, laboratory manager, department head |
| `overtime.read` | HR administrator, HR executive, payroll manager, auditor |
| `overtime.approve`, `overtime.manage` | HR administrator |

## API (`/api/v1/overtime`)

| Method | Path | Notes |
|---|---|---|
| GET | `/eligible` | My days with recorded overtime not yet claimed, and the payout options (with the reason pay is unavailable) |
| POST | `/claims` | `{ workDate, minutes, payout: 'pay' \| 'comp_off', reason }` |
| GET | `/claims?scope=mine\|team\|all&status&period=YYYY-MM` | Includes `minutesByStatus` |
| GET | `/claims/:id` | Visible to the claimant, their reporting chain, overtime readers and the request's approvers |
| POST | `/claims/:id/withdraw` | Claimant, pending only |
| POST | `/claims/:id/cancel` | `{ reason }`. `overtime.manage`, approved only. Returns `payrollRunToRecompute` |

## Demo data

The demo turns on overtime calculation, adds a `COMP` (Compensatory Off) leave type, and gives laboratory and field staff some late evenings. The analyst has one approved compensatory off and more evenings to claim. The demo doesn't set a pay rate.
