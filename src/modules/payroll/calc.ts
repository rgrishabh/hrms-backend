import { Decimal } from 'decimal.js';
import { z } from 'zod';

/**
 * Pure payroll calculation for one employee and one period. No I/O, decimal arithmetic only.
 * Statutory amounts come exclusively from rules the organization entered and verified; when a rule
 * is missing the deduction is NOT guessed — a warning is raised instead.
 * CALC_VERSION changes whenever results for the same inputs would change.
 */
export const CALC_VERSION = 4;

const pct = z.number().min(0).max(100);
const money = z.number().min(0).max(1e9);
export const RULE_PARAMS = {
  pf: z.object({ employeeRate: pct, employerRate: pct, epsRate: pct, wageCeiling: money, ceilingOnEmployee: z.boolean(), ceilingOnEmployer: z.boolean() })
    .refine((p) => p.epsRate <= p.employerRate, { message: 'EPS share cannot exceed the employer rate' }),
  esi: z.object({ employeeRate: pct, employerRate: pct, wageThreshold: money, rounding: z.enum(['up', 'nearest']) }),
  pt: z.object({ slabs: z.array(z.object({ upTo: money.nullable(), amount: money, monthAmounts: z.record(z.string().regex(/^(0[1-9]|1[0-2])$/), money).optional() })).min(1) }),
  lwf: z.object({ employee: money, employer: money, months: z.array(z.number().int().min(1).max(12)).min(1) }),
  tds: z.object({ slabs: z.array(z.object({ upTo: money.nullable(), rate: pct })).min(1), standardDeduction: money, rebateLimit: money, rebateMax: money, cessRate: pct }),
} as const;
export type RuleKind = keyof typeof RULE_PARAMS;
export type PfParams = z.infer<typeof RULE_PARAMS.pf>; export type EsiParams = z.infer<typeof RULE_PARAMS.esi>;
export type PtParams = z.infer<typeof RULE_PARAMS.pt>; export type LwfParams = z.infer<typeof RULE_PARAMS.lwf>; export type TdsParams = z.infer<typeof RULE_PARAMS.tds>;

export interface Component { code: string; name: string; kind: 'earning' | 'deduction'; calc: 'fixed' | 'percent'; base_codes: string[]; prorate: boolean; taxable: boolean; pf_wage: boolean; esi_wage: boolean; position: number }
export interface Adjustment {
  kind: 'earning' | 'deduction'; label: string; amount: number; taxable: boolean;
  /** Line code (default ADJn) and basis text, e.g. overtime 'OT'. */
  code?: string; basis?: string;
  /** Counts toward ESI contribution wages (not toward the coverage threshold), e.g. overtime where the organization says so. */
  esiWage?: boolean;
}
export interface Line { code: string; name: string; kind: 'earning' | 'deduction' | 'employer'; amount: number; basis?: string }
export interface SalarySegment { amounts: Record<string, number>; paidDays: number; days: number; from?: string }
export interface CalcInput {
  month: number;                         // 1..12
  daysInPeriod: number; paidDays: number; // proration = paidDays / daysInPeriod
  components: Component[];
  amounts: Record<string, number>;       // monthly amounts (fixed) or percents
  adjustments: Adjustment[];
  statutory: { pfExcluded: boolean; regime: 'new' | 'old'; ptState: string | null };
  rules: { pf?: PfParams; esi?: EsiParams; pt?: PtParams; lwf?: LwfParams; tds?: TdsParams };
  /**
   * A salary change within the period: each stretch at its own rate, by calendar days. `paidDays` is that stretch's share
   * of the period's paid days and `days` its length. Without it, `amounts` and `paidDays` apply to the whole period.
   */
  segments?: SalarySegment[];
  /** Salary at the start of the ESI contribution period, which decides cover for the whole period. Default: `amounts`. */
  esiCoverageAmounts?: Record<string, number>;
  /** Which kinds the deployment expects (warn when the rule is missing). */
  expect: RuleKind[];
}
export interface CalcResult { lines: Line[]; gross: number; deductions: number; net: number; employerCost: number; warnings: string[] }

const r0 = (d: Decimal) => d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
const up0 = (d: Decimal) => d.toDecimalPlaces(0, Decimal.ROUND_UP);
const n = (d: Decimal) => d.toNumber();

export function progressiveTax(income: Decimal, slabs: { upTo: number | null; rate: number }[]) {
  let tax = new Decimal(0); let lower = new Decimal(0);
  for (const s of slabs) {
    const upper = s.upTo == null ? income : Decimal.min(income, s.upTo);
    if (upper.gt(lower)) tax = tax.plus(upper.minus(lower).times(s.rate).div(100));
    if (s.upTo == null || income.lte(s.upTo)) break;
    lower = new Decimal(s.upTo);
  }
  return tax;
}

/**
 * Each component's amount for a salary: fixed components scaled by `factor` where they prorate, and by `share` (this
 * salary's part of the period when it changed mid-way) where they do not; percents follow their base.
 */
function componentAmounts(comps: Component[], amounts: Record<string, number>, factor: Decimal, warnings: string[] = [], share = new Decimal(1)) {
  const amount = new Map<string, Decimal>();
  for (const c of comps) {
    const v = amounts[c.code];
    if (v == null) continue;
    let a: Decimal;
    if (c.calc === 'fixed') a = new Decimal(v).times(c.prorate ? factor : share);
    else {
      const missing = c.base_codes.filter((b) => !amount.has(b));
      if (missing.length) warnings.push(`${c.code}: base ${missing.join(', ')} not in this salary`);
      a = c.base_codes.reduce((s, b) => s.plus(amount.get(b) ?? 0), new Decimal(0)).times(v).div(100);
    }
    amount.set(c.code, r0(a));
  }
  return amount;
}

/** Full-month ESI wages of a salary: what cover is judged on. */
function esiFullWage(comps: Component[], amounts: Record<string, number>) {
  const full = componentAmounts(comps, amounts, new Decimal(1));
  return comps.filter((c) => c.kind === 'earning' && c.esi_wage).reduce((s, c) => s.plus(full.get(c.code) ?? 0), new Decimal(0));
}

/** The year's tax on an annual taxable income: slabs, rebate at or under the limit, then cess. */
function annualTax(income: Decimal, t: TdsParams) {
  const taxable = Decimal.max(0, income.minus(t.standardDeduction));
  let tax = progressiveTax(taxable, t.slabs);
  if (taxable.lte(t.rebateLimit)) tax = Decimal.max(0, tax.minus(t.rebateMax));
  return { taxable, tax: tax.times(new Decimal(1).plus(new Decimal(t.cessRate).div(100))) };
}

export function calculate(i: CalcInput): CalcResult {
  const warnings: string[] = [];
  const comps = [...i.components].sort((a, b) => (a.calc === b.calc ? a.position - b.position : a.calc === 'fixed' ? -1 : 1));
  const segments = i.segments ?? [{ amounts: i.amounts, paidDays: i.paidDays, days: 1 }];
  const totalDays = segments.reduce((t, s) => t + s.days, 0);
  const amount = new Map<string, Decimal>();
  for (const seg of segments) {
    const factor = i.daysInPeriod > 0 ? new Decimal(seg.paidDays).div(i.daysInPeriod) : new Decimal(0);
    const segWarnings: string[] = [];
    for (const [code, a] of componentAmounts(comps, seg.amounts, factor, segWarnings, new Decimal(seg.days).div(totalDays))) amount.set(code, (amount.get(code) ?? new Decimal(0)).plus(a));
    for (const w of segWarnings) if (!warnings.includes(w)) warnings.push(w);
  }
  const changedOn = segments.slice(1).map((s) => s.from).filter(Boolean).join(', ');
  const lines: Line[] = [];
  for (const c of comps) { const a = amount.get(c.code); if (a) lines.push({ code: c.code, name: c.name, kind: c.kind, amount: n(a), ...(changedOn ? { basis: `Salary changed on ${changedOn}, split by days` } : {}) }); }
  for (const [idx, a] of i.adjustments.entries()) lines.push({ code: a.code ?? `ADJ${idx + 1}`, name: a.label, kind: a.kind, amount: n(r0(new Decimal(a.amount))), ...(a.basis ? { basis: a.basis } : {}) });

  const sum = (pred: (c: Component) => boolean) => comps.filter((c) => c.kind === 'earning' && pred(c)).reduce((s, c) => s.plus(amount.get(c.code) ?? 0), new Decimal(0));
  const adjEarnings = i.adjustments.filter((a) => a.kind === 'earning');
  const gross = sum(() => true).plus(adjEarnings.reduce((s, a) => s.plus(r0(new Decimal(a.amount))), new Decimal(0)));
  const taxableMonthly = sum((c) => c.taxable);
  const taxableOneOff = adjEarnings.filter((a) => a.taxable).reduce((s, a) => s.plus(r0(new Decimal(a.amount))), new Decimal(0));
  const pfWage = sum((c) => c.pf_wage);
  const esiWage = sum((c) => c.esi_wage);
  // Contributions apply to the ESI wages paid and to earnings flagged esiWage (overtime). Cover is decided on the full
  // monthly wage at the start of the contribution period, never on prorated pay (DECISIONS.md D25).
  const esiContribution = esiWage.plus(adjEarnings.filter((a) => a.esiWage).reduce((s, a) => s.plus(r0(new Decimal(a.amount))), new Decimal(0)));
  const missingRule = (k: RuleKind, what: string) => { if (i.expect.includes(k)) warnings.push(`${what}: no active, verified ${k.toUpperCase()} rule for this period — not deducted`); };

  // PF
  if (i.statutory.pfExcluded) { /* not covered */ }
  else if (!i.rules.pf) missingRule('pf', 'PF');
  else if (pfWage.gt(0)) {
    const p = i.rules.pf;
    const capped = Decimal.min(pfWage, p.wageCeiling);
    const ee = r0((p.ceilingOnEmployee ? capped : pfWage).times(p.employeeRate).div(100));
    const erBase = p.ceilingOnEmployer ? capped : pfWage;
    const erTotal = r0(erBase.times(p.employerRate).div(100));
    const eps = r0(capped.times(p.epsRate).div(100));
    lines.push({ code: 'PF_EE', name: 'Provident fund (employee)', kind: 'deduction', amount: n(ee), basis: `PF wages ${n(pfWage)}` });
    lines.push({ code: 'PF_EPS', name: 'Pension (EPS, employer)', kind: 'employer', amount: n(Decimal.min(eps, erTotal)) });
    lines.push({ code: 'PF_EPF_ER', name: 'Provident fund (employer)', kind: 'employer', amount: n(Decimal.max(0, erTotal.minus(eps))) });
  }
  // ESI
  if (!i.rules.esi) missingRule('esi', 'ESI');
  else if (esiWage.gt(0) && esiFullWage(comps, i.esiCoverageAmounts ?? segments[segments.length - 1]!.amounts).lte(i.rules.esi.wageThreshold)) {
    const e = i.rules.esi; const rnd = e.rounding === 'up' ? up0 : r0;
    lines.push({ code: 'ESI_EE', name: 'ESI (employee)', kind: 'deduction', amount: n(rnd(esiContribution.times(e.employeeRate).div(100))), basis: `ESI wages ${n(esiContribution)}` });
    lines.push({ code: 'ESI_ER', name: 'ESI (employer)', kind: 'employer', amount: n(rnd(esiContribution.times(e.employerRate).div(100))) });
  }
  // Professional tax (state)
  if (!i.statutory.ptState) { if (i.expect.includes('pt')) warnings.push('PT: no state for this employee'); }
  else if (!i.rules.pt) missingRule('pt', `PT (${i.statutory.ptState})`);
  else {
    const mm = String(i.month).padStart(2, '0');
    const slab = i.rules.pt.slabs.find((s) => s.upTo == null || gross.lte(s.upTo));
    const pt = slab ? (slab.monthAmounts?.[mm] ?? slab.amount) : 0;
    if (pt > 0) lines.push({ code: 'PT', name: `Professional tax (${i.statutory.ptState})`, kind: 'deduction', amount: pt });
  }
  // LWF (state, specific months)
  if (i.rules.lwf && i.rules.lwf.months.includes(i.month)) {
    if (i.rules.lwf.employee > 0) lines.push({ code: 'LWF_EE', name: 'Labour welfare fund (employee)', kind: 'deduction', amount: i.rules.lwf.employee });
    if (i.rules.lwf.employer > 0) lines.push({ code: 'LWF_ER', name: 'Labour welfare fund (employer)', kind: 'employer', amount: i.rules.lwf.employer });
  }
  // TDS: the regular salary is projected over the year and spread over 12 months; a one-off (adjustment, overtime,
  // encashment) adds the extra tax it causes this year, all in this month. No declarations or previous-month true-up
  // (docs/PAYROLL.md, DECISIONS.md D25).
  if (!i.rules.tds) missingRule('tds', `TDS (${i.statutory.regime} regime)`);
  else {
    const t = i.rules.tds;
    const regular = annualTax(taxableMonthly.times(12), t);
    const withOneOff = annualTax(taxableMonthly.times(12).plus(taxableOneOff), t);
    const monthly = r0(regular.tax.div(12).plus(withOneOff.tax.minus(regular.tax)));
    if (monthly.gt(0)) lines.push({ code: 'TDS', name: 'Income tax (TDS)', kind: 'deduction', amount: n(monthly), basis: `projected taxable ${n(r0(withOneOff.taxable))}` });
  }

  const deductions = lines.filter((l) => l.kind === 'deduction').reduce((s, l) => s.plus(l.amount), new Decimal(0));
  const employer = lines.filter((l) => l.kind === 'employer').reduce((s, l) => s.plus(l.amount), new Decimal(0));
  const net = gross.minus(deductions);
  if (net.lt(0)) warnings.push('Net pay is negative: put the item on hold or adjust');
  return { lines, gross: n(gross), deductions: n(deductions), net: n(net), employerCost: n(gross.plus(employer)), warnings };
}
