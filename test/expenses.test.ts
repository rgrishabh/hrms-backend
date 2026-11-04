import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, multipart, PASSWORD, type TenantFixture, flags } from './helpers.js';
import { LocalStore, setStore } from '../src/core/storage/index.js';
import { hashPassword } from '../src/core/crypto/index.js';
import { addDays, localDate } from '../src/modules/attendance/time.js';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
const today = localDate(new Date(), 'Asia/Kolkata');
let app: FastifyInstance; let T: TenantFixture; let emp: Client; let mgr: Client; let fin1: Client; let fin2: Client;
const cats: Record<string, string> = {};

async function financeUser(key: string, roles: string[]) {
  const email = `${key}@${T.host}`;
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`, [T.id, email, key, await hashPassword(PASSWORD)]);
  for (const r of roles) await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,$3)`, [u!.id, T.id, r]);
  return Client.login(app, T.host, email);
}
const addItem = (c: Client, claimId: string, f: Record<string, string>, receipt = true) => {
  const m = multipart(f, receipt ? { name: 'bill.pdf', content: PDF } : undefined);
  return c.req('POST', `/api/v1/expenses/claims/${claimId}/items`, m.body, m.headers);
};
const newClaim = async (c: Client, title = 'Client visit — Pune STP sampling') =>
  (await c.post('/api/v1/expenses/claims', { title, purpose: 'Sample collection at client site', project: 'PRJ-042' })).json().id as string;

beforeAll(async () => {
  setStore(new LocalStore(mkdtempSync(path.join(tmpdir(), 'hrms-exp-'))));
  app = await makeApp({ ...flags('default,expenses') }, { storeOverride: true });
  T = await createTenant();
  emp = await Client.login(app, T.host, T.users.employee!.email);
  mgr = await Client.login(app, T.host, T.users.manager!.email);
  fin1 = await financeUser('finance1', ['finance_manager']);
  fin2 = await financeUser('finance2', ['finance_manager', 'payroll_manager']); // payroll role adds employees.bank.read
  for (const [code, o] of Object.entries({
    TRAVEL: { name: 'Local travel', requiresReceipt: false, maxAmount: 2000 },
    HOTEL: { name: 'Accommodation', gstApplicable: true },
    PPE: { name: 'PPE purchase', maxAmount: 5000 },
  })) cats[code] = (await fin1.post('/api/v1/expenses/categories', { code, ...o })).json().id;
  await ownerQuery(`INSERT INTO employee_bank_accounts (employee_id, tenant_id, account_holder, account_number_enc, account_last4, ifsc)
    VALUES ($1,$2,'Emp N2',$3,'9012','SBIN0001234')`, [T.users.employee!.employeeId, T.id, app.deps.cipher.encrypt('123456789012')]);
});
afterAll(async () => { await app.close(); setStore(null); await makeApp().then((x) => x.close()); });

describe('claim validation', () => {
  it('enforces receipts, limits, date window and GST pairing; computes the total in decimals', async () => {
    const id = await newClaim(emp);
    expect((await addItem(emp, id, { categoryId: cats.PPE!, expenseDate: today, amount: '120.50', description: 'Gloves' }, false)).json().error.message).toMatch(/needs a receipt/);
    expect((await addItem(emp, id, { categoryId: cats.TRAVEL!, expenseDate: today, amount: '2500', description: 'Cab' }, false)).json().error.message).toMatch(/limited to 2000/);
    expect((await addItem(emp, id, { categoryId: cats.TRAVEL!, expenseDate: addDays(today, 1), amount: '10', description: 'Future' }, false)).statusCode).toBe(400);
    expect((await addItem(emp, id, { categoryId: cats.TRAVEL!, expenseDate: addDays(today, -90), amount: '10', description: 'Too old' }, false)).json().error.message).toMatch(/older than 60 days/);
    expect((await addItem(emp, id, { categoryId: cats.TRAVEL!, expenseDate: today, amount: '10.123', description: 'Precision' }, false)).statusCode).toBe(400);
    expect((await addItem(emp, id, { categoryId: cats.HOTEL!, expenseDate: today, amount: '3000', description: 'Hotel', invoiceNumber: 'INV-1' })).json().error.message).toMatch(/GSTIN/);
    expect((await addItem(emp, id, { categoryId: cats.TRAVEL!, expenseDate: today, amount: '0.10', description: 'Auto' }, false)).statusCode).toBe(201);
    expect((await addItem(emp, id, { categoryId: cats.TRAVEL!, expenseDate: today, amount: '0.20', description: 'Auto 2' }, false)).statusCode).toBe(201);
    expect((await emp.get(`/api/v1/expenses/claims/${id}`)).json().total).toBe('0.30'); // not 0.30000000000000004
  });

  it('refuses a GST invoice claimed twice and flags a likely duplicate', async () => {
    const a = await newClaim(emp, 'Hotel stay A');
    const hotel = { categoryId: cats.HOTEL!, expenseDate: today, amount: '4200', description: 'Hotel, 1 night', gstin: '27AAAAA0000A1Z5', invoiceNumber: 'HTL/889' };
    expect((await addItem(emp, a, hotel)).statusCode).toBe(201);
    const b = await newClaim(emp, 'Hotel stay B');
    expect((await addItem(emp, b, { ...hotel, invoiceNumber: 'htl/889' })).json().error.message).toMatch(/already been claimed/);
    const r = await addItem(emp, b, { categoryId: cats.HOTEL!, expenseDate: today, amount: '4200', description: 'Same night again', gstin: '27AAAAA0000A1Z5', invoiceNumber: 'HTL/890' });
    expect(r.json().possibleDuplicate).toBe(true);
  });
});

describe('approval and payment', () => {
  it('a manager who is also a finance approver approves only one of the two steps', async () => {
    await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'finance_manager')`, [T.users.manager!.id, T.id]);
    try {
      const id = await newClaim(emp, 'Two-step check');
      expect((await addItem(emp, id, { categoryId: cats.TRAVEL!, expenseDate: today, amount: '300', description: 'Auto' }, false)).statusCode).toBe(201);
      expect((await emp.post(`/api/v1/expenses/claims/${id}/submit`)).statusCode).toBe(200);
      const item = async (cl: Client) => (await cl.get('/api/v1/approvals/inbox')).json().items.find((x: { entity_id: string }) => x.entity_id === id);
      const req = (await item(mgr)).id;
      expect((await mgr.post(`/api/v1/approvals/${req}/act`, { action: 'approve' })).statusCode).toBe(200);
      expect(await item(mgr)).toBeUndefined(); // the finance step is someone else's
      expect((await mgr.post(`/api/v1/approvals/${req}/act`, { action: 'approve' })).statusCode).toBe(403);
      expect((await fin1.post(`/api/v1/approvals/${req}/act`, { action: 'approve' })).statusCode).toBe(200);
    } finally { await ownerQuery(`DELETE FROM user_roles WHERE user_id=$1 AND role_key='finance_manager'`, [T.users.manager!.id]); }
  });

  let claimId = ''; let batchId = '';
  it('requires manager then finance approval; colleagues cannot see the claim', async () => {
    claimId = await newClaim(emp, 'PPE and travel — Nov');
    await addItem(emp, claimId, { categoryId: cats.PPE!, expenseDate: today, amount: '1499.00', description: 'Safety goggles' });
    await addItem(emp, claimId, { categoryId: cats.TRAVEL!, expenseDate: today, amount: '350.50', description: 'Cab to site' }, false);
    expect((await emp.post(`/api/v1/expenses/claims/${claimId}/submit`)).json().ok).toBe(true);
    expect((await emp.put(`/api/v1/expenses/claims/${claimId}`, { title: 'Changed', purpose: 'Changed purpose' })).statusCode).toBe(409); // locked once submitted
    const other = await Client.login(app, T.host, T.users.other!.email);
    expect((await other.get(`/api/v1/expenses/claims/${claimId}`)).statusCode).toBe(404);
    const step1 = (await mgr.get('/api/v1/approvals/inbox')).json().items.find((x: { entity_id: string }) => x.entity_id === claimId);
    expect(step1.summary).toBe('PPE and travel — Nov');
    expect((await fin1.get('/api/v1/approvals/inbox')).json().items.some((x: { entity_id: string }) => x.entity_id === claimId)).toBe(false); // not yet
    await mgr.post(`/api/v1/approvals/${step1.id}/act`, { action: 'approve' });
    const step2 = (await fin1.get('/api/v1/approvals/inbox')).json().items.find((x: { entity_id: string }) => x.entity_id === claimId);
    await fin1.post(`/api/v1/approvals/${step2.id}/act`, { action: 'approve' });
    expect((await emp.get(`/api/v1/expenses/claims/${claimId}`)).json().status).toBe('approved');
    const receiptItem = (await fin1.get(`/api/v1/expenses/claims/${claimId}`)).json().items.find((i: { has_receipt: boolean }) => i.has_receipt);
    const dl = await fin1.get(`/api/v1/expenses/items/${receiptItem.id}/receipt`);
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(PDF)).toBe(true);
  });

  it('payment batches need a second person to approve, and are paid once', async () => {
    const payables = (await fin1.get('/api/v1/expenses/payables')).json().items;
    expect(payables.map((p: { id: string }) => p.id)).toContain(claimId);
    const b = await fin1.post('/api/v1/expenses/batches', { claimIds: [claimId] });
    expect(b.json().total).toBe('1849.50');
    batchId = b.json().id;
    expect((await fin1.post('/api/v1/expenses/batches', { claimIds: [claimId] })).statusCode).toBe(409); // already batched
    expect((await fin1.post(`/api/v1/expenses/batches/${batchId}/paid`, { paymentReference: 'NEFT123' })).statusCode).toBe(409); // not approved
    expect((await fin1.post(`/api/v1/expenses/batches/${batchId}/approve`)).statusCode).toBe(403); // maker-checker
    expect((await fin2.post(`/api/v1/expenses/batches/${batchId}/approve`)).statusCode).toBe(200);
    expect((await fin2.post(`/api/v1/expenses/batches/${batchId}/paid`, { paymentReference: 'NEFT-2026-1101' })).json().claimsPaid).toBe(1);
    expect((await fin2.post(`/api/v1/expenses/batches/${batchId}/paid`, { paymentReference: 'NEFT-AGAIN' })).statusCode).toBe(409);
    const c = (await emp.get(`/api/v1/expenses/claims/${claimId}`)).json();
    expect(c).toMatchObject({ status: 'paid', payment_reference: 'NEFT-2026-1101' });
    expect((await emp.get('/api/v1/notifications')).json().items.some((n: { kind: string }) => n.kind === 'expenses.paid')).toBe(true);
  });

  it('bank export shows full account numbers only to users who may read bank details; always audited', async () => {
    const masked = (await fin1.get(`/api/v1/expenses/batches/${batchId}/export.csv`)).body;
    expect(masked).toContain('XXXXXX9012');
    expect(masked).not.toContain('123456789012');
    const full = (await fin2.get(`/api/v1/expenses/batches/${batchId}/export.csv`)).body;
    expect(full).toContain('123456789012');
    expect(full.split('\r\n')[1]).toMatch(/^E2,Emp N2,1849.50,1,Emp N2,SBIN0001234,123456789012$/);
    expect((await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='expenses.batch_exported'`, [T.id])).length).toBe(2);
    expect((await emp.get(`/api/v1/expenses/batches/${batchId}/export.csv`)).statusCode).toBe(403);
  });

  it('a returned claim becomes editable again and can be resubmitted; cancelling a submitted claim closes its approval', async () => {
    const id = await newClaim(emp, 'Returned claim');
    await addItem(emp, id, { categoryId: cats.TRAVEL!, expenseDate: today, amount: '99', description: 'Bus' }, false);
    await emp.post(`/api/v1/expenses/claims/${id}/submit`);
    const s = (await mgr.get('/api/v1/approvals/inbox')).json().items.find((x: { entity_id: string }) => x.entity_id === id);
    await mgr.post(`/api/v1/approvals/${s.id}/act`, { action: 'return', comment: 'Add the ticket number' });
    expect((await emp.get(`/api/v1/expenses/claims/${id}`)).json()).toMatchObject({ status: 'returned', editable: true });
    expect((await emp.put(`/api/v1/expenses/claims/${id}`, { title: 'Returned claim', purpose: 'Bus ticket 4411' })).statusCode).toBe(200);
    expect((await emp.post(`/api/v1/expenses/claims/${id}/submit`)).statusCode).toBe(200);
    expect((await emp.post(`/api/v1/expenses/claims/${id}/cancel`)).statusCode).toBe(200);
    expect((await mgr.get('/api/v1/approvals/inbox')).json().items.some((x: { entity_id: string }) => x.entity_id === id)).toBe(false);
  });

  it('ageing report summarises approved-unpaid and the pipeline', async () => {
    const r = (await fin1.get('/api/v1/expenses/reports/ageing')).json();
    expect(r).toHaveProperty('approvedUnpaidByAge');
    expect(r.last3MonthsByCategory.some((c: { name: string }) => c.name === 'PPE purchase')).toBe(true);
    expect((await emp.get('/api/v1/expenses/reports/ageing')).statusCode).toBe(403);
  });
});
