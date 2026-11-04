import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, PASSWORD, type TenantFixture, flags } from './helpers.js';
import { hashPassword } from '../src/core/crypto/index.js';

let app: FastifyInstance; let T: TenantFixture;
let emp: Client; let mgr: Client; let other: Client; let fin: Client; let pay: Client;
let empId: string; let catId: string;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const plus = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const isSunday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0;

const trip = (c: Client, b: Record<string, unknown>) => c.post('/api/v1/travel/requests', {
  purpose: 'Stack monitoring at the client plant', origin: 'Pune', destination: 'Taloja MIDC', travelMode: 'road', startDate: plus(10), endDate: plus(11),
  estimate: { travel: 3000, stay: 2500, meals: 1000 }, ...b });
const approve = async (c: Client, entityId: string) => {
  const item = (await c.get('/api/v1/approvals/inbox')).json().items.find((x: { entity_id: string }) => x.entity_id === entityId);
  expect(item, 'visible to approver').toBeTruthy();
  const r = await c.post(`/api/v1/approvals/${item.id}/act`, { action: 'approve' });
  expect(r.statusCode, r.body).toBe(200);
  return item;
};
const get = async (id: string) => (await emp.get(`/api/v1/travel/requests/${id}`)).json();
/** A claim for the trip with one item, submitted and approved by the manager and finance. */
const claimFor = async (tripId: string, amount: number) => {
  const c = await emp.post(`/api/v1/travel/requests/${tripId}/claim`);
  expect(c.statusCode, c.body).toBe(201);
  const claimId = c.json().id;
  expect((await emp.post(`/api/v1/expenses/claims/${claimId}/items`, { categoryId: catId, expenseDate: today, amount: String(amount), description: 'Cab and tolls' })).statusCode).toBe(201);
  expect((await emp.post(`/api/v1/expenses/claims/${claimId}/submit`)).statusCode).toBe(200);
  await approve(mgr, claimId); await approve(fin, claimId);
  return claimId;
};
const claim = async (id: string) => (await ownerQuery<{ status: string; advance_adjusted: string; payment_reference: string | null }>(`SELECT status, advance_adjusted::text, payment_reference FROM expense_claims WHERE id=$1`, [id]))[0]!;

beforeAll(async () => {
  app = await makeApp({ ...flags('default,expenses,field_duty,travel') });
  T = await createTenant();
  empId = T.users.employee!.employeeId!;
  emp = await Client.login(app, T.host, T.users.employee!.email);
  mgr = await Client.login(app, T.host, T.users.manager!.email);
  other = await Client.login(app, T.host, T.users.other!.email);
  pay = await Client.login(app, T.host, T.users.payroll!.email);
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,'Finance',$3) RETURNING id`, [T.id, `fin@${T.host}`, await hashPassword(PASSWORD)]);
  await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'finance_manager')`, [u!.id, T.id]);
  fin = await Client.login(app, T.host, `fin@${T.host}`);
  const c = await fin.post('/api/v1/expenses/categories', { code: 'TRAVEL', name: 'Travel', requiresReceipt: false });
  expect(c.statusCode, c.body).toBe(201);
  catId = c.json().id;
});
afterAll(async () => { await app.close(); });

describe('travel', () => {
  it('checks dates, length and the advance against the estimate', async () => {
    expect((await trip(emp, { startDate: plus(-1), endDate: plus(0) })).json().error.message).toMatch(/past dates/);
    expect((await trip(emp, { startDate: plus(3), endDate: plus(2) })).statusCode).toBe(400);
    expect((await trip(emp, { startDate: plus(1), endDate: plus(70) })).json().error.message).toMatch(/at most 60 days/);
    expect((await trip(emp, { advance: 5300 })).json().error.message).toMatch(/at most 80% of the estimate \(₹5,200\)/);
    expect((await trip(emp, { estimate: {}, advance: 100 })).statusCode).toBe(400);
  });

  it('a trip without an advance needs only the manager; it becomes field duty; colleagues cannot see it', async () => {
    const r = await trip(emp, {});
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id;
    expect((await trip(emp, { startDate: plus(11), endDate: plus(12) })).json().error.message).toMatch(/Overlaps a pending trip/);
    expect((await other.get(`/api/v1/travel/requests/${id}`)).statusCode).toBe(404);
    expect((await emp.get('/api/v1/travel/requests?scope=all')).statusCode).toBe(403);
    const step = await approve(mgr, id);
    expect(step.summary).toMatch(/Pune → Taloja MIDC, .* estimate ₹6,500$/);
    const t = await get(id);
    expect(t).toMatchObject({ status: 'approved', estimate_total: '6500.00', on_duty_note: null });
    expect(t.field_duty_id).toBeTruthy();
    // The traveller cancels before it starts: the field duty goes too.
    expect((await emp.post(`/api/v1/travel/requests/${id}/cancel`, { reason: 'Client postponed the audit' })).statusCode).toBe(200);
    expect((await ownerQuery<{ status: string }>(`SELECT status FROM field_duty_requests WHERE travel_request_id=$1`, [id]))[0]!.status).toBe('cancelled');
  });

  it('an advance needs finance too; finance pays it; the claim uses it up first; the rest is returned and the trip closed', async () => {
    const start = isSunday(today) ? plus(1) : today;   // a working day, so field duty shows in attendance
    if (start !== today) return;                      // the claim, completion and attendance need a trip that has begun
    const r = await trip(emp, { startDate: today, endDate: today, destination: 'Chakan MIDC', advance: 4000 });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id;
    await approve(mgr, id);
    expect((await get(id)).status).toBe('pending');
    await approve(fin, id);
    expect((await get(id)).status).toBe('approved');
    // Field duty for today: attendance shows the day on duty.
    expect((await ownerQuery<{ status: string }>(`SELECT status FROM attendance_daily WHERE employee_id=$1 AND work_date=$2`, [empId, today]))[0]?.status).toBe('on_duty');
    expect((await emp.post(`/api/v1/travel/requests/${id}/advance-paid`, { reference: 'self' })).statusCode).toBe(403);
    expect((await fin.get('/api/v1/travel/requests?scope=all&advance=to_pay')).json().items.map((x: { id: string }) => x.id)).toContain(id);
    expect((await pay.post(`/api/v1/travel/requests/${id}/advance-paid`, { reference: 'NEFT-ADV-1' })).statusCode).toBe(200);
    expect((await pay.post(`/api/v1/travel/requests/${id}/advance-paid`, { reference: 'NEFT-ADV-1' })).statusCode).toBe(409);

    // Spent 3000 of the 4000 advance: the claim is settled from the advance (nothing to reimburse), 1000 still with the employee.
    const claimId = await claimFor(id, 3000);
    expect(await claim(claimId)).toMatchObject({ status: 'paid', advance_adjusted: '3000.00', payment_reference: 'Set off against travel advance' });
    expect((await get(id)).settlement).toMatchObject({ advancePaid: '4000.00', claimed: '3000.00', advanceAdjusted: '3000.00', reimbursable: '0.00', outstanding: '1000.00' });
    expect((await fin.post(`/api/v1/travel/requests/${id}/close`)).json().error.message).toMatch(/marked it completed/);
    expect((await emp.post(`/api/v1/travel/requests/${id}/complete`)).statusCode).toBe(200);
    expect((await fin.post(`/api/v1/travel/requests/${id}/close`)).json().error.message).toMatch(/₹1,000 of the advance is still outstanding/);
    expect((await fin.post(`/api/v1/travel/requests/${id}/advance-returned`, { amount: 1500, note: 'Cash' })).statusCode).toBe(400);
    expect((await fin.post(`/api/v1/travel/requests/${id}/advance-returned`, { amount: 1000, note: 'Returned in cash to accounts' })).json()).toMatchObject({ outstanding: '0.00' });
    expect((await fin.post(`/api/v1/travel/requests/${id}/close`)).statusCode).toBe(200);
    expect((await get(id)).status).toBe('closed');
  });

  it('a claim above the advance: the advance is set off and only the difference is reimbursed', async () => {
    const r = await trip(emp, { startDate: plus(20), endDate: plus(20), destination: 'Ranjangaon', advance: 2000, markOnDuty: false });
    const id = r.json().id;
    await approve(mgr, id); await approve(fin, id);
    expect((await fin.post(`/api/v1/travel/requests/${id}/advance-paid`, { reference: 'NEFT-ADV-2' })).statusCode).toBe(200);
    expect((await get(id)).field_duty_id).toBeNull();                       // not marked as field duty
    const claimId = await claimFor(id, 2500);
    expect(await claim(claimId)).toMatchObject({ status: 'approved', advance_adjusted: '2000.00' });
    const payable = (await pay.get('/api/v1/expenses/payables')).json().items.find((x: { id: string }) => x.id === claimId);
    expect(payable).toMatchObject({ payable: '500.00' });
    const b = await pay.post('/api/v1/expenses/batches', { claimIds: [claimId] });
    expect(b.json()).toMatchObject({ total: '500.00' });
    expect((await get(id)).settlement).toMatchObject({ reimbursable: '500.00', outstanding: '0.00' });
  });

  it('a trip over days already on field duty is approved but not recorded as field duty twice', async () => {
    const d = plus(30);
    const f = await emp.post('/api/v1/field-duty/requests', { startDate: d, endDate: d, purpose: 'client_visit', place: 'Vashi', reason: 'Monthly review' });
    expect(f.statusCode, f.body).toBe(201);
    const r = await trip(emp, { startDate: d, endDate: d, destination: 'Vashi' });
    await approve(mgr, r.json().id);
    const t = await get(r.json().id);
    expect(t.field_duty_id).toBeNull();
    expect(t.on_duty_note).toMatch(/Not recorded as field duty: Overlaps pending field duty/);
  });
});
