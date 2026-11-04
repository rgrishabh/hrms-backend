import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture, flags, inApp } from './helpers.js';
import { TEST_OWNER_URL } from './env.js';
import { plannedRecoveries } from '../src/modules/loans/service.js';
import type { Db } from '../src/db/tx.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let app: FastifyInstance; let T: TenantFixture; let hr: Client; let pay: Client; let empId: string; let c: pg.Client;
let cl: string; let lwp: string;
const typeBody = (o: Record<string, unknown>) => ({ paid: true, allowHalfDay: true, requiresBalance: true, accrualMethod: 'none', annualEntitlement: 0, carryForwardMax: 0, ...o });
const year = new Date().getUTCFullYear() + 1;
const credit = (days: number, typeId = cl) => hr.post('/api/v1/leave/adjustments', { employeeId: empId, leaveTypeId: typeId, leaveYear: year, days, note: 'Fixture balance' });
const req = (startDate: string, o: Record<string, unknown> = {}) => hr.post('/api/v1/leave/requests', { leaveTypeId: cl, startDate, endDate: startDate, reason: 'Fixture leave', employeeId: empId, ...o });

beforeAll(async () => {
  app = await makeApp({ ...flags('default,payroll,loans,salary_advance,leave') });
  T = await createTenant();
  hr = await Client.login(app, T.host, T.users.hr!.email);
  pay = await Client.login(app, T.host, T.users.payroll!.email);
  empId = T.users.employee!.employeeId!;
  c = new pg.Client({ connectionString: TEST_OWNER_URL });
  await c.connect();
  await c.query(`SELECT set_config('app.platform_bypass','on',false)`);
  cl = (await hr.post('/api/v1/leave/types', typeBody({ code: 'CL', name: 'Casual' }))).json().id;
  lwp = (await hr.post('/api/v1/leave/types', typeBody({ code: 'LWP', name: 'Unpaid', paid: false, requiresBalance: false }))).json().id;
});
afterAll(async () => { await c.end(); await app.close(); });

describe('F-13 loan recovery and repayment do not race', () => {
  it('a repayment waits for a payroll compute holding the loan, then sees what it took', async () => {
    const [l] = await ownerQuery<{ id: string }>(`INSERT INTO employee_loans (tenant_id, employee_id, kind, amount, installments, installment_amount, first_period, purpose, status, created_by, disbursed_at)
      VALUES ($1,$2,'loan',5000,1,5000,'2026-01','Fixture purpose','disbursed',$3,now()) RETURNING id`, [T.id, T.users.other!.employeeId, T.users.hr!.id]);
    const [run] = await ownerQuery<{ id: string }>(`INSERT INTO payroll_runs (tenant_id, legal_entity_id, period, created_by) VALUES ($1,$2,'2026-01',$3) RETURNING id`, [T.id, T.legalEntityId, T.users.payroll!.id]);
    await c.query('BEGIN');
    const planned = await inApp(app, () => plannedRecoveries(c as unknown as Db, T.id, run!.id, T.users.other!.employeeId!, '2026-01', false));
    expect(planned).toHaveLength(1);
    const repayment = pay.post(`/api/v1/loans/requests/${l!.id}/repayment`, { amount: 5000, reference: 'Cash receipt 1' });
    const first = await Promise.race([repayment.then(() => 'finished'), sleep(600).then(() => 'waiting')]);
    expect(first).toBe('waiting');
    await c.query(`INSERT INTO loan_recoveries (tenant_id, loan_id, source, payroll_run_id, period, amount) VALUES ($1,$2,'payroll',$3,'2026-01',5000)`, [T.id, l!.id, run!.id]);
    await c.query('COMMIT');
    expect((await repayment).statusCode).toBe(400);    // nothing left to repay
  });
});

describe('leave overlap and balance under concurrency', () => {
  it('two halves of one date fit together; a third request on that date does not', async () => {
    await credit(5);
    const morning = await req(`${year}-02-03`, { endHalf: 'first_half' });
    expect(morning.statusCode, morning.body).toBe(201);
    const afternoon = await req(`${year}-02-03`, { startHalf: 'second_half' });
    expect(afternoon.statusCode, afternoon.body).toBe(201);
    expect((await req(`${year}-02-03`, { startHalf: 'second_half' })).statusCode).toBe(409);
    expect((await req(`${year}-02-03`)).statusCode).toBe(409);
  });

  it('a paid and an unpaid half on one date are refused: loss of pay could not tell them apart', async () => {
    await req(`${year}-02-04`, { endHalf: 'first_half' });
    const r = await req(`${year}-02-04`, { startHalf: 'second_half', leaveTypeId: lwp });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toMatch(/paid and an unpaid/i);
  });

  it('the database refuses an overlap the application check missed', async () => {
    const insert = (start: string) => ownerQuery(`INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id, leave_year, start_date, end_date, days, reason, requested_by)
      VALUES ($1,$2,$3,$4,$5,$5,1,'Direct',$6)`, [T.id, empId, cl, year, start, T.users.hr!.id]);
    await insert(`${year}-03-02`);
    await expect(insert(`${year}-03-02`)).rejects.toThrow(/leave_requests_no_overlap/);
  });

  it('simultaneous requests cannot together spend more than the balance', async () => {
    const T2 = await createTenant();
    const h2 = await Client.login(app, T2.host, T2.users.hr!.email);
    const type = (await h2.post('/api/v1/leave/types', typeBody({ code: 'CL', name: 'Casual' }))).json().id;
    const e2 = T2.users.employee!.employeeId!;
    await h2.post('/api/v1/leave/adjustments', { employeeId: e2, leaveTypeId: type, leaveYear: year, days: 2, note: 'Fixture balance' });
    const days = [5, 6, 7, 8, 9, 10].map((d) => `${year}-04-${String(d).padStart(2, '0')}`).filter((d) => new Date(d).getUTCDay() !== 0);
    const res = await Promise.all(days.map((d) => h2.post('/api/v1/leave/requests', { leaveTypeId: type, startDate: d, endDate: d, reason: 'Race', employeeId: e2 })));
    expect(res.filter((r) => r.statusCode === 201)).toHaveLength(2);
  });

  it('two pending requests do not block each other at approval', async () => {
    const T3 = await createTenant();
    const h3 = await Client.login(app, T3.host, T3.users.hr!.email);
    const m3 = await Client.login(app, T3.host, T3.users.manager!.email);
    const type = (await h3.post('/api/v1/leave/types', typeBody({ code: 'CL', name: 'Casual' }))).json().id;
    const e3 = T3.users.employee!.employeeId!;
    const adj = (days: number) => h3.post('/api/v1/leave/adjustments', { employeeId: e3, leaveTypeId: type, leaveYear: year, days, note: 'Fixture balance' });
    await adj(2);
    const a = await h3.post('/api/v1/leave/requests', { leaveTypeId: type, startDate: `${year}-05-04`, endDate: `${year}-05-04`, reason: 'First', employeeId: e3 });
    const b = await h3.post('/api/v1/leave/requests', { leaveTypeId: type, startDate: `${year}-05-05`, endDate: `${year}-05-05`, reason: 'Second', employeeId: e3 });
    await adj(-1);   // balance fell after both were requested: one can still be honoured
    expect((await m3.post(`/api/v1/approvals/${a.json().approvalRequestId}/act`, { action: 'approve' })).statusCode).toBe(200);
    expect((await m3.post(`/api/v1/approvals/${b.json().approvalRequestId}/act`, { action: 'approve' })).statusCode).toBe(409);
  });

  it('attendance cannot be locked while leave in the period is pending', async () => {
    await credit(1);
    const r = await req(`${year}-06-02`);
    expect(r.statusCode, r.body).toBe(201);
    const lock = await pay.post('/api/v1/attendance/locks', { periodStart: `${year}-06-01`, periodEnd: `${year}-06-30` });
    expect(lock.statusCode).toBe(409);
    expect(lock.json().error.message).toMatch(/leave/i);
  });
});
