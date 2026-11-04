# Travel management

Module `travel` (depends on `expenses`). Code: `src/modules/travel/`. Tests: `test/travel.test.ts`.

A trip request covers the purpose, route, dates, travel mode and a cost estimate (travel, stay, local conveyance, meals, other), with an optional **advance**. After the trip, the employee claims the expenses from the trip itself, and the advance is set off against that claim.

## Flow

1. **Request.** The employee requests a trip.
   - It must start on or after today plus `travel.min_notice_days` (default 0) and last at most `travel.max_days` (default 60).
   - The advance can be at most `travel.max_advance_percent` of the estimate (default 80%).
   - A request is refused if it overlaps another pending or approved trip.
2. **Approve.** The reporting manager approves.
   - Finance (`travel.approve`) also approves when there is an advance, the trip is international, the estimate is at or above `travel.finance_approval_above` (empty by default), or the employee has no manager with a login.
   - The traveller never approves their own trip.
   - The approval summary shows the route, dates, estimate and advance.
3. **Field duty.** When the trip is approved and **Count as field duty** is on (the default), the trip dates become approved field duty (official work at the destination). Attendance then shows those days as on duty (docs/FIELD_DUTY.md).
   - This is skipped, with the reason recorded on the trip, when field duty is not in use, the dates are locked for payroll, or leave or other field duty already covers them.
4. **Advance.** Finance (`expenses.pay`) records the advance as paid with the bank reference, and the traveller is notified. Nobody can pay their own advance.
5. **Claim.** From the trip, the traveller starts its expense claim. This creates a draft in Expenses, linked to the trip. They add items and submit it as usual (manager, then finance).
   - **On approval, the outstanding advance is set off first.**
     - If the advance covers the whole claim, the claim is settled at once ("Set off against travel advance").
     - Otherwise only the difference goes into a reimbursement batch. Payables, batch totals, the bank CSV and the "reimbursed" notification all use the difference.
6. **Complete and close.** The traveller marks the trip completed once it has started.
   - Advance left over is returned by the employee. Finance records the returned amount.
   - Finance closes the trip when nothing is outstanding and no claim for it is still in progress.

## Cancelling

- **Pending trip:** the traveller can withdraw it.
- **Approved trip:** the traveller can cancel it before it starts. Finance (`travel.approve`) can cancel it until it is completed.
- **After cancelling:** the trip's field duty is cancelled, except on dates already locked for payroll. A paid advance stays outstanding until it is returned.

## Settlement

`GET /travel/requests/:id` returns `settlement`, made up of these amounts:

| Field | Meaning |
|---|---|
| `advancePaid` | Advance paid out |
| `claimed` | Total of the trip's approved and paid claims |
| `advanceAdjusted` | The part of those claims covered by the advance |
| `reimbursable` | `claimed − advanceAdjusted` |
| `recovered` | Advance returned by the employee |
| `outstanding` | `advancePaid − advanceAdjusted − recovered`: still with the employee |

## Permissions

| Permission | Roles |
|---|---|
| `travel.self` | every employee |
| `travel.team.read` | reporting manager, laboratory manager, department head |
| `travel.read` | HR administrator, finance manager, payroll manager, auditor |
| `travel.approve` | finance manager |
| `travel.manage` (settings) | finance manager |

Paying advances, recording returns and closing a trip need `expenses.pay` (finance manager, payroll manager).

## Not included

- **Travel classes by grade** (who may fly, hotel caps). These are checked at approval. Per-diem and mileage rates are in Expenses (docs/EXPENSES.md → Allowances): the trip form can quote the per diem for the trip, and the trip's claim prices allowances from the rates and keeps per diem within the trip's days.
- **Bookings** (tickets, hotels), **multi-currency** and **corporate cards**.
- **Recovery through payroll.** Unspent advance is returned by the employee and recorded by finance. Payroll recovery belongs to the advances and loans module.
