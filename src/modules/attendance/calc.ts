import { zonedToInstant, addDays, minutesBetween } from './time.js';

/**
 * Pure daily attendance calculation. Deterministic: same inputs → same output.
 * Bump CALC_VERSION whenever the rules below change; stored rows record the
 * version used so historical results remain explainable.
 *
 * Rules (documented in docs/ATTENDANCE.md):
 *  - Punch window for a work date = [shift start − 4h, shift start + 20h). Without
 *    a shift, the local calendar day. Overnight shifts therefore own the
 *    early-morning punches of the next calendar day.
 *  - Punches closer than `minGapSeconds` to the previous kept punch are ignored.
 *  - Punches are paired in→out. Explicit directions are honoured; 'unknown'
 *    alternates. An unmatched punch makes the day `missing_punch`.
 *  - Break minutes are deducted only when the day has a single in/out pair
 *    (multi-pair days already exclude breaks between pairs).
 *  - Late = first in − shift start, counted only if beyond grace. Early exit
 *    likewise against shift end and early-exit grace.
 *  - Status on a working day: worked ≥ full-day minimum → present; ≥ half-day
 *    minimum → half_day; otherwise absent.
 *  - Weekly off / holiday keep their status; any work is flagged and, when
 *    overtime is enabled, counted fully as overtime.
 *  - (v2) Approved leave on a working day: full-day leave → `on_leave` (punches
 *    flag `worked_on_leave`). Half-day leave → the other half must be worked:
 *    worked ≥ half-day minimum → `present`, otherwise `half_day`. Leave on a
 *    weekly off / holiday does not change the day status.
 *  - (v3) Approved field duty on a working day: when field duty (with any half-day
 *    leave) covers the whole day → `on_duty`, paid, with or without punches; punches
 *    still give worked minutes and overtime, never lateness. Half-day field duty →
 *    the other half must be worked, exactly as with half-day leave. Full-day leave
 *    takes precedence (`duty_on_leave`). Field duty on a weekly off / holiday does
 *    not change the day: work there is overtime as usual.
 *  - (v4) An approved correction replaces what it corrects without touching the source event: a corrected in takes the
 *    place of the day's first punch if that was an in, a corrected out of the last punch if that was an out. Punches of
 *    unknown direction count as the direction pairing would give them. A correction filling a gap removes nothing, and
 *    the latest approved correction of a direction wins.
 */
export const CALC_VERSION = 4;

export interface ShiftPolicy {
  id: string;
  code: string;
  startTime: string;   // 'HH:MM[:SS]'
  endTime: string;
  breakMinutes: number;
  graceMinutes: number;
  earlyExitGraceMinutes: number;
  halfDayMinMinutes: number;
  fullDayMinMinutes: number;
  overtimeAfterMinutes: number | null;
}

export interface Punch {
  id: string; time: Date; direction: 'in' | 'out' | 'unknown';
  /** An approved correction, and when it was recorded (later ones win). */
  source?: 'regularization'; seq?: number;
}

export interface DayInput {
  workDate: string;
  timezone: string;
  shift: ShiftPolicy | null;
  dayType: 'working' | 'weekly_off' | 'holiday';
  employment: { joiningDate: string; exitDate: string | null };
  punches: Punch[];            // may include punches outside the window; filtered here
  minGapSeconds: number;
  overtimeEnabled: boolean;
  /** Approved leave covering this date (fraction 0.5 or 1). */
  leave?: { fraction: number; code: string } | null;
  /** Approved field duty covering this date (fraction 0.5 or 1). */
  duty?: { fraction: number } | null;
}

export type DayStatus = 'present' | 'half_day' | 'absent' | 'missing_punch' | 'weekly_off' | 'holiday' | 'not_joined' | 'on_leave' | 'on_duty';

export interface DayResult {
  workDate: string;
  shiftId: string | null;
  dayType: DayInput['dayType'];
  status: DayStatus;
  firstIn: Date | null;
  lastOut: Date | null;
  punchCount: number;
  workedMinutes: number;
  lateMinutes: number;
  earlyExitMinutes: number;
  overtimeMinutes: number;
  exceptions: string[];
  usedPunchIds: string[];
  leaveFraction: number;
  leaveTypeCode: string | null;
  dutyFraction: number;
}

export function shiftWindow(workDate: string, tz: string, shift: ShiftPolicy | null) {
  if (!shift) return { start: zonedToInstant(workDate, '00:00', tz), end: zonedToInstant(addDays(workDate, 1), '00:00', tz), shiftStart: null, shiftEnd: null };
  const shiftStart = zonedToInstant(workDate, shift.startTime, tz);
  const overnight = shift.endTime <= shift.startTime;
  const shiftEnd = zonedToInstant(overnight ? addDays(workDate, 1) : workDate, shift.endTime, tz);
  return { start: new Date(shiftStart.getTime() - 4 * 3600e3), end: new Date(shiftStart.getTime() + 20 * 3600e3), shiftStart, shiftEnd };
}

/** The punches of a day with approved corrections in place of what they correct (see v4 above). */
function applyCorrections(punches: Punch[]): Punch[] {
  const corrections = punches.filter((p) => p.source === 'regularization');
  if (!corrections.length) return punches;
  const latest = (dir: 'in' | 'out') => corrections.filter((c) => c.direction === dir).sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))[0];
  const correctedIn = latest('in'); const correctedOut = latest('out');
  const originals = punches.filter((p) => p.source !== 'regularization');
  if (correctedIn && originals[0] && originals[0].direction !== 'out') originals.shift();
  const last = originals[originals.length - 1];
  if (correctedOut && last && (last.direction === 'out' || (last.direction === 'unknown' && originals.length % 2 === 0))) originals.pop();
  return [...originals, ...(correctedIn ? [correctedIn] : []), ...(correctedOut ? [correctedOut] : [])]
    .sort((a, b) => a.time.getTime() - b.time.getTime() || a.id.localeCompare(b.id));
}

export function calculateDay(input: DayInput): DayResult {
  const { workDate, shift, dayType } = input;
  const base: DayResult = {
    workDate, shiftId: shift?.id ?? null, dayType, status: 'absent', firstIn: null, lastOut: null, punchCount: 0,
    workedMinutes: 0, lateMinutes: 0, earlyExitMinutes: 0, overtimeMinutes: 0, exceptions: [], usedPunchIds: [],
    leaveFraction: 0, leaveTypeCode: null, dutyFraction: 0,
  };
  if (workDate < input.employment.joiningDate || (input.employment.exitDate && workDate > input.employment.exitDate)) {
    return { ...base, status: 'not_joined' };
  }
  const win = shiftWindow(workDate, input.timezone, shift);
  const inWindow = applyCorrections(input.punches
    .filter((p) => p.time >= win.start && p.time < win.end)
    .sort((a, b) => a.time.getTime() - b.time.getTime() || a.id.localeCompare(b.id)));

  // Drop accidental repeats.
  const kept: Punch[] = [];
  for (const p of inWindow) {
    const last = kept[kept.length - 1];
    if (last && (p.time.getTime() - last.time.getTime()) / 1000 < input.minGapSeconds) continue;
    kept.push(p);
  }
  const exceptions: string[] = [];
  if (kept.length < inWindow.length) exceptions.push('repeat_punches_ignored');

  // Pair into sessions.
  const sessions: { in: Date; out: Date }[] = [];
  let open: Date | null = null;
  let unmatched = false;
  for (const p of kept) {
    const dir = p.direction === 'unknown' ? (open ? 'out' : 'in') : p.direction;
    if (dir === 'in') {
      if (open) { unmatched = true; exceptions.push('consecutive_in_punches'); }
      open = p.time;
    } else {
      if (!open) { unmatched = true; exceptions.push('out_without_in'); continue; }
      sessions.push({ in: open, out: p.time });
      open = null;
    }
  }
  if (open) { unmatched = true; exceptions.push('missing_out_punch'); }

  const firstIn = sessions[0]?.in ?? (kept[0] && kept[0].direction !== 'out' ? kept[0].time : null);
  const lastOut = sessions.length ? sessions[sessions.length - 1]!.out : null;
  let worked = sessions.reduce((sum, s) => sum + minutesBetween(s.in, s.out), 0);
  if (shift && sessions.length === 1 && worked > shift.breakMinutes) worked -= shift.breakMinutes;

  const duty = input.duty && input.duty.fraction > 0 ? (input.duty.fraction >= 1 ? 1 : 0.5) : 0;
  const result: DayResult = { ...base, firstIn, lastOut, punchCount: kept.length, workedMinutes: worked, usedPunchIds: kept.map((p) => p.id), exceptions, dutyFraction: duty };
  const overtimeOverShift = () => {
    if (input.overtimeEnabled && shift && shift.overtimeAfterMinutes !== null && !unmatched) result.overtimeMinutes = Math.max(0, worked - shift.overtimeAfterMinutes);
  };

  if (dayType !== 'working') {
    result.status = dayType;
    // Leave over a weekly off / holiday does not change the day (counted by the leave type's rules).
    if (kept.length) {
      exceptions.push('worked_on_' + dayType);
      if (input.overtimeEnabled) result.overtimeMinutes = worked;
    }
    return result;
  }
  const leave = input.leave && input.leave.fraction > 0 ? input.leave : null;
  if (leave) { result.leaveFraction = leave.fraction >= 1 ? 1 : 0.5; result.leaveTypeCode = leave.code; }
  if (leave && result.leaveFraction === 1) {
    result.status = 'on_leave';
    if (kept.length) exceptions.push('worked_on_leave');
    if (duty) exceptions.push('duty_on_leave');
    return result;
  }
  // Leave and field duty together: the part of the day already accounted for (0, 0.5 or 1).
  const covered = Math.min(1, result.leaveFraction + duty);
  if (duty && covered >= 1) {
    result.status = 'on_duty';
    if (kept.length) overtimeOverShift();
    return result;
  }
  if (!kept.length) { result.status = covered > 0 ? 'half_day' : 'absent'; return result; }

  if (shift && win.shiftStart && win.shiftEnd && !duty) {
    if (firstIn) {
      const late = minutesBetween(win.shiftStart, firstIn);
      if (late > shift.graceMinutes) { result.lateMinutes = late; exceptions.push('late_arrival'); }
    }
    if (lastOut) {
      const early = minutesBetween(lastOut, win.shiftEnd);
      if (early > shift.earlyExitGraceMinutes) { result.earlyExitMinutes = early; exceptions.push('early_exit'); }
    }
  }
  overtimeOverShift();
  if (unmatched) { result.status = 'missing_punch'; return result; }
  const half = shift?.halfDayMinMinutes ?? 240;
  // With half-day leave or field duty, working the other half (≥ half-day minimum) completes the day.
  const full = covered > 0 ? half : shift?.fullDayMinMinutes ?? 480;
  if (worked >= full) result.status = 'present';
  else if (worked >= half) { result.status = 'half_day'; exceptions.push('short_hours'); }
  else if (covered > 0) { result.status = 'half_day'; exceptions.push('insufficient_hours'); }
  else { result.status = 'absent'; exceptions.push('insufficient_hours'); }
  return result;
}
