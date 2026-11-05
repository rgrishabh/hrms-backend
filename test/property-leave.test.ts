import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Decimal } from 'decimal.js';
import { countDays, dateFraction, leaveYearBounds, leaveYearOf } from '../src/modules/leave/service.js';
import { monthlyCredit } from '../src/modules/leave/jobs.js';
import { addDays, dateRange } from '../src/modules/attendance/time.js';

const dateArb = fc.integer({ min: 0, max: 3650 }).map((n) => addDays('2020-01-01', n));
const entitlement = fc.integer({ min: 0, max: 732 }).map((n) => n / 2);

describe('leave properties', () => {
  it('twelve monthly credits add up to the entitlement exactly, and each is about a twelfth', () => {
    fc.assert(
      fc.property(entitlement, (ent) => {
        const credits = Array.from({ length: 12 }, (_, x) => monthlyCredit(ent, x + 1));
        expect(credits.reduce((s, c) => s.plus(c), new Decimal(0)).toNumber()).toBe(ent);
        for (const c of credits) {
          expect(c.gte(0)).toBe(true);
          expect(c.minus(new Decimal(ent).div(12)).abs().toNumber()).toBeLessThanOrEqual(0.011);
        }
      }),
    );
  });

  it('the running total after k months never exceeds the pro-rata share by more than rounding', () => {
    fc.assert(
      fc.property(entitlement, fc.integer({ min: 1, max: 12 }), (ent, k) => {
        let total = new Decimal(0);
        for (let m = 1; m <= k; m++) total = total.plus(monthlyCredit(ent, m));
        expect(total.minus(new Decimal(ent).times(k).div(12)).abs().toNumber()).toBeLessThanOrEqual(0.005);
      }),
    );
  });

  it('counted days stay within the calendar span and move in halves', () => {
    fc.assert(
      fc.property(
        dateArb,
        fc.integer({ min: 0, max: 40 }),
        fc.constantFrom('full', 'second_half') as fc.Arbitrary<'full' | 'second_half'>,
        fc.constantFrom('full', 'first_half') as fc.Arbitrary<'full' | 'first_half'>,
        fc.boolean(),
        fc.array(fc.integer({ min: 0, max: 40 })),
        (start, len, startHalf, endHalf, countOff, offs) => {
          fc.pre(!(len === 0 && startHalf !== 'full' && endHalf !== 'full'));
          const end = addDays(start, len);
          const nonWorking = new Set(offs.map((o) => addDays(start, o)));
          const { days, perDate } = countDays(start, end, startHalf, endHalf, nonWorking, countOff);
          expect(days.gte(0)).toBe(true);
          expect(days.lte(len + 1)).toBe(true);
          expect(days.times(2).isInteger()).toBe(true);
          expect(perDate.length).toBe(len + 1);
          expect(perDate.reduce((s, p) => s + p.fraction, 0)).toBe(days.toNumber());
          if (countOff) expect(days.toNumber()).toBe(len + 1 - (startHalf !== 'full' ? 0.5 : 0) - (endHalf !== 'full' ? 0.5 : 0));
        },
      ),
    );
  });

  it('a morning and an afternoon of one date make exactly one day', () => {
    fc.assert(
      fc.property(dateArb, (d) => {
        const am = dateFraction(d, { start_date: d, end_date: d, start_half: 'full', end_half: 'first_half' });
        const pm = dateFraction(d, { start_date: d, end_date: d, start_half: 'second_half', end_half: 'full' });
        expect(am + pm).toBe(1);
      }),
    );
  });

  it('every date belongs to the leave year whose bounds contain it', () => {
    fc.assert(
      fc.property(dateArb, fc.integer({ min: 1, max: 12 }), (d, startMonth) => {
        const { start, end } = leaveYearBounds(leaveYearOf(d, startMonth), startMonth);
        expect(start <= d && d <= end).toBe(true);
        expect([...dateRange(start, end)].length).toBeGreaterThanOrEqual(365);
      }),
    );
  });
});
