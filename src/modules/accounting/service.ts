import { Decimal } from 'decimal.js';
import type { Db } from '../../db/tx.js';
import { openItem } from '../payroll/sealed.js';
import { notFound, conflict } from '../../core/http/errors.js';

export interface Entry { ledger: string | null; key: string; label: string; debit: string; credit: string }
export interface Journal { date: string; number: string; narration: string; entries: Entry[]; missing: string[]; total: string; balanced: boolean }

async function ledgerMap(db: Db, tenantId: string) {
  return new Map((await db.query<{ map_key: string; ledger_name: string }>(`SELECT map_key, ledger_name FROM accounting_ledger_map WHERE tenant_id=$1`, [tenantId])).rows
    .map((r) => [r.map_key, r.ledger_name]));
}

/** Ledger for a head: the exact key, else the group's `*` fallback. */
const resolve = (map: Map<string, string>, key: string) => map.get(key) ?? (key.includes(':') ? map.get(`${key.split(':')[0]}:*`) : undefined) ?? null;

/** Aggregate (key, label, side) amounts into journal entries; missing ledgers are reported, never guessed. */
function journal(map: Map<string, string>, rows: { key: string; label: string; side: 'dr' | 'cr'; amount: Decimal }[], head: Omit<Journal, 'entries' | 'missing' | 'total' | 'balanced'>): Journal {
  const agg = new Map<string, { label: string; dr: Decimal; cr: Decimal }>();
  for (const r of rows) {
    if (r.amount.isZero()) continue;
    const a = agg.get(r.key) ?? { label: r.label, dr: new Decimal(0), cr: new Decimal(0) };
    if (r.side === 'dr') a.dr = a.dr.plus(r.amount); else a.cr = a.cr.plus(r.amount);
    agg.set(r.key, a);
  }
  const entries: Entry[] = []; const missing: string[] = [];
  let dr = new Decimal(0); let cr = new Decimal(0);
  for (const [key, a] of agg) {
    const ledger = resolve(map, key);
    if (!ledger) missing.push(key);
    const net = a.dr.minus(a.cr);          // a head is on one side; keep it there
    entries.push({ ledger, key, label: a.label, debit: net.gt(0) ? net.toFixed(2) : '0.00', credit: net.lt(0) ? net.neg().toFixed(2) : '0.00' });
    if (net.gt(0)) dr = dr.plus(net); else cr = cr.plus(net.neg());
  }
  entries.sort((x, y) => (Number(y.debit) > 0 ? 1 : 0) - (Number(x.debit) > 0 ? 1 : 0) || x.key.localeCompare(y.key));
  return { ...head, entries, missing, total: dr.toFixed(2), balanced: dr.eq(cr) };
}

const lastDay = (period: string) => { const [y, m] = period.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

/**
 * A finalized (or paid) payroll run as one journal voucher, accrual basis:
 * Dr each earning and each employer contribution (expense); Cr each employee deduction, each employer
 * contribution (payable) and the net pay payable. Held items are included: their pay is still owed.
 */
export async function payrollJournal(db: Db, tenantId: string, runId: string): Promise<Journal> {
  const run = (await db.query<{ period: string; kind: string; status: string; entity: string; employee: string | null }>(`SELECT r.period, r.kind, r.status, le.name AS entity,
      (SELECT trim(e.first_name||' '||coalesce(e.last_name,'')) FROM employees e WHERE e.tenant_id=r.tenant_id AND e.id=r.employee_id) AS employee
    FROM payroll_runs r JOIN legal_entities le ON le.tenant_id=r.tenant_id AND le.id=r.legal_entity_id WHERE r.tenant_id=$1 AND r.id=$2`, [tenantId, runId])).rows[0];
  if (!run) throw notFound('Payroll run not found');
  if (!['finalized', 'paid'].includes(run.status)) throw conflict('Only a finalized or paid run can be exported');
  const items = (await db.query<{ data_enc: string }>(`SELECT data_enc FROM payroll_items WHERE tenant_id=$1 AND run_id=$2`, [tenantId, runId])).rows.map((i) => openItem(i.data_enc));
  const rows: Parameters<typeof journal>[1] = [];
  for (const i of items) {
    for (const l of i.lines) {
      const amt = new Decimal(l.amount);
      if (l.kind === 'earning') rows.push({ key: `earning:${l.code}`, label: l.name.replace(/ \(.*\)$/, ''), side: 'dr', amount: amt });
      else if (l.kind === 'deduction') rows.push({ key: `deduction:${l.code}`, label: l.name.replace(/ \(\d+ of \d+\)$/, ''), side: 'cr', amount: amt });
      else { rows.push({ key: `employer_expense:${l.code}`, label: `${l.name} — expense`, side: 'dr', amount: amt }); rows.push({ key: `employer_payable:${l.code}`, label: `${l.name} — payable`, side: 'cr', amount: amt }); }
    }
    rows.push({ key: 'net_pay', label: 'Net salary payable', side: 'cr', amount: new Decimal(i.net) });
  }
  const map = await ledgerMap(db, tenantId);
  return journal(map, rows, { date: lastDay(run.period), number: `PAY-${run.period}${run.kind === 'fnf' ? '-FNF' : ''}-${runId.slice(0, 6).toUpperCase()}`,
    narration: `Salaries for ${run.period}${run.kind === 'fnf' ? ` (full and final: ${run.employee})` : ''} — ${run.entity}` });
}

/**
 * An approved or paid reimbursement batch as a journal voucher: Dr each expense category (the items claimed),
 * Cr travel advances for the part of trip claims set off against an advance, Cr reimbursements payable (what the batch pays).
 */
export async function reimbursementJournal(db: Db, tenantId: string, batchId: string): Promise<Journal> {
  const b = (await db.query<{ status: string; total: string; approved_at: string | null; paid_at: string | null; created_at: string }>(
    `SELECT status, total, approved_at::text, paid_at::text, created_at::text FROM reimbursement_batches WHERE tenant_id=$1 AND id=$2`, [tenantId, batchId])).rows[0];
  if (!b) throw notFound('Batch not found');
  if (!['approved', 'paid'].includes(b.status)) throw conflict('Only an approved or paid batch can be exported');
  const cats = (await db.query<{ code: string; name: string; amount: string }>(`SELECT cat.code, cat.name, sum(i.amount)::text AS amount
    FROM expense_items i JOIN expense_claims c ON c.tenant_id=i.tenant_id AND c.id=i.claim_id JOIN expense_categories cat ON cat.tenant_id=i.tenant_id AND cat.id=i.category_id
    WHERE i.tenant_id=$1 AND c.batch_id=$2 GROUP BY cat.code, cat.name`, [tenantId, batchId])).rows;
  const adjusted = new Decimal((await db.query<{ a: string }>(`SELECT coalesce(sum(advance_adjusted),0)::text AS a FROM expense_claims WHERE tenant_id=$1 AND batch_id=$2`, [tenantId, batchId])).rows[0]!.a);
  const rows: Parameters<typeof journal>[1] = cats.map((c) => ({ key: `expense:${c.code}`, label: c.name, side: 'dr' as const, amount: new Decimal(c.amount) }));
  const claimed = cats.reduce((s, c) => s.plus(c.amount), new Decimal(0));
  // A trip's claim first uses up its travel advance: that part clears the advance; only the rest is payable.
  if (adjusted.gt(0)) rows.push({ key: 'travel_advance', label: 'Travel advances (set off)', side: 'cr', amount: adjusted });
  rows.push({ key: 'reimbursement_payable', label: 'Reimbursements payable', side: 'cr', amount: claimed.minus(adjusted) });
  const map = await ledgerMap(db, tenantId);
  const date = (b.paid_at ?? b.approved_at ?? b.created_at).slice(0, 10);
  return journal(map, rows, { date, number: `EXP-${date.replace(/-/g, '')}-${batchId.slice(0, 6).toUpperCase()}`, narration: `Employee expense reimbursements, batch ${batchId.slice(0, 8)}` });
}

const csvCell = (v: string) => (/^[=+\-@]/.test(v) ? `'${v}` : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export function toCsv(j: Journal) {
  const lines = [['date', 'voucher', 'ledger', 'debit', 'credit', 'narration', 'head'].join(',')];
  for (const e of j.entries) lines.push([j.date, j.number, e.ledger ?? '', e.debit, e.credit, j.narration, e.key].map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
/**
 * Tally (TallyPrime / ERP 9) XML import envelope with one voucher. Tally signs amounts: debits are negative with
 * ISDEEMEDPOSITIVE Yes, credits positive with No. Ledgers must already exist in the company with these exact names.
 */
export function toTallyXml(j: Journal, opts: { company: string | null; voucherType: string }) {
  const entries = j.entries.map((e) => {
    const dr = Number(e.debit) > 0;
    return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xml(e.ledger ?? '')}</LEDGERNAME><ISDEEMEDPOSITIVE>${dr ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${dr ? `-${e.debit}` : e.credit}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
  }).join('\n');
  const company = opts.company ? `<STATICVARIABLES><SVCURRENTCOMPANY>${xml(opts.company)}</SVCURRENTCOMPANY></STATICVARIABLES>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>
<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>${company}</REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="${xml(opts.voucherType)}" ACTION="Create">
<DATE>${j.date.replace(/-/g, '')}</DATE><VOUCHERTYPENAME>${xml(opts.voucherType)}</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(j.number)}</VOUCHERNUMBER><NARRATION>${xml(j.narration)}</NARRATION>
${entries}
</VOUCHER>
</TALLYMESSAGE></REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>
`;
}
