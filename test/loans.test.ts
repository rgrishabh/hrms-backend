import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, PASSWORD, type TenantFixture } from './helpers.js';
import { hashPassword } from '../src/core/crypto/index.js';

let app: FastifyInstance; let T: TenantFixture;
let emp: Client; let mgr: Client; let other: Client; let pay: Client; let fin: Client;
let empId: string;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const THIS = today.slice(0, 7);
const monthAfter = (p: string, n = 1) => { const [y, m] = p.split('-').map(Number) as [number, number]; const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const NEXT = monthAfter(THIS);
const lastDay = (p: string) => { const [y, m] = p.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

const apply = (c: Client, b: Record<string, unknown>) => c.post('/api/v1/loans/requests', { kind: 'salary_advance', amount: 10000, installments: 3, firstPeriod: THIS, purpose: 'Medical expenses for a family member', ...b });
const approve = async (c: Client, entityId: string) => {
  const item = (await c.get('/api/v1/approvals/inbox')).json().items.find((x: { entity_id: string }) => x.entity_id === entityId);
  expect(item, 'visible to approver').toBeTruthy();
  const r = await c.post(`/api/v1/approvals/${item.id}/act`, { action: 'approve' });
  expect(r.statusCode, r.body).toBe(200);
  return item;
};
const loan = async (id: string) => (await emp.get(`/api/v1/loans/requests/${id}`)).json();
const runFor = async (period: string) => {
  const r = await pay.post('/api/v1/payroll/runs', { period, legalEntityId: T.legalEntityId });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
};
const compute = async (run: string) => {
  expect((await pay.post(`/api/v1/payroll/runs/${run}/compute`)).statusCode).toBe(200);
  return (await pay.get(`/api/v1/payroll/runs/${run}`)).json().items.find((i: { employee_id: string }) => i.employee_id === empId);
};
const loanLines = (item: { lines: { code: string }[] }) => item.lines.filter((l) => l.code.startsWith('LOAN'));

beforeAll(async () => {
  app = await makeApp({ ENABLED_MODULES: 'default,payroll,advances_loans' });
  T = await createTenant();
  empId = T.users.employee!.employeeId!;
  emp = await Client.login(app, T.host, T.users.employee!.email);
  mgr = await Client.login(app, T.host, T.users.manager!.email);
  other = await Client.login(app, T.host, T.users.other!.email);
  pay = await Client.login(app, T.host, T.users.payroll!.email);
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,'Finance',$3) RETURNING id`, [T.id, `fin@${T.host}`, await hashPassword(PASSWORD)]);
  await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'finance_manager')`, [u!.id, T.id]);
  fin = await Client.login(app, T.host, `fin@${T.host}`);
  // Only the employee is on payroll here.
  expect((await pay.post('/api/v1/payroll/components', { code: 'BASIC', name: 'Basic', kind: 'earning', position: 1 })).statusCode).toBe(201);
  const s = await pay.post(`/api/v1/payroll/employees/${empId}/salaries`, { effectiveFrom: '2024-01-01', amounts: { BASIC: 26000 }, reason: 'Initial salary' });
  expect(s.statusCode, s.body).toBe(201);
  await approve(fin, s.json().id);
});
afterAll(async () => { await app.close(); });

describe('advances and loans', () => {
  let adv: string;
  it('checks the policy: instalments, whole rupees, start month', async () => {
    expect((await apply(emp, { installments: 4 })).json().error.message).toMatch(/at most 3 instalment/);
    expect((await apply(emp, { amount: 1000.5 })).statusCode).toBe(400);
    expect((await apply(emp, { firstPeriod: monthAfter(THIS, -1) })).json().error.message).toMatch(/past month/);
  });

  it('the manager, then finance approve; nobody approves their own; one advance at a time', async () => {
    const r = await apply(emp, {});
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().installmentAmount).toBe(3334);
    adv = r.json().id;
    expect((await apply(emp, { amount: 2000, installments: 1 })).json().error.message).toMatch(/already a salary advance in progress/);
    expect((await other.get(`/api/v1/loans/requests/${adv}`)).statusCode).toBe(404);
    expect((await emp.get('/api/v1/approvals/inbox')).json().items.some((x: { entity_id: string }) => x.entity_id === adv)).toBe(false);
    const step = await approve(mgr, adv);
    expect(step.summary).toMatch(/salary advance ₹10000 in 3 instalment\(s\) from/);
    expect((await loan(adv)).status).toBe('pending');
    await approve(fin, adv);
    expect((await loan(adv)).status).toBe('approved');
    expect((await emp.post(`/api/v1/loans/requests/${adv}/disburse`, { reference: 'self' })).statusCode).toBe(403);
    expect((await pay.post(`/api/v1/loans/requests/${adv}/disburse`, { reference: 'NEFT-LN-1' })).statusCode).toBe(200);
    expect((await loan(adv)).schedule).toEqual([{ period: THIS, amount: '3334.00' }, { period: NEXT, amount: '3334.00' }, { period: monthAfter(THIS, 2), amount: '3332.00' }]);
  });

  it('payroll recovers the instalment once per run; a direct repayment covers the rest; the loan closes when the run is final', async () => {
    const run = await runFor(THIS);
    await compute(run);
    const item = await compute(run);                                      // recompute: still one instalment
    expect(loanLines(item)).toEqual([expect.objectContaining({ code: 'LOAN', kind: 'deduction', amount: 3334, name: 'Salary advance recovery (1 of 3)' })]);
    expect(Number(item.net)).toBe(26000 - 3334);
    expect((await loan(adv)).balance).toMatchObject({ outstanding: '6666.00', inProgress: '3334.00', recovered: '0.00' });
    expect((await pay.post(`/api/v1/loans/requests/${adv}/repayment`, { amount: 7000, reference: 'Cash' })).json().error.message).toMatch(/Only ₹6666 is outstanding \(₹3334 more is in a payroll run/);
    expect((await pay.post(`/api/v1/loans/requests/${adv}/repayment`, { amount: 6666, reference: 'Cash receipt 114' })).json()).toMatchObject({ closed: false, outstanding: '0.00' });
    // Finalize the run: then the instalment is recovered and the advance is closed.
    expect((await pay.post('/api/v1/attendance/locks', { periodStart: `${THIS}-01`, periodEnd: lastDay(THIS) })).statusCode).toBeLessThan(300);
    await pay.post(`/api/v1/payroll/runs/${run}/compute`);
    await pay.post(`/api/v1/payroll/runs/${run}/acknowledge-warnings`, { note: 'Test run: attendance not calculated' });
    expect((await pay.post(`/api/v1/payroll/runs/${run}/submit`)).statusCode).toBe(200);
    await approve(fin, run);
    const f = await pay.post(`/api/v1/payroll/runs/${run}/finalize`);
    expect(f.statusCode, f.body).toBe(200);
    expect(await loan(adv)).toMatchObject({ status: 'closed', balance: { outstanding: '0.00', recovered: '10000.00' } });
  });

  it('a recovery never takes net pay below zero; a deferred month recovers nothing', async () => {
    const r = await apply(emp, { kind: 'loan', amount: 50000, installments: 1, firstPeriod: NEXT, purpose: 'House repair' });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id;
    await approve(mgr, id); await approve(fin, id);
    expect((await pay.post(`/api/v1/loans/requests/${id}/disburse`, { reference: 'NEFT-LN-2' })).statusCode).toBe(200);
    const run = await runFor(NEXT);
    const item = await compute(run);
    expect(loanLines(item)).toEqual([expect.objectContaining({ amount: 26000, name: 'Loan recovery (1 of 1)' })]);
    expect(Number(item.net)).toBe(0);
    expect(item.warnings.some((w: string) => /Loan recovery \(1 of 1\): ₹26000 of ₹50000 recovered/.test(w))).toBe(true);
    const d = await pay.post(`/api/v1/loans/requests/${id}/defer`, { period: NEXT, reason: 'Hardship: hospitalisation' });
    expect(d.json()).toMatchObject({ ok: true, recomputePayroll: NEXT });
    expect(loanLines(await compute(run))).toEqual([]);
    expect((await loan(id)).balance.outstanding).toBe('50000.00');
    expect((await loan(id)).schedule[0].period).toBe(monthAfter(NEXT));
  });
});
