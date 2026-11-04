# Attendance calculation rules (CALC_VERSION 3)

Source: `apps/api/src/modules/attendance/calc.ts` (pure function) and `service.ts` (data loading). Tests: `test/attendance-calc.test.ts`, `test/attendance-flows.test.ts`.

## Data

- **Raw events** (`attendance_events`): immutable. Sources are `web`, `mobile`, `biometric` and `regularization`. Each has a stable `source_ref` used for dedupe: `(tenant, source, source_ref)` is unique. Web and mobile use `<userId>:<client idempotency key>`. Biometric uses `<device serial>:<device event id>`. Regularization uses `<request id>:in|out`.
- **Daily result** (`attendance_daily`): one row per employee per work date. It is derived and recomputable, except when locked. It stores `calc_version` and a `policy_snapshot` (timezone, weekly offs, minimum gap, overtime flag, shift code).

## Inputs per work date

| Input | Source | Override levels |
|---|---|---|
| Timezone | `general.timezone` (default Asia/Kolkata) | tenant, branch |
| Shift | A one-day roster override, else the rotating roster the employee follows on the date, else the latest `shift_assignments` row effective on the date (see **Rotating rosters**) | — |
| Day type | Non-optional holiday (tenant-wide or the employee's branch) → `holiday`; a rostered day off (roster or override) → `weekly_off`; on dates without a roster, weekday in `attendance.weekly_offs` → `weekly_off`; else `working` | weekly offs: tenant, branch |
| Repeat-punch gap | `attendance.min_punch_gap_seconds` (default 60) | tenant |
| Overtime | `attendance.overtime_enabled` (default off) + shift `overtime_after_minutes` | tenant |

## Rules

1. **Employment window.** Outside joining date…exit date → `not_joined`.
2. **Punch window.** With a shift: `[shift start − 4 h, shift start + 20 h)` in the branch timezone. An overnight shift (end ≤ start, e.g. 22:00–06:00) therefore owns the next morning's punches. Without a shift: the local calendar day.
3. **Repeat punches.** A punch within `min gap` seconds of the previously kept punch is ignored for calculation (still stored). Exception `repeat_punches_ignored`.
4. **Pairing.** Explicit `in`/`out` directions are honoured. `unknown` alternates (in, out, in, …). An `in` while already in → `consecutive_in_punches`. An `out` with no open `in` → `out_without_in`. An open `in` at the end → `missing_out_punch`. Any of these makes a working day `missing_punch` (worked minutes from complete pairs only; nothing is guessed).
5. **Worked minutes.** Sum of paired intervals. Shift break minutes are deducted only when the day has exactly one pair. With multiple pairs, the gaps are the breaks.
6. **Late arrival.** `first in − shift start`, reported only if it exceeds the grace (`late_arrival`). Minutes count from shift start, not from the end of grace.
7. **Early exit.** `shift end − last out`, reported only if it exceeds the early-exit grace (`early_exit`).
8. **Status on a working day.** worked ≥ full-day minimum → `present`. ≥ half-day minimum → `half_day` (`short_hours`). Otherwise `absent` (`insufficient_hours`). No punches → `absent`. Defaults without a shift: 480 / 240 minutes.
9. **Weekly off / holiday.** Status stays `weekly_off` / `holiday`. Any punches add `worked_on_<type>`, and with overtime enabled all worked minutes count as overtime (input for future comp-off/OT modules).
10. **Overtime on working days.** `max(0, worked − overtime_after_minutes)` when enabled, the shift defines a threshold, and pairing is complete.
11. **Leave (v2).** Approved full-day leave on a working day → `on_leave` (punches add `worked_on_leave`). Half-day leave → the other half must be worked: worked ≥ half-day minimum → `present`, otherwise `half_day`. Leave on a weekly off or holiday doesn't change the day.
12. **Field duty (v3, docs/FIELD_DUTY.md).** When approved field duty covers the whole working day (on its own, or half-day duty with half-day leave) → `on_duty`. The day is paid, with or without punches. Punches still give worked minutes and overtime, but never lateness or early exit. Half-day field duty is treated like half-day leave: the other half must be worked. Full-day leave takes precedence (`duty_on_leave`). Field duty on a weekly off or holiday doesn't change the day; any work there is overtime as usual. `duty_fraction` records the share of the day on duty.

## When results are recalculated

- After every accepted event: the event's local date and the previous date (overnight windows).
- After a regularization is approved: that work date.
- After leave is approved or cancelled: its dates.
- After field duty is approved or cancelled: its dates up to today (later dates are calculated as they close).
- After a device enrolment ID is mapped: the dates of the reprocessed events.
- On `POST /attendance/recalculate` (≤ 62 days; skips locked days).
- On period lock: every employee for the whole period, then rows are locked.

Shift, holiday and settings changes do **not** recalculate automatically. HR recalculates the affected range.

## Rotating rosters

For laboratories and instrument rooms that run around the clock or in rotating shifts. Code: `modules/attendance/roster.ts` (schedule) and `roster-routes.ts`. Tests: `test/rosters.test.ts`.

**Pattern.** A pattern is a cycle of 1 to 56 days. Each day is a shift or a day off, for example `GEN GEN NIGHT NIGHT off off`. Its days are fixed once anyone has followed it, so past results stay explainable; to change a rotation, create a new pattern and move people to it. The name and status can always change.

**Assignment.** Employees follow a pattern from a date. They start on a chosen day of the cycle, so crews can be staggered: in a 14-day two-shift pattern, crew B starts on day 8. Each new roster ends the previous one the day before it starts, and withdraws any that hadn't started yet. A fixed shift assignment ends the roster from its first day. **End roster** returns people to their fixed shift.

**One-day override.** HR can set a single day to a different shift or to a day off, with a reason: a swap, cover for someone sick, or an extra day off. An override beats the roster, and it can be removed.

**Precedence for each date:** override, then roster, then fixed shift assignment.
- On a date covered by a roster or an override, the roster decides the days off. The weekly-off setting doesn't apply, so a Sunday can be a working day.
- Non-optional holidays still apply.
- On a rostered day off, the day is read in the window of the last shift worked before it in the cycle. Punches on a day off still count, and a night crew's off day uses the night window.

**Leave** uses the same schedule. Leave on a rostered day off isn't charged, and leave on a rostered working Sunday is.

**Recalculation.** Assigning, ending or overriding recalculates the affected days up to today, and locked periods are never touched. Changes can reach back at most 31 days and never into a locked period.

**Roster view:** `GET /attendance/roster`, at most 42 days.
- People with `attendance.read` or `attendance.configure` see everyone.
- Managers with `attendance.team.read` see their reporting team and themselves.
- Everyone else sees only themselves.
- Each cell shows the shift, or a day off, and whether a holiday, roster or override decided it.

Not built: employee-initiated swap requests with approval.

## Corrections (regularization)

An employee requests in and/or out times for a date within `attendance.regularization_window_days` (default 7). It can't be a future date or a locked date, and times must fall on or next to the work date. Routing: the employee's reporting manager (if they have a login), otherwise anyone with `attendance.approve`. On approval, new `regularization` events are added (original punches are kept) and the date is recalculated.

## Payroll lock

`attendance.lock` (Payroll Manager) locks a period of at most 62 days. Locking fails if it overlaps another lock or if any regularization in the period is pending. All employees are recalculated for the period, then rows are marked `locked`. Locked dates reject regularizations, shift assignments starting inside them, holiday changes, and recalculation.

## Known limitations

- Different shifts on consecutive days can make punch windows overlap or leave a gap (e.g. NIGHT then GEN the next day). The punch is counted in both overlapping windows. This also applies at a roster's shift changes (e.g. NIGHT followed by MORN); patterns normally put a day off between them.
- The `attendance.close_day` job (daily 01:30) materializes the previous day for everyone; between its runs, days with no events show as "Not calculated".
