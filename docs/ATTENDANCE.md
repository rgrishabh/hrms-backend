# Attendance calculation rules (CALC_VERSION 3)

Source: `apps/api/src/modules/attendance/calc.ts` (pure function) and `service.ts` (data loading). Tests: `test/attendance-calc.test.ts`, `test/attendance-flows.test.ts`.

## Data

- **Raw events** (`attendance_events`): immutable. Sources are `web`, `mobile`, `biometric` and `regularization`. Each has a stable `source_ref` used for dedupe: `(tenant, source, source_ref)` is unique. Web and mobile use `<userId>:<client idempotency key>`. Biometric uses `<device serial>:<device event id>`. Regularization uses `<request id>:in|out`.
- **Daily result** (`attendance_daily`): one row per employee per work date. It is derived and recomputable, except when locked. It stores `calc_version` and a `policy_snapshot` (timezone, weekly offs, minimum gap, overtime flag, shift code).

## Inputs per work date

| Input | Source | Override levels |
|---|---|---|
| Timezone | `general.timezone` (default Asia/Kolkata) | tenant, branch |
| Shift | Latest `shift_assignments` row effective on the date | — |
| Day type | Non-optional holiday (tenant-wide or the employee's branch) → `holiday`; weekday in `attendance.weekly_offs` → `weekly_off`; else `working` | weekly offs: tenant, branch |
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

## Corrections (regularization)

An employee requests in and/or out times for a date within `attendance.regularization_window_days` (default 7). It can't be a future date or a locked date, and times must fall on or next to the work date. Routing: the employee's reporting manager (if they have a login), otherwise anyone with `attendance.approve`. On approval, new `regularization` events are added (original punches are kept) and the date is recalculated.

## Payroll lock

`attendance.lock` (Payroll Manager) locks a period of at most 62 days. Locking fails if it overlaps another lock or if any regularization in the period is pending. All employees are recalculated for the period, then rows are marked `locked`. Locked dates reject regularizations, shift assignments starting inside them, holiday changes, and recalculation.

## Known limitations

- Different shifts on consecutive days can make punch windows overlap or leave a gap (e.g. NIGHT then GEN the next day). The punch is counted in both overlapping windows. Rotating rosters will need explicit window boundaries.
- The `attendance.close_day` job (daily 01:30) materializes the previous day for everyone; between its runs, days with no events show as "Not calculated".
