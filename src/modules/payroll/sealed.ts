import { openJson, sealJson } from '../../core/crypto/index.js';
import type { Db } from '../../db/tx.js';
import { l4RowFilter, type PolicyViewer } from '../../core/policy/salary.js';
import type { Line } from './calc.js';

/**
 * What is sealed in payroll_items.data_enc: the amounts, the lines, and the warnings (their text can hold figures). The database can
 * no longer compute with pay; everything that needs a number opens it here. Rules the columns used to hold are enforced by `checkItem`.
 */
export interface ItemData { lines: Line[]; gross: number; deductions: number; net: number; employerCost: number; warnings: string[] }
export interface Totals { employees: number; gross: number; deductions: number; net: number; employerCost: number; held: number }

export function sealItem(d: ItemData) {
  for (const k of ['gross', 'deductions', 'net', 'employerCost'] as const) if (!Number.isFinite(d[k])) throw new Error(`Payroll item ${k} is not a number`);
  return sealJson(d);
}
export const openItem = (token: string) => openJson<ItemData>(token);

/** The API's shape for an item's amounts: strings with two decimals, as the numeric columns gave. */
export const itemFields = (d: ItemData) => ({ gross: d.gross.toFixed(2), deductions: d.deductions.toFixed(2), net: d.net.toFixed(2), employer_cost: d.employerCost.toFixed(2), lines: d.lines, warnings: d.warnings });
export const ITEM_FIELDS = ['gross', 'deductions', 'net', 'employer_cost', 'lines', 'warnings'] as const;

export interface AdjustmentData { amount: number; note: string | null }

/** `amount <> 0` used to be a check constraint. Days can be negative (a reversal); money is positive and the kind says which way. */
export function checkAdjustmentAmount(kind: string, amount: number) {
  if (!Number.isFinite(amount) || amount === 0) throw new Error('An adjustment cannot be zero');
  if (kind !== 'lop_days' && amount < 0) throw new Error('Amounts are positive; choose earning or deduction');
  if (Math.abs(amount) >= 1e10) throw new Error('An adjustment is too large');
}
export function sealAdjustment(kind: string, d: AdjustmentData) {
  checkAdjustmentAmount(kind, d.amount);
  return sealJson(d);
}
export const openAdjustment = (token: string) => openJson<AdjustmentData>(token);

/** `annual_ctc numeric(12,2)` and `amounts jsonb NOT NULL` used to hold these. */
export function checkSalary(amounts: Record<string, number>, annualCtc: number | null) {
  if (!Object.keys(amounts).length) throw new Error('A salary needs at least one component');
  for (const [k, v] of Object.entries(amounts)) if (!Number.isFinite(v) || v < 0) throw new Error(`Salary component ${k} is not a valid amount`);
  if (annualCtc !== null && (!Number.isFinite(annualCtc) || annualCtc <= 0 || annualCtc >= 1e10)) throw new Error('Annual CTC is not a valid amount');
}
export function sealSalary(amounts: Record<string, number>, annualCtc: number | null) {
  checkSalary(amounts, annualCtc);
  return { amounts_enc: sealJson(amounts), annual_ctc_enc: annualCtc === null ? null : sealJson(annualCtc) };
}
export const openAmounts = (token: string) => openJson<Record<string, number>>(token);

export const openTotals = (token: string | null) => (token ? openJson<Totals>(token) : null);

const round = (n: number) => Math.round(n * 100) / 100;

/** A run's totals over the people this viewer can see, with how many were left out. */
export async function visibleRunTotals(db: Db, tenantId: string, v: PolicyViewer, runId: string): Promise<Totals & { excluded: number; subjects: string[] }> {
  const rows = (await db.query<{ employee_id: string; data_enc: string; hold: boolean; visible: boolean }>(`SELECT i.employee_id, i.data_enc, i.hold, ${l4RowFilter(v, 'e')} AS visible
    FROM payroll_items i JOIN employees e ON e.tenant_id=i.tenant_id AND e.id=i.employee_id WHERE i.tenant_id=$1 AND i.run_id=$2`, [tenantId, runId])).rows;
  const t = { employees: 0, gross: 0, deductions: 0, net: 0, employerCost: 0, held: 0, excluded: 0 };
  const subjects: string[] = [];
  for (const r of rows) {
    if (!r.visible) { t.excluded++; continue; }
    const d = openItem(r.data_enc);
    subjects.push(r.employee_id);
    t.employees++; t.gross += d.gross; t.deductions += d.deductions; t.net += d.net; t.employerCost += d.employerCost; if (d.net < 0) t.held++;
  }
  return { ...t, gross: round(t.gross), deductions: round(t.deductions), net: round(t.net), employerCost: round(t.employerCost), subjects };
}
