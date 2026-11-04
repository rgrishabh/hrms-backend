import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, PASSWORD, type TenantFixture, flags } from './helpers.js';
import { hashPassword } from '../src/core/crypto/index.js';

let app: FastifyInstance; let T: TenantFixture;
let emp: Client; let mgr: Client; let pay: Client; let fin: Client;
let empId: string; let runId: string; let batchId: string;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const THIS = today.slice(0, 7);
const lastDay = (p: string) => { const [y, m] = p.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const approve = async (c: Client, entityId: string) => {
  const item = (await c.get('/api/v1/approvals/inbox')).json().items.find((x: { entity_id: string }) => x.entity_id === entityId);
  expect(item, 'visible to approver').toBeTruthy();
  expect((await c.post(`/api/v1/approvals/${item.id}/act`, { action: 'approve' })).statusCode).toBe(200);
};

beforeAll(async () => {
  app = await makeApp({ ...flags('default,payroll,expenses,accounting_exports') });
  T = await createTenant();
  empId = T.users.employee!.employeeId!;
  emp = await Client.login(app, T.host, T.users.employee!.email);
  mgr = await Client.login(app, T.host, T.users.manager!.email);
  pay = await Client.login(app, T.host, T.users.payroll!.email);
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,'Finance',$3) RETURNING id`, [T.id, `fin@${T.host}`, await hashPassword(PASSWORD)]);
  await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'finance_manager')`, [u!.id, T.id]);
  fin = await Client.login(app, T.host, `fin@${T.host}`);
  // A finalized payroll run: BASIC + HRA (40% of BASIC) less a canteen deduction.
  for (const c of [{ code: 'BASIC', name: 'Basic', kind: 'earning', position: 1 }, { code: 'HRA', name: 'House rent allowance', kind: 'earning', calc: 'percent', baseCodes: ['BASIC'], position: 2 },
    { code: 'CANTEEN', name: 'Canteen', kind: 'deduction', position: 3 }])
    expect((await pay.post('/api/v1/payroll/components', c)).statusCode).toBe(201);
  const s = await pay.post(`/api/v1/payroll/employees/${empId}/salaries`, { effectiveFrom: '2024-01-01', amounts: { BASIC: 30000, HRA: 40, CANTEEN: 500 }, reason: 'Initial salary' });
  expect(s.statusCode, s.body).toBe(201);
  await approve(fin, s.json().id);
  runId = (await pay.post('/api/v1/payroll/runs', { period: THIS, legalEntityId: T.legalEntityId })).json().id;
  expect((await pay.post('/api/v1/attendance/locks', { periodStart: `${THIS}-01`, periodEnd: lastDay(THIS) })).statusCode).toBeLessThan(300);
  expect((await pay.post(`/api/v1/payroll/runs/${runId}/compute?reveal=1`)).statusCode).toBe(200);
  await pay.post(`/api/v1/payroll/runs/${runId}/acknowledge-warnings`, { note: 'Test run without statutory rules' });
  expect((await pay.post(`/api/v1/payroll/runs/${runId}/submit`)).statusCode).toBe(200);
  await approve(fin, runId);
  expect((await pay.post(`/api/v1/payroll/runs/${runId}/finalize`)).statusCode).toBe(200);
  // An approved reimbursement batch.
  const cat = (await fin.post('/api/v1/expenses/categories', { code: 'LOCAL', name: 'Local travel', requiresReceipt: false })).json().id;
  const claim = (await emp.post('/api/v1/expenses/claims', { title: 'Site visit', purpose: 'Sampling at the client plant' })).json().id;
  expect((await emp.post(`/api/v1/expenses/claims/${claim}/items`, { categoryId: cat, expenseDate: today, amount: '740', description: 'Cab' })).statusCode).toBe(201);
  await emp.post(`/api/v1/expenses/claims/${claim}/submit`);
  await approve(mgr, claim); await approve(fin, claim);
  batchId = (await pay.post('/api/v1/expenses/batches', { claimIds: [claim] })).json().id;
  expect((await fin.post(`/api/v1/expenses/batches/${batchId}/approve`)).statusCode).toBe(200);
});
afterAll(async () => { await app.close(); });

describe('accounting exports', () => {
  let basic = ''; let net = '';
  it('only finance and payroll export; the employee cannot', async () => {
    expect((await emp.get(`/api/v1/accounting/payroll-runs/${runId}/journal`)).statusCode).toBe(403);
    expect((await pay.put('/api/v1/accounting/ledger-map', { entries: [{ key: 'net_pay', ledger: 'x' }] })).statusCode).toBe(403);   // payroll exports, finance maps
  });

  it('the payroll journal balances, and nothing is exported until every head has a ledger', async () => {
    const j = (await pay.get(`/api/v1/accounting/payroll-runs/${runId}/journal`)).json();
    // The figures are the run's own (prorated for the unpaid days this test employee has).
    const item = (await pay.get(`/api/v1/payroll/runs/${runId}?reveal=1`)).json().items[0];
    const line = (code: string) => item.lines.find((l: { code: string }) => l.code === code).amount.toFixed(2);
    expect(j).toMatchObject({ date: lastDay(THIS), balanced: true, total: Number(item.gross).toFixed(2) });
    expect(j.entries).toEqual([
      expect.objectContaining({ key: 'earning:BASIC', debit: line('BASIC'), ledger: null }), expect.objectContaining({ key: 'earning:HRA', debit: line('HRA') }),
      expect.objectContaining({ key: 'deduction:CANTEEN', credit: line('CANTEEN') }), expect.objectContaining({ key: 'net_pay', credit: Number(item.net).toFixed(2) })]);
    basic = line('BASIC'); net = Number(item.net).toFixed(2);
    expect(j.missing.sort()).toEqual(['deduction:CANTEEN', 'earning:BASIC', 'earning:HRA', 'net_pay']);
    expect((await pay.get(`/api/v1/accounting/payroll-runs/${runId}/export`)).json().error.message).toMatch(/Map these heads to ledgers first/);
    const heads = (await fin.get('/api/v1/accounting/ledger-map')).json().heads.map((h: { key: string }) => h.key);
    expect(heads).toEqual(expect.arrayContaining(['earning:BASIC', 'deduction:CANTEEN', 'deduction:TDS', 'employer_payable:PF_EPF_ER', 'net_pay', 'expense:LOCAL', 'reimbursement_payable']));
    expect((await fin.put('/api/v1/accounting/ledger-map', { entries: [{ key: 'earning:BASIC', ledger: 'Salaries & Wages' }, { key: 'earning:*', ledger: 'Allowances' },
      { key: 'deduction:*', ledger: 'Staff Recoveries' }, { key: 'net_pay', ledger: 'Salary Payable' }, { key: 'expense:*', ledger: 'Conveyance' }, { key: 'reimbursement_payable', ledger: 'Reimbursements Payable' }] })).statusCode).toBe(200);
    expect((await pay.get(`/api/v1/accounting/payroll-runs/${runId}/journal`)).json().missing).toEqual([]);
  });

  it('exports CSV and Tally XML (debits negative), and logs every export', async () => {
    const csv = await pay.get(`/api/v1/accounting/payroll-runs/${runId}/export?format=csv`);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body.split('\r\n')[1]).toMatch(new RegExp(`^${lastDay(THIS)},PAY-${THIS}-[0-9A-F]{6},Salaries & Wages,${basic.replace('.', '\\.')},0\\.00,`));
    const x = await pay.get(`/api/v1/accounting/payroll-runs/${runId}/export?format=tally_xml`);
    expect(x.body).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>');
    expect(x.body).toContain(`<DATE>${lastDay(THIS).replace(/-/g, '')}</DATE>`);
    expect(x.body).toContain(`<LEDGERNAME>Salaries &amp; Wages</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${basic}</AMOUNT>`);
    expect(x.body).toContain(`<LEDGERNAME>Salary Payable</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${net}</AMOUNT>`);
    expect(x.body).not.toContain('SVCURRENTCOMPANY');
    expect((await ownerQuery(`SELECT format FROM accounting_exports WHERE tenant_id=$1 AND source_id=$2 ORDER BY created_at`, [T.id, runId])).map((r) => r.format)).toEqual(['csv', 'tally_xml']);
    const src = (await pay.get('/api/v1/accounting/sources?reveal=1')).json();
    expect(src.runs.find((r: { id: string }) => r.id === runId).last_export).toMatchObject({ format: 'tally_xml' });
  });

  it('a reimbursement batch: Dr the expense categories, Cr reimbursements payable', async () => {
    const j = (await pay.get(`/api/v1/accounting/reimbursement-batches/${batchId}/journal`)).json();
    expect(j).toMatchObject({ balanced: true, total: '740.00', missing: [] });
    expect(j.entries).toEqual([expect.objectContaining({ key: 'expense:LOCAL', ledger: 'Conveyance', debit: '740.00' }), expect.objectContaining({ key: 'reimbursement_payable', ledger: 'Reimbursements Payable', credit: '740.00' })]);
    expect((await pay.get(`/api/v1/accounting/reimbursement-batches/${batchId}/export?format=csv`)).statusCode).toBe(200);
    // Part of a trip's claim covered by its travel advance clears the advance instead of being payable.
    await ownerQuery(`UPDATE expense_claims SET advance_adjusted=240 WHERE tenant_id=$1 AND batch_id=$2`, [T.id, batchId]);
    const t = (await pay.get(`/api/v1/accounting/reimbursement-batches/${batchId}/journal`)).json();
    expect(t).toMatchObject({ balanced: true, missing: ['travel_advance'] });
    expect(t.entries).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'travel_advance', credit: '240.00' }), expect.objectContaining({ key: 'reimbursement_payable', credit: '500.00' })]));
  });
});
