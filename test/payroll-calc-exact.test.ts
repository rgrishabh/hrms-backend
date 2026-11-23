import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { calculate, progressiveTax, RULE_PARAMS, type CalcInput, type Component, type Line } from '../src/modules/payroll/calc.js';

/**
 * The exact words and order of a payslip and the arithmetic at each boundary. Figures are fixtures, not statutory values. Written from the mutation report:
 * each test here fails if a filter, comparison or text in calc.ts changes.
 */
const comp = (code: string, o: Partial<Component> = {}): Component => ({
  code,
  name: `${code} name`,
  kind: 'earning',
  calc: 'fixed',
  base_codes: [],
  prorate: true,
  taxable: false,
  pf_wage: false,
  esi_wage: false,
  position: 0,
  ...o,
});
const input = (o: Partial<CalcInput> = {}): CalcInput => ({
  month: 4,
  daysInPeriod: 30,
  paidDays: 30,
  components: [comp('BASIC')],
  amounts: { BASIC: 10000 },
  adjustments: [],
  statutory: { pfExcluded: false, regime: 'new', ptState: 'Goa' },
  expect: [],
  rules: {},
  ...o,
});
const line = (ls: Line[], code: string) => ls.find((l) => l.code === code);
const TDS = {
  slabs: [
    { upTo: 100000, rate: 0 },
    { upTo: null, rate: 10 },
  ],
  standardDeduction: 0,
  rebateLimit: 0,
  rebateMax: 0,
  cessRate: 0,
};

describe('statutory lines, word for word', () => {
  it('provident fund', () => {
    const r = calculate(
      input({
        components: [comp('BASIC', { pf_wage: true })],
        rules: { pf: { employeeRate: 12, employerRate: 12, epsRate: 8, wageCeiling: 100000, ceilingOnEmployee: false, ceilingOnEmployer: false } },
      }),
    );
    expect(r.lines.slice(1)).toEqual([
      { code: 'PF_EE', name: 'Provident fund (employee)', kind: 'deduction', amount: 1200, basis: 'PF wages 10000' },
      { code: 'PF_EPS', name: 'Pension (EPS, employer)', kind: 'employer', amount: 800 },
      { code: 'PF_EPF_ER', name: 'Provident fund (employer)', kind: 'employer', amount: 400 },
    ]);
  });
  it('no PF wage, no PF lines', () => {
    const r = calculate(input({ rules: { pf: { employeeRate: 12, employerRate: 12, epsRate: 8, wageCeiling: 100000, ceilingOnEmployee: false, ceilingOnEmployer: false } } }));
    expect(r.lines.map((l) => l.code)).toEqual(['BASIC']);
  });
  it('ESI rounds up or to nearest as the rule says, on the wages flagged for it', () => {
    const c = [comp('BASIC', { esi_wage: true }), comp('PERK', { esi_wage: false })];
    const up = calculate(
      input({ components: c, amounts: { BASIC: 16001, PERK: 20000 }, rules: { esi: { employeeRate: 1, employerRate: 3, wageThreshold: 20000, rounding: 'up' } } }),
    );
    expect(up.lines.slice(2)).toEqual([
      { code: 'ESI_EE', name: 'ESI (employee)', kind: 'deduction', amount: 161, basis: 'ESI wages 16001' },
      { code: 'ESI_ER', name: 'ESI (employer)', kind: 'employer', amount: 481 },
    ]);
    const nearest = calculate(
      input({ components: c, amounts: { BASIC: 16001, PERK: 20000 }, rules: { esi: { employeeRate: 1, employerRate: 3, wageThreshold: 20000, rounding: 'nearest' } } }),
    );
    expect(line(nearest.lines, 'ESI_EE')!.amount).toBe(160);
    expect(line(nearest.lines, 'ESI_ER')!.amount).toBe(480);
  });
  it('cover is decided on full-month earnings flagged for ESI: not on a deduction, and not on an earning without the flag', () => {
    const rules = { esi: { employeeRate: 1, employerRate: 3, wageThreshold: 20000, rounding: 'up' as const } };
    const withDeduction = calculate(
      input({ components: [comp('BASIC', { esi_wage: true }), comp('LOAN', { kind: 'deduction', esi_wage: true })], amounts: { BASIC: 16000, LOAN: 15000 }, rules }),
    );
    expect(line(withDeduction.lines, 'ESI_EE')).toBeDefined();
    const unflagged = calculate(input({ components: [comp('BASIC', { esi_wage: true }), comp('PERK')], amounts: { BASIC: 16000, PERK: 15000 }, rules }));
    expect(line(unflagged.lines, 'ESI_EE')).toBeDefined();
    const over = calculate(input({ components: [comp('BASIC', { esi_wage: true })], amounts: { BASIC: 20001 }, rules }));
    expect(line(over.lines, 'ESI_EE')).toBeUndefined();
  });
  it('an adjustment counts toward ESI only when flagged', () => {
    const rules = { esi: { employeeRate: 1, employerRate: 3, wageThreshold: 20000, rounding: 'up' as const } };
    const adj = (esiWage?: boolean) => ({ kind: 'earning' as const, label: 'OT', amount: 1000.4, taxable: false, esiWage });
    const flagged = calculate(input({ components: [comp('BASIC', { esi_wage: true })], amounts: { BASIC: 10000 }, adjustments: [adj(true), adj(false)], rules }));
    expect(line(flagged.lines, 'ESI_EE')).toMatchObject({ basis: 'ESI wages 11000', amount: 110 });
  });
  it('professional tax: the state is named, a month may differ, a slab of zero prints nothing', () => {
    const pt = {
      slabs: [
        { upTo: 5000, amount: 0 },
        { upTo: null, amount: 200, monthAmounts: { '02': 300 } },
      ],
    };
    expect(line(calculate(input({ rules: { pt } })).lines, 'PT')).toEqual({ code: 'PT', name: 'Professional tax (Goa)', kind: 'deduction', amount: 200 });
    expect(line(calculate(input({ month: 2, rules: { pt } })).lines, 'PT')!.amount).toBe(300);
    expect(line(calculate(input({ amounts: { BASIC: 5000 }, rules: { pt } })).lines, 'PT')).toBeUndefined();
    expect(line(calculate(input({ rules: { pt: { slabs: [{ upTo: null, amount: 150 }] } } })).lines, 'PT')!.amount).toBe(150);
    expect(line(calculate(input({ rules: { pt: { slabs: [{ upTo: 100, amount: 150 }] } } })).lines, 'PT')).toBeUndefined();
  });
  it('labour welfare fund: each side only when it is above zero, and the employer side reaches employer cost', () => {
    const both = calculate(input({ rules: { lwf: { employee: 12, employer: 36, months: [4] } } }));
    expect(both.lines.slice(1)).toEqual([
      { code: 'LWF_EE', name: 'Labour welfare fund (employee)', kind: 'deduction', amount: 12 },
      { code: 'LWF_ER', name: 'Labour welfare fund (employer)', kind: 'employer', amount: 36 },
    ]);
    expect(both.employerCost).toBe(10036);
    expect(calculate(input({ rules: { lwf: { employee: 0, employer: 36, months: [4] } } })).lines.map((l) => l.code)).toEqual(['BASIC', 'LWF_ER']);
    expect(calculate(input({ rules: { lwf: { employee: 12, employer: 0, months: [4] } } })).lines.map((l) => l.code)).toEqual(['BASIC', 'LWF_EE']);
    expect(calculate(input({ rules: { lwf: { employee: 12, employer: 36, months: [5] } } })).lines.map((l) => l.code)).toEqual(['BASIC']);
  });
  it('income tax: projected over the year, spread over twelve', () => {
    const r = calculate(input({ components: [comp('BASIC', { taxable: true }), comp('PERK')], amounts: { BASIC: 20000, PERK: 5000 }, rules: { tds: TDS } }));
    expect(line(r.lines, 'TDS')).toEqual({ code: 'TDS', name: 'Income tax (TDS)', kind: 'deduction', amount: 1167, basis: 'projected taxable 240000' });
    expect(line(calculate(input({ components: [comp('BASIC', { taxable: true })], amounts: { BASIC: 1000 }, rules: { tds: TDS } })).lines, 'TDS')).toBeUndefined();
  });
  it('the rebate takes off what it may, at the limit and not beyond it, and never goes below zero', () => {
    const t = (rebateLimit: number, rebateMax: number) => ({ ...TDS, rebateLimit, rebateMax });
    const salary = { components: [comp('BASIC', { taxable: true })], amounts: { BASIC: 20000 } };
    expect(line(calculate(input({ ...salary, rules: { tds: t(240000, 2000) } })).lines, 'TDS')!.amount).toBe(1000);
    expect(line(calculate(input({ ...salary, rules: { tds: t(239999, 2000) } })).lines, 'TDS')!.amount).toBe(1167);
    expect(line(calculate(input({ ...salary, rules: { tds: t(240000, 99999) } })).lines, 'TDS')).toBeUndefined();
    expect(calculate(input({ ...salary, rules: { tds: t(240000, 99999) } })).deductions).toBe(0);
  });
});

describe('a rule that is missing is said, in these words, and only where expected', () => {
  const none = { pfExcluded: false, regime: 'old' as const, ptState: null };
  it('each kind', () => {
    const r = calculate(input({ statutory: { ...none, ptState: 'Goa' }, expect: ['pf', 'esi', 'pt', 'tds'] }));
    expect(r.warnings).toEqual([
      'PF: no active, verified PF rule for this period — not deducted',
      'ESI: no active, verified ESI rule for this period — not deducted',
      'PT (Goa): no active, verified PT rule for this period — not deducted',
      'TDS (old regime): no active, verified TDS rule for this period — not deducted',
    ]);
  });
  it('nothing when the deployment does not expect them', () => {
    expect(calculate(input({ statutory: { ...none, ptState: 'Goa' } })).warnings).toEqual([]);
    expect(calculate(input({ statutory: none })).warnings).toEqual([]);
  });
  it('no state: said only when PT is expected', () => {
    expect(calculate(input({ statutory: none, expect: ['pt'] })).warnings).toEqual(['PT: no state for this employee']);
  });
  it('PF excluded: no warning even when the rule is missing', () => {
    expect(calculate(input({ statutory: { ...none, pfExcluded: true }, expect: ['pf'] })).warnings).toEqual([]);
  });
  it('a percent of a base the salary lacks: named once, however many stretches', () => {
    const components = [comp('BASIC'), comp('HRA', { calc: 'percent', base_codes: ['BASIC', 'DA', 'TA'] })];
    const seg = { amounts: { BASIC: 1000, HRA: 10 }, paidDays: 15, days: 15 };
    const r = calculate(input({ components, amounts: seg.amounts, segments: [seg, { ...seg, from: '2026-04-16' }] }));
    expect(r.warnings).toEqual(['HRA: base DA, TA not in this salary']);
  });
});

describe('order and arithmetic of the salary lines', () => {
  it('fixed before percent, each by position, wherever they were given; a percent reads its base', () => {
    const components = [
      comp('HRA', { calc: 'percent', base_codes: ['BASIC'], position: 1 }),
      comp('DA', { calc: 'percent', base_codes: ['BASIC'], position: 0 }),
      comp('SPECIAL', { position: 9 }),
      comp('BASIC', { position: 2 }),
    ];
    const given = [...components];
    const r = calculate(input({ components, amounts: { BASIC: 1000, SPECIAL: 500, HRA: 10, DA: 20 } }));
    expect(r.lines.map((l) => [l.code, l.amount])).toEqual([
      ['BASIC', 1000],
      ['SPECIAL', 500],
      ['DA', 200],
      ['HRA', 100],
    ]);
    expect(components).toEqual(given);
    expect(r.lines[0]).toEqual({ code: 'BASIC', name: 'BASIC name', kind: 'earning', amount: 1000 });
  });
  it('a period with no days pays nothing that prorates', () => {
    expect(calculate(input({ daysInPeriod: 0, paidDays: 0 })).gross).toBe(0);
    expect(calculate(input({ daysInPeriod: 0, paidDays: 5 })).gross).toBe(0);
  });
  it('a change within the month names the dates after the first stretch, skips one with none, and splits by days', () => {
    const a = { amounts: { BASIC: 3000 }, paidDays: 10, days: 10, from: '2026-04-01' };
    const r = calculate(input({ segments: [a, { amounts: { BASIC: 6000 }, paidDays: 10, days: 10 }, { amounts: { BASIC: 9000 }, paidDays: 10, days: 10, from: '2026-04-21' }] }));
    expect(r.lines[0]).toEqual({ code: 'BASIC', name: 'BASIC name', kind: 'earning', amount: 6000, basis: 'Salary changed on 2026-04-21, split by days' });
    const two = calculate(input({ segments: [a, { ...a, from: '2026-04-11' }, { ...a, from: '2026-04-21' }] }));
    expect(two.lines[0]!.basis).toBe('Salary changed on 2026-04-11, 2026-04-21, split by days');
  });
  it('adjustments are numbered by their place, keep a code and basis they were given, and round half up', () => {
    const r = calculate(
      input({
        adjustments: [
          { kind: 'earning', label: 'First', amount: 10.5, taxable: false },
          { kind: 'deduction', label: 'Second', amount: 3, taxable: false },
          { kind: 'earning', label: 'Overtime', amount: 7, taxable: false, code: 'OT', basis: '2 hours' },
        ],
      }),
    );
    expect(r.lines.slice(1)).toEqual([
      { code: 'ADJ1', name: 'First', kind: 'earning', amount: 11 },
      { code: 'ADJ2', name: 'Second', kind: 'deduction', amount: 3 },
      { code: 'OT', name: 'Overtime', kind: 'earning', amount: 7, basis: '2 hours' },
    ]);
    expect(r.gross).toBe(10018);
    expect(r.deductions).toBe(3);
  });
});

describe('a run paying only one-offs because another run holds the salary', () => {
  const components = [comp('BASIC', { taxable: true }), comp('PERK'), comp('LOAN', { kind: 'deduction', taxable: true })];
  const amounts = { BASIC: 20000, PERK: 7000, LOAN: 9000 };
  it('prints no salary, PT or LWF; tax is only the extra the one-off causes, on the taxable earnings of the full month', () => {
    const r = calculate(
      input({
        components,
        amounts,
        supplementary: true,
        adjustments: [{ kind: 'earning', label: 'Bonus', amount: 12000, taxable: true }],
        rules: { tds: TDS, pt: { slabs: [{ upTo: null, amount: 200 }] }, lwf: { employee: 10, employer: 10, months: [4] } },
      }),
    );
    expect(r.lines).toEqual([
      { code: 'ADJ1', name: 'Bonus', kind: 'earning', amount: 12000 },
      { code: 'TDS', name: 'Income tax (TDS)', kind: 'deduction', amount: 1200, basis: 'projected taxable 252000' },
    ]);
  });
  it('warns of no missing PT or salary base', () => {
    const r = calculate(input({ components, amounts: {}, supplementary: true, expect: ['pt'], statutory: { pfExcluded: false, regime: 'new', ptState: 'Goa' } }));
    expect(r.warnings).toEqual([]);
    expect(r.lines).toEqual([]);
  });
});

describe('progressive tax', () => {
  it('stops at the slab the income falls in, and nothing below the first bound is taxed at the next rate', () => {
    const slabs = [
      { upTo: 100, rate: 10 },
      { upTo: 200, rate: 20 },
      { upTo: null, rate: 30 },
    ];
    expect(progressiveTax(new Decimal(100), slabs).toNumber()).toBe(10);
    expect(progressiveTax(new Decimal(150), slabs).toNumber()).toBe(20);
    expect(progressiveTax(new Decimal(250), slabs).toNumber()).toBe(45);
  });
});

describe('rule parameters', () => {
  const pf = { employeeRate: 12, employerRate: 12, epsRate: 8, wageCeiling: 15000, ceilingOnEmployee: true, ceilingOnEmployer: true };
  it('a percentage is 0 to 100, and an amount 0 to a billion', () => {
    expect(RULE_PARAMS.pf.safeParse(pf).success).toBe(true);
    expect(RULE_PARAMS.pf.safeParse({ ...pf, employeeRate: 100 }).success).toBe(true);
    expect(RULE_PARAMS.pf.safeParse({ ...pf, employeeRate: 0 }).success).toBe(true);
    expect(RULE_PARAMS.pf.safeParse({ ...pf, employeeRate: 100.01 }).success).toBe(false);
    expect(RULE_PARAMS.pf.safeParse({ ...pf, employeeRate: -1 }).success).toBe(false);
    expect(RULE_PARAMS.pf.safeParse({ ...pf, wageCeiling: 1e9 }).success).toBe(true);
    expect(RULE_PARAMS.pf.safeParse({ ...pf, wageCeiling: 1e9 + 1 }).success).toBe(false);
    expect(RULE_PARAMS.pf.safeParse({ ...pf, wageCeiling: -1 }).success).toBe(false);
  });
});
