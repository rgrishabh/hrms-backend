import { describe, it, expect } from 'vitest';
import { calculateDay, type ShiftPolicy, type Punch, type DayInput } from '../src/modules/attendance/calc.js';
import { zonedToInstant, localDate, tzOffsetMinutes, todaysPunches } from '../src/modules/attendance/time.js';

const TZ = 'Asia/Kolkata';
const GEN: ShiftPolicy = {
  id: 'gen',
  code: 'GEN',
  startTime: '09:30',
  endTime: '18:00',
  breakMinutes: 30,
  graceMinutes: 10,
  earlyExitGraceMinutes: 10,
  halfDayMinMinutes: 240,
  fullDayMinMinutes: 450,
  overtimeAfterMinutes: 540,
};
const NIGHT: ShiftPolicy = { ...GEN, id: 'night', code: 'NIGHT', startTime: '22:00', endTime: '06:00', fullDayMinMinutes: 420, overtimeAfterMinutes: 480 };

let seq = 0;
const p = (date: string, time: string, direction: Punch['direction'] = 'unknown'): Punch => ({ id: `p${++seq}`, time: zonedToInstant(date, time, TZ), direction });
const day = (over: Partial<DayInput>): DayInput => ({
  workDate: '2026-03-10',
  timezone: TZ,
  shift: GEN,
  dayType: 'working',
  employment: { joiningDate: '2024-01-01', exitDate: null },
  punches: [],
  minGapSeconds: 60,
  overtimeEnabled: false,
  ...over,
});

describe('timezone helpers', () => {
  it('converts IST wall-clock to UTC instants', () => {
    expect(zonedToInstant('2026-03-10', '09:30', TZ).toISOString()).toBe('2026-03-10T04:00:00.000Z');
    expect(tzOffsetMinutes(new Date('2026-03-10T00:00:00Z'), TZ)).toBe(330);
    expect(localDate(new Date('2026-03-10T19:00:00Z'), TZ)).toBe('2026-03-11'); // 00:30 IST next day
  });
  it('handles DST zones for branches abroad', () => {
    // 2026-03-29 is the EU DST switch; 09:00 Berlin = 07:00Z after the change.
    expect(zonedToInstant('2026-03-29', '09:00', 'Europe/Berlin').toISOString()).toBe('2026-03-29T07:00:00.000Z');
  });
});

describe('calculateDay', () => {
  it('marks a full on-time day present and deducts the break for a single pair', () => {
    const r = calculateDay(day({ punches: [p('2026-03-10', '09:25'), p('2026-03-10', '18:05')] }));
    expect(r.status).toBe('present');
    expect(r.workedMinutes).toBe(520 - 30);
    expect(r.lateMinutes).toBe(0);
    expect(r.exceptions).toEqual([]);
  });

  it('does not flag lateness within grace, flags it beyond grace with minutes from shift start', () => {
    expect(calculateDay(day({ punches: [p('2026-03-10', '09:40'), p('2026-03-10', '18:00')] })).lateMinutes).toBe(0);
    const late = calculateDay(day({ punches: [p('2026-03-10', '09:41'), p('2026-03-10', '18:30')] }));
    expect(late.lateMinutes).toBe(11);
    expect(late.exceptions).toContain('late_arrival');
  });

  it('flags early exit beyond grace', () => {
    const r = calculateDay(day({ punches: [p('2026-03-10', '09:30'), p('2026-03-10', '17:30')] }));
    expect(r.earlyExitMinutes).toBe(30);
    expect(r.exceptions).toContain('early_exit');
  });

  it('assigns overnight-shift punches after midnight to the shift start date', () => {
    const punches = [p('2026-03-10', '21:55'), p('2026-03-11', '06:02')];
    const r = calculateDay(day({ shift: NIGHT, punches }));
    expect(r.status).toBe('present');
    expect(r.workedMinutes).toBe(487 - 30);
    // …and the next day does not double count the 06:02 punch.
    const next = calculateDay(day({ workDate: '2026-03-11', shift: NIGHT, punches }));
    expect(next.punchCount).toBe(0);
    expect(next.status).toBe('absent');
  });

  it('reports missing out-punch instead of guessing', () => {
    const r = calculateDay(day({ punches: [p('2026-03-10', '09:30', 'in')] }));
    expect(r.status).toBe('missing_punch');
    expect(r.exceptions).toContain('missing_out_punch');
    expect(r.workedMinutes).toBe(0);
  });

  it('flags an out-punch without an in-punch', () => {
    const r = calculateDay(day({ punches: [p('2026-03-10', '18:00', 'out')] }));
    expect(r.status).toBe('missing_punch');
    expect(r.exceptions).toContain('out_without_in');
  });

  it('ignores accidental repeat punches within the minimum gap', () => {
    const r = calculateDay(day({ punches: [p('2026-03-10', '09:30'), p('2026-03-10', '09:30'), p('2026-03-10', '18:00')] }));
    expect(r.punchCount).toBe(2);
    expect(r.status).toBe('present');
    expect(r.exceptions).toContain('repeat_punches_ignored');
  });

  it('sums multiple pairs and does not deduct break again', () => {
    const r = calculateDay(day({ punches: [p('2026-03-10', '09:30'), p('2026-03-10', '13:30'), p('2026-03-10', '14:00'), p('2026-03-10', '18:00')] }));
    expect(r.workedMinutes).toBe(480);
    expect(r.status).toBe('present');
  });

  it('classifies half day and absent by worked minutes', () => {
    expect(calculateDay(day({ punches: [p('2026-03-10', '09:30'), p('2026-03-10', '14:30')] })).status).toBe('half_day');
    const short = calculateDay(day({ punches: [p('2026-03-10', '09:30'), p('2026-03-10', '11:00')] }));
    expect(short.status).toBe('absent');
    expect(short.exceptions).toContain('insufficient_hours');
  });

  it('keeps weekly off status but records work and overtime when enabled', () => {
    const r = calculateDay(day({ dayType: 'weekly_off', overtimeEnabled: true, punches: [p('2026-03-10', '10:00'), p('2026-03-10', '14:00')] }));
    expect(r.status).toBe('weekly_off');
    expect(r.exceptions).toContain('worked_on_weekly_off');
    expect(r.overtimeMinutes).toBe(240 - 30);
  });

  it('computes overtime only beyond the shift threshold when enabled', () => {
    const punches = [p('2026-03-10', '09:30'), p('2026-03-10', '20:00')];
    expect(calculateDay(day({ punches })).overtimeMinutes).toBe(0);
    expect(calculateDay(day({ punches, overtimeEnabled: true })).overtimeMinutes).toBe(630 - 30 - 540);
  });

  it('returns not_joined before joining and after exit', () => {
    expect(calculateDay(day({ employment: { joiningDate: '2026-03-11', exitDate: null } })).status).toBe('not_joined');
    expect(calculateDay(day({ employment: { joiningDate: '2024-01-01', exitDate: '2026-03-09' } })).status).toBe('not_joined');
  });

  it('uses the local calendar day when no shift is assigned', () => {
    const r = calculateDay(day({ shift: null, punches: [p('2026-03-10', '00:10'), p('2026-03-10', '08:30'), p('2026-03-11', '00:05')] }));
    expect(r.punchCount).toBe(2);
    expect(r.workedMinutes).toBe(500);
    expect(r.status).toBe('present');
  });

  it('is deterministic regardless of punch input order', () => {
    const a = [p('2026-03-10', '09:30'), p('2026-03-10', '13:00'), p('2026-03-10', '13:30'), p('2026-03-10', '18:00')];
    const r1 = calculateDay(day({ punches: a }));
    const r2 = calculateDay(day({ punches: [...a].reverse() }));
    expect({ ...r2, usedPunchIds: [] }).toEqual({ ...r1, usedPunchIds: [] });
  });

  describe('approved leave (CALC_VERSION 2)', () => {
    it('full-day leave on a working day is on_leave, and work on that day is flagged', () => {
      expect(calculateDay(day({ leave: { fraction: 1, code: 'CL' } }))).toMatchObject({ status: 'on_leave', leaveFraction: 1, leaveTypeCode: 'CL', exceptions: [] });
      const worked = calculateDay(day({ leave: { fraction: 1, code: 'CL' }, punches: [p('2026-03-10', '09:30'), p('2026-03-10', '12:00')] }));
      expect(worked.status).toBe('on_leave');
      expect(worked.exceptions).toContain('worked_on_leave');
    });
    it('half-day leave: working the half-day minimum completes the day; less is a half day; nothing is a half day', () => {
      const leave = { fraction: 0.5, code: 'CL' };
      expect(calculateDay(day({ leave, punches: [p('2026-03-10', '14:00'), p('2026-03-10', '18:30')] }))).toMatchObject({ status: 'present', leaveFraction: 0.5 });
      expect(calculateDay(day({ leave, punches: [p('2026-03-10', '14:00'), p('2026-03-10', '15:00')] })).status).toBe('half_day');
      expect(calculateDay(day({ leave })).status).toBe('half_day');
    });
    it('leave on a weekly off or holiday does not change the day', () => {
      expect(calculateDay(day({ dayType: 'weekly_off', leave: { fraction: 1, code: 'CL' } })).status).toBe('weekly_off');
      expect(calculateDay(day({ dayType: 'holiday', leave: { fraction: 1, code: 'CL' } })).status).toBe('holiday');
    });
    it('without leave the v1 rules are unchanged', () => {
      expect(calculateDay(day({ punches: [p('2026-03-10', '14:00'), p('2026-03-10', '15:00')] })).status).toBe('absent');
      expect(calculateDay(day({})).status).toBe('absent');
    });
  });
});

describe("today's punches on the clock-in card", () => {
  const p = (direction: string, is_today: boolean) => ({ direction, is_today });
  it("hides yesterday's finished day", () => {
    expect(todaysPunches([p('in', false), p('out', false)])).toEqual([]);
    expect(todaysPunches([p('in', false), p('out', false), p('in', true)])).toEqual([p('in', true)]);
  });
  it('keeps an overnight shift that started before midnight', () => {
    expect(todaysPunches([p('out', false), p('in', false), p('out', true)])).toEqual([p('in', false), p('out', true)]);
    expect(todaysPunches([p('in', false)])).toEqual([p('in', false)]);
  });
  it('shows all of today', () => {
    expect(todaysPunches([p('in', true), p('out', true)])).toHaveLength(2);
    expect(todaysPunches([])).toEqual([]);
  });
});

describe('calculateDay — field duty (v3)', () => {
  it('a full day of field duty is on duty, paid, without any punches', () => {
    const r = calculateDay(day({ duty: { fraction: 1 } }));
    expect(r).toMatchObject({ status: 'on_duty', dutyFraction: 1, workedMinutes: 0, lateMinutes: 0 });
  });
  it('punches on a field-duty day give hours and overtime, never lateness', () => {
    const r = calculateDay(day({ duty: { fraction: 1 }, overtimeEnabled: true, punches: [p('2026-03-10', '11:15'), p('2026-03-10', '22:15')] }));
    expect(r).toMatchObject({ status: 'on_duty', lateMinutes: 0, earlyExitMinutes: 0, workedMinutes: 660 - 30, overtimeMinutes: 630 - 540 });
    expect(r.exceptions).not.toContain('late_arrival');
  });
  it('half a day of field duty: the other half must be worked, as with half-day leave', () => {
    expect(calculateDay(day({ duty: { fraction: 0.5 }, punches: [p('2026-03-10', '13:30'), p('2026-03-10', '18:00')] })).status).toBe('present');
    expect(calculateDay(day({ duty: { fraction: 0.5 } })).status).toBe('half_day');
    expect(calculateDay(day({ duty: { fraction: 0.5 }, punches: [p('2026-03-10', '16:00'), p('2026-03-10', '18:00')] })).status).toBe('half_day');
  });
  it('half-day leave and half-day field duty cover the day; full-day leave wins over field duty', () => {
    expect(calculateDay(day({ duty: { fraction: 0.5 }, leave: { fraction: 0.5, code: 'CL' } }))).toMatchObject({ status: 'on_duty', leaveFraction: 0.5, dutyFraction: 0.5 });
    const r = calculateDay(day({ duty: { fraction: 1 }, leave: { fraction: 1, code: 'SL' } }));
    expect(r.status).toBe('on_leave');
    expect(r.exceptions).toContain('duty_on_leave');
  });
  it('field duty on a weekly off does not change the day; work there is overtime as usual', () => {
    const r = calculateDay(day({ dayType: 'weekly_off', duty: { fraction: 1 }, overtimeEnabled: true, punches: [p('2026-03-10', '09:00'), p('2026-03-10', '13:00')] }));
    expect(r).toMatchObject({ status: 'weekly_off', overtimeMinutes: 240 - 30 });
  });
});

describe('F-8 approved corrections replace what they correct', () => {
  const wd = '2026-03-10';
  const at = (hm: string) => new Date(`${wd}T${hm}:00+05:30`);
  const p = (id: string, hm: string, direction: Punch['direction'], source?: 'regularization', seq?: number): Punch => ({
    id,
    time: at(hm),
    direction,
    ...(source ? { source, seq } : {}),
  });
  const run = (punches: Punch[]) =>
    calculateDay({
      workDate: wd,
      timezone: 'Asia/Kolkata',
      shift: null,
      dayType: 'working',
      employment: { joiningDate: '2020-01-01', exitDate: null },
      punches,
      minGapSeconds: 60,
      overtimeEnabled: false,
    });

  it('a corrected in replaces the first in', () => {
    const r = run([p('a', '09:30', 'in'), p('b', '18:00', 'out'), p('c', '09:00', 'in', 'regularization', 1)]);
    expect(r.status).toBe('present');
    expect(r.firstIn).toEqual(at('09:00'));
    expect(r.workedMinutes).toBe(540);
  });
  it('a corrected out replaces the last out, earlier or later', () => {
    const later = run([p('a', '09:30', 'in'), p('b', '13:00', 'out'), p('c', '18:00', 'out', 'regularization', 1)]);
    expect(later.status).toBe('present');
    expect(later.lastOut).toEqual(at('18:00'));
    const earlier = run([p('a', '09:30', 'in'), p('b', '18:00', 'out'), p('c', '17:00', 'out', 'regularization', 1)]);
    expect(earlier.workedMinutes).toBe(450);
  });
  it('a correction filling a gap removes nothing', () => {
    const r = run([p('a', '09:30', 'in'), p('b', '13:00', 'out'), p('c', '14:00', 'in'), p('d', '18:30', 'out', 'regularization', 1)]);
    expect(r.status).toBe('present');
    expect(r.workedMinutes).toBe(210 + 270);
    expect(run([p('b', '18:00', 'out'), p('c', '09:00', 'in', 'regularization', 1)]).status).toBe('present');
  });
  it('works with direction-less device punches', () => {
    expect(run([p('a', '09:30', 'unknown'), p('b', '18:00', 'unknown'), p('c', '09:00', 'in', 'regularization', 1)]).workedMinutes).toBe(540);
    expect(run([p('a', '09:30', 'unknown'), p('b', '13:00', 'unknown'), p('c', '18:00', 'out', 'regularization', 1)]).workedMinutes).toBe(510);
    expect(run([p('a', '09:30', 'unknown'), p('c', '18:00', 'out', 'regularization', 1)]).workedMinutes).toBe(510);
  });
  it('the latest approved correction wins', () => {
    const r = run([p('a', '09:30', 'in'), p('b', '18:00', 'out'), p('c', '09:00', 'in', 'regularization', 1), p('d', '09:15', 'in', 'regularization', 2)]);
    expect(r.firstIn).toEqual(at('09:15'));
    expect(r.status).toBe('present');
  });
  it('without corrections, pairing is unchanged', () => {
    expect(run([p('a', '09:30', 'in'), p('b', '09:45', 'in'), p('c', '18:00', 'out')]).status).toBe('missing_punch');
  });
});
