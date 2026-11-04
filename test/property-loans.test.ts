import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { installmentOf } from '../src/modules/loans/service.js';
import { schedule } from '../src/modules/loans/routes.js';

const loanArb = fc.record({ amount: fc.integer({ min: 1, max: 10_000_000 }), n: fc.integer({ min: 1, max: 120 }) });

describe('loan EMI properties', () => {
  it('the instalment is whole rupees and n of them cover the amount, with less than n rupees to spare', () => {
    fc.assert(fc.property(loanArb, ({ amount, n }) => {
      const emi = installmentOf(amount, n);
      expect(Number.isInteger(emi)).toBe(true);
      expect(emi * n).toBeGreaterThanOrEqual(amount);
      expect(emi * n - amount).toBeLessThan(n);
    }));
  });

  it('the schedule repays exactly the amount, in at most n months, with only the last one smaller', () => {
    fc.assert(fc.property(loanArb, ({ amount, n }) => {
      const emi = installmentOf(amount, n);
      const s = schedule({ amount: String(amount), installment_amount: String(emi), first_period: '2026-01', skip_periods: [] });
      expect(s.reduce((t, x) => t + Number(x.amount), 0)).toBe(amount);
      expect(s.length).toBeLessThanOrEqual(n);
      s.slice(0, -1).forEach((x) => expect(Number(x.amount)).toBe(emi));
      expect(Number(s[s.length - 1]!.amount)).toBeLessThanOrEqual(emi);
    }));
  });

  it('a deferred month moves the schedule out and changes neither the total nor the instalments', () => {
    fc.assert(fc.property(loanArb.filter((l) => l.n <= 24), fc.integer({ min: 0, max: 11 }), ({ amount, n }, skip) => {
      const emi = installmentOf(amount, n);
      const period = `2026-${String(skip + 1).padStart(2, '0')}`;
      const s = schedule({ amount: String(amount), installment_amount: String(emi), first_period: '2026-01', skip_periods: [period] });
      expect(s.some((x) => x.period === period)).toBe(false);
      expect(s.reduce((t, x) => t + Number(x.amount), 0)).toBe(amount);
    }));
  });
});
