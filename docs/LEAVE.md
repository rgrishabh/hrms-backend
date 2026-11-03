# Leave management

Module key `leave` (enabled by `ENABLED_MODULES=default`). Code: `apps/api/src/modules/leave/`. Tests: `test/leave.test.ts`, `test/attendance-calc.test.ts`.

> Leave types are **the organization's policy**, configured by HR. The application hardcodes no statutory entitlements (state Shops & Establishments rules, maternity benefit, etc.). Verify them with a qualified advisor before publishing types. See INDIAN_PAYROLL_COMPLIANCE.md (C8, C11).

## Concepts

| Concept | Rule |
|---|---|
| Leave year | 12 months starting in the month set by the `leave.year_start_month` setting (default January). Identified by the calendar year it starts in (Apr 2026–Mar 2027 = 2026). A request cannot span two leave years |
| Leave type | Code and name; paid or unpaid; half days allowed; *needs a balance* (off for leave without pay); accrual `annual`, `monthly` or `none`; entitlement per year; carry-forward cap; maximum balance; count weekly offs and holidays inside the range ("sandwich"); minimum notice; maximum days per request; eligible after N days of service; applicable employment types; active or inactive |
| Ledger | Append-only `leave_ledger`. Balance = sum of entries for (employee, type, year). Entry types: `opening`, `accrual`, `consumption`, `reversal`, `adjustment`, `carry_forward`, `lapse`. Every entry has a unique reference, so jobs are idempotent. The database role can't update or delete entries |
| Available | balance − days of **pending** requests (reserved) |

## Counting days

For each date in the range:
- A weekly off (the `attendance.weekly_offs` setting, which may be overridden per branch) or a non-optional holiday (company-wide or the employee's branch) counts **0**, unless the type counts non-working days.
- Otherwise it counts **1**, minus 0.5 on the start date if the leave starts in the second half, and minus 0.5 on the end date if the employee returns after the first half.
- For a single day, choose either first half only or second half only, not both.

## Requests and approval

Checks on submit (the same checks power the live preview):
- the employee is active and the type applies (status, employment type, service days);
- half days are allowed for the type;
- the dates fall within employment and within one leave year;
- notice: future leave only, waived when HR applies on someone's behalf;
- the range contains at least one working day, and doesn't exceed the type's maximum per request;
- no date is locked for payroll, and the leave doesn't overlap a pending or approved leave;
- the available balance is enough (unless the type needs no balance).

Routing goes to the employee's reporting manager if they have a login, otherwise to anyone with `leave.approve` (HR). The requester can never approve their own request.

On approval, the balance is re-checked, a `consumption` entry is written, and attendance is recalculated for the range.

**Cancellation**
- **Pending:** the employee, or `leave.manage`.
- **Approved:** the employee before the leave starts, or `leave.manage` at any time. A `reversal` entry returns the days. Dates locked for payroll can't be cancelled.

## Attendance (calculation v2)

- **Full-day leave on a working day** → status `on_leave`. Punches on that day are flagged `worked_on_leave`.
- **Half-day leave** → the day is `present` if the half-day minimum is worked, otherwise `half_day`.
- **Leave over a weekly off or holiday** → the day status doesn't change.

`attendance_daily` records `leave_fraction` and `leave_type_code` for payroll.

## Jobs (Administration tab, or the API)

| Job | Behaviour |
|---|---|
| Accruals `POST /leave/accruals {leaveYear, throughMonth}` | **Annual:** the full entitlement once. Joiners within the year get it pro-rated by remaining whole months (joining month counts), rounded **down** to 0.5. **Monthly:** entitlement ÷ 12 (2 decimals) per month employed, up to `throughMonth`. Never exceeds the type's maximum balance. Re-running credits nothing twice |
| Year-end `POST /leave/year-end {leaveYear}` | Refused while requests of that year are pending. For each positive closing balance: carries `min(balance, carry_forward_max)` into the next year (`carry_forward`) and lapses the rest (`lapse`). Idempotent |
| Adjustment `POST /leave/adjustments` | Manual ± days (multiples of 0.5) as `adjustment` or `opening` (migration from a previous system), with a required note. Audited |

The `leave.accrual` background job runs on the 1st of every month at 02:00 (catching up later in the month if the app was down) and credits annual entitlements once per year and monthly accruals up to the current month. Year-end is **not** automatic: it's an HR decision, run from the Administration tab.

## Permissions

| Permission | Roles (default) | Allows |
|---|---|---|
| `leave.self` | everyone | Apply, view own balances and requests, cancel own |
| `leave.team.read` | Reporting Manager, Department Head, Laboratory Manager | Team balances, requests, calendar |
| `leave.read` | HR Admin, HR Executive, Payroll, Auditor | Everyone's leave |
| `leave.approve` | HR Admin, HR Executive | Approve when the employee has no manager login |
| `leave.manage` | HR Admin | Types, accruals, year-end, adjustments, apply on behalf, cancel any |

## Not yet implemented

Compensatory off earned from overtime, leave encashment (needs payroll), medical certificate attachments (needs document storage), email notifications and restricted/optional holiday quotas.
