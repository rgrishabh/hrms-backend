import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, PASSWORD, type TenantFixture } from './helpers.js';
import { hashPassword } from '../src/core/crypto/index.js';
import { approveEntity } from './payroll-helpers.js';

let app: FastifyInstance; let T: TenantFixture; let hr: Client; let fin: Client; let emp: Client; let empId: string;
const BODY = { accountHolder: 'Emp N2', accountNumber: '123456789012', ifsc: 'SBIN0001234' };
const url = (id: string) => `/api/v1/employees/${id}/bank-account`;
const accountFor = (id: string) => ownerQuery<{ account_last4: string }>(`SELECT account_last4 FROM employee_bank_accounts WHERE employee_id=$1`, [id]);
const noticesFor = (userId: string) => ownerQuery<{ kind: string; body: string; title: string }>(`SELECT kind, title, body FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND kind LIKE 'employee.bank%' ORDER BY created_at`, [T.id, userId]);

beforeAll(async () => {
  app = await makeApp();
  T = await createTenant();
  hr = await Client.login(app, T.host, T.users.hr!.email);
  emp = await Client.login(app, T.host, T.users.employee!.email);
  empId = T.users.employee!.employeeId!;
  const email = `fin@${T.host}`;
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,'fin',$3) RETURNING id`, [T.id, email, await hashPassword(PASSWORD)]);
  await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'finance_manager')`, [u!.id, T.id]);
  fin = await Client.login(app, T.host, email);
});
afterAll(async () => { await app.close(); });

describe('F-9 bank account changes', () => {
  it('a change waits for a second person and tells the employee, without digits', async () => {
    const r = await hr.put(url(empId), BODY);
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({ ok: true, pending: true });
    expect(await accountFor(empId)).toHaveLength(0);
    const notes = await noticesFor(T.users.employee!.id);
    expect(notes.length).toBe(1);
    expect(notes[0]!.body + notes[0]!.title).not.toMatch(/\d{4}/);
    expect((await hr.put(url(empId), BODY)).statusCode).toBe(409);   // one pending change at a time
    expect((await hr.get('/api/v1/approvals/inbox')).json().items.some((x: { entity_id: string }) => x.entity_id === r.json().id)).toBe(false);
    const inbox = (await fin.get('/api/v1/approvals/inbox')).json().items.find((x: { entity_id: string }) => x.entity_id === r.json().id);
    expect(inbox.summary).not.toMatch(/\d{4}/);
    expect((await approveEntity(fin, r.json().id)).statusCode).toBe(200);
    expect((await accountFor(empId))[0]!.account_last4).toBe('9012');
    expect((await hr.get(url(empId))).json().accountNumberMasked).toBe('XXXXXX9012');
    expect((await noticesFor(T.users.employee!.id)).length).toBe(2);
    const [row] = await ownerQuery<{ account_number_enc: string }>(`SELECT account_number_enc FROM employee_bank_changes WHERE id=$1`, [r.json().id]);
    expect(row!.account_number_enc).not.toContain('123456789012');
  });

  it('a rejected change leaves the current account in place', async () => {
    const r = await hr.put(url(empId), { ...BODY, accountNumber: '999999998888' });
    const item = (await fin.get('/api/v1/approvals/inbox')).json().items.find((x: { entity_id: string }) => x.entity_id === r.json().id);
    expect((await fin.post(`/api/v1/approvals/${item.id}/act`, { action: 'reject', comment: 'Not verified' })).statusCode).toBe(200);
    expect((await accountFor(empId))[0]!.account_last4).toBe('9012');
    expect((await hr.put(url(empId), { ...BODY, accountNumber: '777777776666' })).statusCode).toBe(202);   // no longer pending
  });

  it('nobody can change their own account through this route', async () => {
    const r = await hr.put(url(T.users.hr!.employeeId!), BODY);
    expect(r.statusCode).toBe(403);
    expect((await emp.put(url(empId), BODY)).statusCode).toBe(403);
  });

  it('a pending change can be seen by those who may read bank details, masked', async () => {
    const o = T.users.other!.employeeId!;
    expect((await hr.put(url(o), { ...BODY, accountNumber: '555555554444' })).statusCode).toBe(202);
    const p = await hr.get(`${url(o)}/pending?reveal=1`);
    expect(p.statusCode).toBe(200);
    expect(p.json().pending).toMatchObject({ accountNumberMasked: 'XXXXXX4444', ifsc: 'SBIN0001234' });
    expect((await emp.get(`${url(o)}/pending`)).statusCode).toBe(403);
  });
});
