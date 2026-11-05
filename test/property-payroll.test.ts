import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Decimal } from 'decimal.js';
import { calculate, progressiveTax, type CalcInput, type Component } from '../src/modules/payroll/calc.js';
import { paidPerStretch } from '../src/modules/payroll/service.js';

// Rates and thresholds are arbitrary generated inputs: these test arithmetic properties, not statutory values.
const comp = (code: string, o: Partial<Component> = {}): Component => ({
  code,
  name: code,
  kind: 'earning',
  calc: 'fixed',
  base_codes: [],
  prorate: true,
  taxable: true,
  pf_wage: false,
  esi_wage: true,
  position: 0,
  ...o,
});
const COMPONENTS = [
  comp('BASIC', { pf_wage: true, position: 1 }),
  comp('HRA', { calc: 'percent', base_codes: ['BASIC'], position: 2 }),
  comp('SPECIAL', { position: 3 }),
  comp('FLAT', { prorate: false, position: 4 }),
  comp('CANTEEN', { kind: 'deduction', prorate: false, position: 5 }),
];
const money = fc.integer({ min: 0, max: 1_000_000 });
const pct = fc.integer({ min: 0, max: 30 });
const tdsRule = fc
  .record({ lower: fc.integer({ min: 0, max: 500_000 }), r1: pct, r2: pct, standardDeduction: fc.integer({ min: 0, max: 100_000 }), cessRate: fc.integer({ min: 0, max: 5 }) })
  .map(({ lower, r1, r2, standardDeduction, cessRate }) => ({
    slabs: [
      { upTo: lower, rate: 0 },
      { upTo: lower + 500_000, rate: r1 },
      { upTo: null, rate: Math.max(r1, r2) },
    ],
    standardDeduction,
    rebateLimit: 0,
    rebateMax: 0,
    cessRate,
  }));
const inputArb = fc
  .record({
    days: fc.integer({ min: 28, max: 31 }),
    halfDays: fc.integer({ min: 0, max: 62 }),
    basic: money,
    hraPct: fc.integer({ min: 0, max: 60 }),
    special: money,
    flat: fc.integer({ min: 0, max: 5000 }),
    canteen: fc.integer({ min: 0, max: 2000 }),
    pf: fc.record({ employeeRate: pct, employerRate: pct, epsRate: fc.constant(0), wageCeiling: money, ceilingOnEmployee: fc.boolean(), ceilingOnEmployer: fc.boolean() }),
    esi: fc.record({ employeeRate: pct, employerRate: pct, wageThreshold: money, rounding: fc.constantFrom('up' as const, 'nearest' as const) }),
    tds: tdsRule,
    bonus: fc.integer({ min: 0, max: 500_000 }),
  })
  .map((x): CalcInput => ({
    month: 6,
    daysInPeriod: x.days,
    paidDays: Math.min(x.halfDays / 2, x.days),
    components: COMPONENTS,
    amounts: { BASIC: x.basic, HRA: x.hraPct, SPECIAL: x.special, FLAT: x.flat, CANTEEN: x.canteen },
    adjustments: x.bonus ? [{ kind: 'earning', label: 'Bonus', amount: x.bonus, taxable: true }] : [],
    statutory: { pfExcluded: false, regime: 'new', ptState: null },
    rules: { pf: x.pf, esi: x.esi, tds: x.tds },
    expect: [],
  }));
const line = (r: { lines: { code: string; amount: number }[] }, code: string) => r.lines.find((l) => l.code === code)?.amount ?? 0;

describe('payroll calculation properties', () => {
  it('gross, deductions, net and employer cost always reconcile with the lines', () => {
    fc.assert(
      fc.property(inputArb, (i) => {
        const r = calculate(i);
        const sum = (k: string) =>
          r.lines
            .filter((l) => l.kind === k)
            .reduce((s, l) => s.plus(l.amount), new Decimal(0))
            .toNumber();
        expect(r.gross).toBe(sum('earning'));
        expect(r.deductions).toBe(sum('deduction'));
        expect(r.net).toBe(new Decimal(r.gross).minus(r.deductions).toNumber());
        expect(r.employerCost).toBe(new Decimal(r.gross).plus(sum('employer')).toNumber());
      }),
    );
  });

  it('is deterministic, and every line is a whole rupee', () => {
    fc.assert(
      fc.property(inputArb, (i) => {
        const r = calculate(i);
        expect(calculate(i)).toEqual(r);
        for (const l of r.lines) {
          expect(Number.isInteger(l.amount)).toBe(true);
          expect(l.amount).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  it('more paid days never lower gross', () => {
    fc.assert(
      fc.property(inputArb, fc.integer({ min: 0, max: 31 }), (i, extra) => {
        const more = Math.min(i.daysInPeriod, i.paidDays + extra);
        expect(calculate({ ...i, paidDays: more }).gross).toBeGreaterThanOrEqual(calculate(i).gross);
      }),
    );
  });

  it('a stretch split in two at the same rate is within a rupee per component of no split', () => {
    fc.assert(
      fc.property(inputArb, fc.integer({ min: 1, max: 27 }), (i, first) => {
        const whole = calculate({ ...i, paidDays: i.daysInPeriod });
        const split = calculate({
          ...i,
          paidDays: i.daysInPeriod,
          segments: [
            { amounts: i.amounts, paidDays: first, days: first },
            { amounts: i.amounts, paidDays: i.daysInPeriod - first, days: i.daysInPeriod - first },
          ],
        });
        for (const code of ['BASIC', 'SPECIAL', 'FLAT']) expect(Math.abs(line(whole, code) - line(split, code))).toBeLessThanOrEqual(1);
      }),
    );
  });

  it('ESI cover does not depend on paid days', () => {
    fc.assert(
      fc.property(inputArb, (i) => {
        // Enough wage and rate that half a month cannot round the contribution away to nothing.
        fc.pre(i.amounts.BASIC! >= 2000 && i.rules.esi!.employeeRate >= 1);
        const covered = (paidDays: number) => line(calculate({ ...i, paidDays }), 'ESI_EE') > 0;
        expect(covered(i.daysInPeriod)).toBe(covered(Math.ceil(i.daysInPeriod / 2)));
      }),
    );
  });

  it('TDS: a one-off never costs more than taxing it alone at the top rate; twelve regular months approach the annual tax', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500_000 }), fc.integer({ min: 0, max: 2_000_000 }), tdsRule, (basic, bonus, tds) => {
        const base: CalcInput = {
          month: 6,
          daysInPeriod: 30,
          paidDays: 30,
          components: [comp('BASIC', { esi_wage: false })],
          amounts: { BASIC: basic },
          adjustments: [],
          statutory: { pfExcluded: true, regime: 'new', ptState: null },
          rules: { tds },
          expect: [],
        };
        const plain = line(calculate(base), 'TDS');
        const withBonus = line(calculate({ ...base, adjustments: [{ kind: 'earning', label: 'Bonus', amount: bonus, taxable: true }] }), 'TDS');
        expect(withBonus).toBeGreaterThanOrEqual(plain);
        const topRate = Math.max(...tds.slabs.map((s) => s.rate));
        expect(withBonus - plain).toBeLessThanOrEqual(Math.ceil((bonus * topRate * (100 + tds.cessRate)) / 10000) + 1);
        const annual = progressiveTax(Decimal.max(0, new Decimal(basic).times(12).minus(tds.standardDeduction)), tds.slabs).times(1 + tds.cessRate / 100);
        expect(Math.abs(plain * 12 - annual.toNumber())).toBeLessThanOrEqual(6);
      }),
    );
  });

  it('progressive tax rises with income', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000_000 }), fc.integer({ min: 0, max: 1_000_000 }), tdsRule, (income, more, t) => {
        expect(progressiveTax(new Decimal(income + more), t.slabs).gte(progressiveTax(new Decimal(income), t.slabs))).toBe(true);
      }),
    );
  });

  it('paid days per stretch stay within each stretch and match the loss-of-pay total', () => {
    const stretch = fc
      .record({ days: fc.integer({ min: 1, max: 20 }), halves: fc.integer({ min: 0, max: 40 }) })
      .map((s) => ({ days: s.days, lop: Math.min(s.halves / 2, s.days) }));
    fc.assert(
      fc.property(fc.array(stretch, { minLength: 1, maxLength: 3 }), fc.integer({ min: -40, max: 40 }), (ss, adjHalves) => {
        const adj = adjHalves / 2;
        const paid = paidPerStretch(ss, adj);
        paid.forEach((p, x) => {
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThanOrEqual(ss[x]!.days);
        });
        const days = ss.reduce((t, s) => t + s.days, 0);
        const lop = ss.reduce((t, s) => t + s.lop, 0);
        const total = paid.reduce((t, p) => t + p, 0);
        expect(total).toBe(Math.min(days, Math.max(0, days - Math.max(0, lop + adj))));
      }),
    );
  });
});
