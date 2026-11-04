# Field duty

Module `field_duty` (depends on `attendance`). Code: `src/modules/field-duty/`. Tests: `test/field-duty.test.ts`, plus the field-duty cases in `test/attendance-calc.test.ts`.

Field duty is approved work away from the workplace: field sampling, a client visit, a site audit, training or other official work. An approved day counts as **on duty** in attendance. It is paid, and staff at a site don't need to punch at the office.

## Flow

1. **Request.** The employee requests field duty for one or more days, or half of a single day. They give the purpose, the place, and optionally the client and a work-order reference.
   - HR (`field_duty.manage`) can record it for an employee, e.g. for staff without a login. It still goes to the manager.
   - Requests may start up to `field_duty.backdate_days` back (default 7) and up to `field_duty.advance_days` ahead (default 90). A request covers at most `field_duty.max_days` days (default 31).
   - A request is refused if it overlaps pending or approved field duty or leave. A half day of each fits only as opposite halves.
   - A request is refused if any date is in a period locked for payroll.
2. **Approve.** The reporting manager approves.
   - HR (`field_duty.approve`) approves as well when `field_duty.hr_approval` is on, or when the employee has no manager with a login.
   - Neither the employee nor whoever recorded it can approve it.
   - On approval, the days that have begun are recalculated. Later days are calculated as each day closes.
3. **Report.** Once the duty has started, the employee (or HR) records the outcome: completed, partly completed or not done. Anything other than completed needs a note.
4. **Withdraw or cancel.**
   - The employee, or whoever recorded it, can withdraw a pending request.
   - Approved field duty can be cancelled by the employee before it starts, and by HR until its dates are locked for payroll. HR can never cancel their own. Attendance for those dates is recalculated.

## Attendance and payroll

Attendance rule 12 in docs/ATTENDANCE.md:
- Approved field duty covering a working day makes it `on_duty`.
- Half-day field duty needs the other half worked, just like half-day leave.
- Full-day leave takes precedence.
- Field duty on a weekly off or holiday doesn't change the day. Any punches there count as overtime as usual, and can be claimed through the overtime module.

Payroll treats `on_duty` as a paid day. If the other half of the day is unpaid leave, that half is loss of pay.

The dashboard shows **On field duty** today for the team and for the organization. People on field duty aren't counted as "not clocked in yet". The attendance summary report has a Field duty column, and those days count as attended.

## Permissions

| Permission | Roles |
|---|---|
| `field_duty.self` | every employee |
| `field_duty.team.read` | reporting manager, laboratory manager, department head |
| `field_duty.read` | HR administrator, HR executive, payroll manager, auditor |
| `field_duty.approve` | HR administrator, HR executive |
| `field_duty.manage` | HR administrator |

## Demo data

Sample collection staff have approved field duty at client sites over the last weeks, with no office punches on those days. The sampler has a two-day trip, a client visit that hasn't been reported on yet, and field duty on the next working day.
