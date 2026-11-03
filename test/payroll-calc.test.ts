import { describe, it, expect } from 'vitest';
import { calculate, progressiveTax, type CalcInput, type Component } from '../src/modules/payroll/calc.js';
import { Decimal } from 'decimal.js';

// Parameters below are TEST FIXTURES chosen to exercise the arithmetic — not statutory values.
const comp = (code: string, o: Partial<Component> = {}): Component => ({ code, name: code, kind: 'earning', calc: 'fixed', base_codes: [], prorate: true, taxable: true, pf_wage: false, esi_wage: true, position: 0, ...o });
const COMPONENTS = [comp('BASIC', { pf_wage: true, position: 1 }), comp('HRA', { calc: 'percent', base_codes: ['BASIC'], position: 2 }), comp('SPECIAL', { position: 3 }), comp('CANTEEN', { kind: 'deduction', prorate: false, position: 4 })];
const base = (o: Partial<CalcInput> = {}): CalcInput => ({
  month: 11, daysInPeriod: 30, paidDays: 30, components: COMPONENTS, amounts: { BASIC: 20000, HRA: 40, SPECIAL: 6000, CANTEEN: 500 }, adjustments: [],
  statutory: { pfExcluded: false, regime: 'new', ptState: 'Maharashtra' }, expect: ['pf', 'esi', 'pt', 'tds'],
  rules: {
    pf: { employeeRate: 10, employerRate: 10, epsRate: 5, wageCeiling: 15000, ceilingOnEmployee: true, ceilingOnEmployer: true },
    esi: { employeeRate: 1, employerRate: 3, wageThreshold: 25000, rounding: 'up' },
    pt: { slabs: [{ upTo: 10000, amount: 0 }, { upTo: null, amount: 200, monthAmounts: { '02': 300 } }] },
    tds: { slabs: [{ upTo: 300000, rate: 0 }, { upTo: 600000, rate: 5 }, { upTo: null, rate: 10 }], standardDeduction: 50000, rebateLimit: 400000, rebateMax: 20000, cessRate: 4 },
  }, ...o,
});
const line = (r: { lines: { code: string; amount: number }[] }, code: string) => r.lines.find((l) => l.code === code)?.amount;

describe('payroll calculation', () => {
  it('fixed and percent components, deductions, statutory with ceilings, employer cost', () => {
    const r = calculate(base());
    expect(line(r, 'BASIC')).toBe(20000);
    expect(line(r, 'HRA')).toBe(8000);
    expect(r.gross).toBe(34000);
    expect(line(r, 'PF_EE')).toBe(1500);          // 10% of min(20000, 15000)
    expect(line(r, 'PF_EPS')).toBe(750);          // 5% of 15000
    expect(line(r, 'PF_EPF_ER')).toBe(750);       // employer 1500 − EPS 750
    expect(line(r, 'ESI_EE')).toBeUndefined();    // gross above the threshold
    expect(line(r, 'PT')).toBe(200);
    // TDS: annual taxable 34000×12 − 50000 = 358000 → 5% of 58000 = 2900; ≤ rebate limit → rebate → 0
    expect(line(r, 'TDS')).toBeUndefined();
    expect(r.deductions).toBe(500 + 1500 + 200);
    expect(r.net).toBe(34000 - 2200);
    expect(r.employerCost).toBe(34000 + 1500);
    expect(r.warnings).toEqual([]);
  });

  it('prorates by paid days with half-up rounding; non-prorated items stay whole', () => {
    const r = calculate(base({ paidDays: 25.5 }));
    expect(line(r, 'BASIC')).toBe(17000);         // 20000 × 25.5/30
    expect(line(r, 'HRA')).toBe(6800);            // 40% of prorated basic
    expect(line(r, 'SPECIAL')).toBe(5100);
    expect(line(r, 'CANTEEN')).toBe(500);
  });

  it('ESI applies under the threshold and rounds up; PT month override; TDS above the rebate', () => {
    const low = calculate(base({ amounts: { BASIC: 12000, SPECIAL: 3000 }, month: 2 }));
    expect(low.gross).toBe(15000);
    expect(line(low, 'ESI_EE')).toBe(150);
    expect(line(low, 'ESI_ER')).toBe(450);
    expect(line(low, 'PT')).toBe(300);            // February amount
    const odd = calculate(base({ amounts: { BASIC: 12345 }, components: [comp('BASIC', { pf_wage: true })] }));
    expect(line(odd, 'ESI_EE')).toBe(124);        // 123.45 → up
    const high = calculate(base({ amounts: { BASIC: 60000, SPECIAL: 20000 } }));
    // annual 80000×12 − 50000 = 910000 → 0 + 15000 + 31000 = 46000 × 1.04 = 47840 / 12 = 3986.67 → 3987
    expect(line(high, 'TDS')).toBe(3987);
  });

  it('never guesses a missing rule: warns instead; excluded employees get no PF', () => {
    const r = calculate(base({ rules: {} }));
    expect(r.lines.some((l) => ['PF_EE', 'ESI_EE', 'PT', 'TDS'].includes(l.code))).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/PF.*not deducted/);
    expect(r.warnings.join(' ')).toMatch(/TDS \(new regime\)/);
    expect(calculate(base({ statutory: { pfExcluded: true, regime: 'new', ptState: 'Maharashtra' } })).lines.some((l) => l.code === 'PF_EE')).toBe(false);
    expect(calculate(base({ statutory: { pfExcluded: false, regime: 'new', ptState: null } })).warnings).toContain('PT: no state for this employee');
  });

  it('adjustments and negative net', () => {
    const r = calculate(base({ adjustments: [{ kind: 'earning', label: 'Night shift allowance', amount: 1000, taxable: true }, { kind: 'deduction', label: 'Notice recovery', amount: 40000, taxable: false }] }));
    expect(r.gross).toBe(35000);
    expect(r.net).toBeLessThan(0);
    expect(r.warnings.join()).toMatch(/negative/);
  });

  it('progressive tax across slabs', () => {
    const slabs = [{ upTo: 100, rate: 0 }, { upTo: 200, rate: 10 }, { upTo: null, rate: 20 }];
    expect(progressiveTax(new Decimal(50), slabs).toNumber()).toBe(0);
    expect(progressiveTax(new Decimal(150), slabs).toNumber()).toBe(5);
    expect(progressiveTax(new Decimal(300), slabs).toNumber()).toBe(30);
  });
});
