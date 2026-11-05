import { describe, it, expect } from 'vitest';
import { calculate, progressiveTax, type CalcInput, type Component } from '../src/modules/payroll/calc.js';
import { Decimal } from 'decimal.js';

// Parameters below are TEST FIXTURES chosen to exercise the arithmetic — not statutory values.
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
  comp('CANTEEN', { kind: 'deduction', prorate: false, position: 4 }),
];
const base = (o: Partial<CalcInput> = {}): CalcInput => ({
  month: 11,
  daysInPeriod: 30,
  paidDays: 30,
  components: COMPONENTS,
  amounts: { BASIC: 20000, HRA: 40, SPECIAL: 6000, CANTEEN: 500 },
  adjustments: [],
  statutory: { pfExcluded: false, regime: 'new', ptState: 'Maharashtra' },
  expect: ['pf', 'esi', 'pt', 'tds'],
  rules: {
    pf: { employeeRate: 10, employerRate: 10, epsRate: 5, wageCeiling: 15000, ceilingOnEmployee: true, ceilingOnEmployer: true },
    esi: { employeeRate: 1, employerRate: 3, wageThreshold: 25000, rounding: 'up' },
    pt: {
      slabs: [
        { upTo: 10000, amount: 0 },
        { upTo: null, amount: 200, monthAmounts: { '02': 300 } },
      ],
    },
    tds: {
      slabs: [
        { upTo: 300000, rate: 0 },
        { upTo: 600000, rate: 5 },
        { upTo: null, rate: 10 },
      ],
      standardDeduction: 50000,
      rebateLimit: 400000,
      rebateMax: 20000,
      cessRate: 4,
    },
  },
  ...o,
});
const line = (r: { lines: { code: string; amount: number }[] }, code: string) => r.lines.find((l) => l.code === code)?.amount;

describe('payroll calculation', () => {
  it('fixed and percent components, deductions, statutory with ceilings, employer cost', () => {
    const r = calculate(base());
    expect(line(r, 'BASIC')).toBe(20000);
    expect(line(r, 'HRA')).toBe(8000);
    expect(r.gross).toBe(34000);
    expect(line(r, 'PF_EE')).toBe(1500); // 10% of min(20000, 15000)
    expect(line(r, 'PF_EPS')).toBe(750); // 5% of 15000
    expect(line(r, 'PF_EPF_ER')).toBe(750); // employer 1500 − EPS 750
    expect(line(r, 'ESI_EE')).toBeUndefined(); // gross above the threshold
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
    expect(line(r, 'BASIC')).toBe(17000); // 20000 × 25.5/30
    expect(line(r, 'HRA')).toBe(6800); // 40% of prorated basic
    expect(line(r, 'SPECIAL')).toBe(5100);
    expect(line(r, 'CANTEEN')).toBe(500);
  });

  it('ESI applies under the threshold and rounds up; PT month override; TDS above the rebate', () => {
    const low = calculate(base({ amounts: { BASIC: 12000, SPECIAL: 3000 }, month: 2 }));
    expect(low.gross).toBe(15000);
    expect(line(low, 'ESI_EE')).toBe(150);
    expect(line(low, 'ESI_ER')).toBe(450);
    expect(line(low, 'PT')).toBe(300); // February amount
    const odd = calculate(base({ amounts: { BASIC: 12345 }, components: [comp('BASIC', { pf_wage: true })] }));
    expect(line(odd, 'ESI_EE')).toBe(124); // 123.45 → up
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
    const r = calculate(
      base({
        adjustments: [
          { kind: 'earning', label: 'Night shift allowance', amount: 1000, taxable: true },
          { kind: 'deduction', label: 'Notice recovery', amount: 40000, taxable: false },
        ],
      }),
    );
    expect(r.gross).toBe(35000);
    expect(r.net).toBeLessThan(0);
    expect(r.warnings.join()).toMatch(/negative/);
  });

  it('progressive tax across slabs', () => {
    const slabs = [
      { upTo: 100, rate: 0 },
      { upTo: 200, rate: 10 },
      { upTo: null, rate: 20 },
    ];
    expect(progressiveTax(new Decimal(50), slabs).toNumber()).toBe(0);
    expect(progressiveTax(new Decimal(150), slabs).toNumber()).toBe(5);
    expect(progressiveTax(new Decimal(300), slabs).toNumber()).toBe(30);
  });
});

describe('F-4 TDS on one-off earnings', () => {
  const tds = {
    slabs: [
      { upTo: 300000, rate: 0 },
      { upTo: 600000, rate: 5 },
      { upTo: null, rate: 10 },
    ],
    standardDeduction: 50000,
    rebateLimit: 0,
    rebateMax: 0,
    cessRate: 0,
  };
  const input = (adjustments: CalcInput['adjustments'], o: Partial<CalcInput> = {}) =>
    base({ amounts: { BASIC: 50000 }, components: [comp('BASIC', { esi_wage: false })], adjustments, rules: { tds }, expect: [], ...o });

  it('a one-off is taxed once on top of the annual salary, not annualized', () => {
    expect(line(calculate(input([])), 'TDS')).toBe(1042); // 550000 → 12500 / 12
    const r = calculate(input([{ kind: 'earning', label: 'Bonus', amount: 100000, taxable: true }]));
    // 12500/12 for the month, plus the whole tax the bonus adds to the year: tax(650000) 20000 − tax(550000) 12500.
    expect(line(r, 'TDS')).toBe(1042 + 7500);
  });

  it('a non-taxable one-off does not change TDS', () => {
    expect(line(calculate(input([{ kind: 'earning', label: 'Reimbursement', amount: 100000, taxable: false }])), 'TDS')).toBe(1042);
  });

  it('a one-off is taxed even when the salary alone owes nothing', () => {
    const r = calculate(input([{ kind: 'earning', label: 'Encashment', amount: 100000, taxable: true }], { amounts: { BASIC: 25000 } }));
    // salary 300000 − 50000 → 0 tax; with one-off 350000 → 2500, all in this month.
    expect(line(r, 'TDS')).toBe(2500);
  });
});

describe('F-5 ESI coverage', () => {
  const esi = { employeeRate: 1, employerRate: 3, wageThreshold: 21000, rounding: 'up' as const };
  const input = (o: Partial<CalcInput>) => base({ amounts: { BASIC: 30000 }, components: [comp('BASIC')], rules: { esi }, expect: [], ...o });

  it('is decided on the full monthly wage: proration never brings someone into cover', () => {
    expect(line(calculate(input({})), 'ESI_EE')).toBeUndefined();
    expect(line(calculate(input({ paidDays: 15 })), 'ESI_EE')).toBeUndefined();
  });

  it('a covered employee on prorated pay contributes on the wages actually paid', () => {
    expect(line(calculate(input({ amounts: { BASIC: 20000 }, paidDays: 15 })), 'ESI_EE')).toBe(100);
  });

  it('coverage follows the wage at the start of the contribution period', () => {
    expect(line(calculate(input({ amounts: { BASIC: 25000 }, esiCoverageAmounts: { BASIC: 20000 } })), 'ESI_EE')).toBe(250);
    expect(line(calculate(input({ amounts: { BASIC: 20000 }, esiCoverageAmounts: { BASIC: 25000 } })), 'ESI_EE')).toBeUndefined();
  });
});

describe('F-6 mid-month salary segments', () => {
  it('splits by calendar days, with lines summed per component', () => {
    const r = calculate(
      base({
        amounts: { BASIC: 30000 },
        components: [comp('BASIC', { esi_wage: false, taxable: false })],
        rules: {},
        expect: [],
        paidDays: 30,
        segments: [
          { amounts: { BASIC: 30000 }, paidDays: 19, days: 19 },
          { amounts: { BASIC: 60000 }, paidDays: 11, days: 11 },
        ],
      }),
    );
    expect(line(r, 'BASIC')).toBe(19000 + 22000);
    expect(r.gross).toBe(41000);
  });
  it('a percent component follows the segment it belongs to; a non-prorated one is shared by days', () => {
    const c = [comp('BASIC', { position: 1 }), comp('HRA', { calc: 'percent', base_codes: ['BASIC'], position: 2 }), comp('FLAT', { prorate: false, position: 3 })];
    const r = calculate(
      base({
        components: c,
        rules: {},
        expect: [],
        amounts: {},
        paidDays: 30,
        segments: [
          { amounts: { BASIC: 30000, HRA: 50, FLAT: 3000 }, paidDays: 15, days: 15 },
          { amounts: { BASIC: 30000, HRA: 40, FLAT: 6000 }, paidDays: 15, days: 15 },
        ],
      }),
    );
    expect(line(r, 'BASIC')).toBe(30000);
    expect(line(r, 'HRA')).toBe(7500 + 6000);
    expect(line(r, 'FLAT')).toBe(1500 + 3000);
  });
  it('a single segment gives the same result as no segments', () => {
    const plain = calculate(base({ paidDays: 25.5 }));
    const seg = calculate(base({ paidDays: 25.5, segments: [{ amounts: base().amounts, paidDays: 25.5, days: 30 }] }));
    expect(seg).toEqual(plain);
  });
});

describe('LWF with no pay', () => {
  it('is not charged when nothing was earned', () => {
    const lwf = { employee: 12, employer: 36, months: [11] };
    const none = calculate(base({ paidDays: 0, amounts: { BASIC: 20000 }, components: [comp('BASIC')], rules: { lwf }, expect: [] }));
    expect(none.lines.filter((l) => l.code.startsWith('LWF'))).toEqual([]);
    expect(none.net).toBe(0);
    expect(line(calculate(base({ amounts: { BASIC: 20000 }, components: [comp('BASIC')], rules: { lwf }, expect: [] })), 'LWF_EE')).toBe(12);
  });
});
