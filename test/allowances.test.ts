import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, PASSWORD, type TenantFixture } from './helpers.js';
import { hashPassword } from '../src/core/crypto/index.js';

// Per-diem and mileage: the organization's effective-dated rates price items from days or km.
let app: FastifyInstance; let T: TenantFixture; let emp: Client; let mgr: Client; let fin: Client;
const cats: Record<string, string> = {};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const plus = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const rate = (b: Record<string, unknown>) => fin.post('/api/v1/expenses/allowance-rates', b);
const item = (claimId: string, b: Record<string, unknown>) => emp.post(`/api/v1/expenses/claims/${claimId}/items`, { expenseDate: today, ...b });
const newClaim = async () => (await emp.post('/api/v1/expenses/claims', { title: 'Site visits this week', purpose: 'Sampling at client sites' })).json().id as string;

beforeAll(async () => {
  app = await makeApp({ ENABLED_MODULES: 'default,expenses,travel' });
  T = await createTenant();
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,'finance',$3) RETURNING id`, [T.id, `finance@${T.host}`, await hashPassword(PASSWORD)]);
  await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'finance_manager')`, [u!.id, T.id]);
  await ownerQuery(`UPDATE employees SET grade='L3' WHERE id=$1`, [T.users.employee!.employeeId]);
  fin = await Client.login(app, T.host, `finance@${T.host}`);
  emp = await Client.login(app, T.host, T.users.employee!.email);
  mgr = await Client.login(app, T.host, T.users.manager!.email);
  for (const [code, o] of Object.entries({
    PERDIEM: { name: 'Daily allowance', requiresReceipt: false, calc: 'per_diem' },
    MILEAGE: { name: 'Own vehicle', requiresReceipt: false, calc: 'mileage' },
  })) cats[code] = (await fin.post('/api/v1/expenses/categories', { code, ...o })).json().id;
});
afterAll(async () => { await app.close(); });

describe('allowance rates', () => {
  it('finance sets effective-dated rates; nothing is assumed', async () => {
    const claim = await newClaim();
    let r = await item(claim, { categoryId: cats.PERDIEM, quantity: 1, tier: 'METRO', description: 'Mumbai, client audit' });
    expect(r.json().error.message).toMatch(/no per-diem rate for METRO/);

    expect((await rate({ kind: 'per_diem', tier: 'metro', rate: 1200, effectiveFrom: plus(-30) })).statusCode).toBe(201);
    expect((await rate({ kind: 'per_diem', tier: 'METRO', grade: 'L3', rate: 1500, effectiveFrom: plus(-30) })).statusCode).toBe(201);
    expect((await rate({ kind: 'per_diem', tier: 'METRO', rate: 1400, effectiveFrom: plus(15), note: 'Revised policy' })).statusCode).toBe(201);
    expect((await rate({ kind: 'mileage', vehicle: 'car', rate: 9.5, effectiveFrom: plus(-30) })).statusCode).toBe(201);
    expect((await rate({ kind: 'per_diem', tier: 'METRO', rate: 1300, effectiveFrom: plus(-30) })).statusCode).toBe(409);   // same class, same day
    expect((await rate({ kind: 'mileage', vehicle: 'car', rate: 9, effectiveFrom: plus(-120) })).json().error.message).toMatch(/90 days back/);
    expect((await emp.post('/api/v1/expenses/allowance-rates', { kind: 'mileage', vehicle: 'car', rate: 50, effectiveFrom: today })).statusCode).toBe(403);

    const list = (await emp.get('/api/v1/expenses/allowance-rates')).json();
    expect(list.tiers).toEqual(['METRO']);
    expect(list.items.filter((x: { state: string }) => x.state === 'current').map((x: { rate: string; grade: string | null }) => `${x.grade ?? '*'}:${x.rate}`).sort())
      .toEqual(['*:1200.00', 'L3:1500.00', 'null:9.50'.replace('null', '*')].sort());
    expect(list.items.find((x: { state: string }) => x.state === 'scheduled')).toMatchObject({ rate: '1400.00', note: 'Revised policy' });
  });

  it("prices items from the rate for the employee's grade; less may be claimed, never more", async () => {
    const claim = await newClaim();
    let r = await item(claim, { categoryId: cats.PERDIEM, quantity: 1.5, tier: 'METRO', description: 'Mumbai, client audit' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ amount: '2250.00', rate: '1500.00', allowance: '2250.00' });   // L3 rate beats the general one
    r = await item(claim, { categoryId: cats.MILEAGE, quantity: 42.5, vehicle: 'car', amount: 300, description: 'Lab to Taloja MIDC and back' });
    expect(r.json()).toMatchObject({ amount: '300.00', allowance: '403.75' });
    expect((await item(claim, { categoryId: cats.MILEAGE, quantity: 10, vehicle: 'car', amount: 100, description: 'Too much' })).json().error.message).toMatch(/At most 95.00/);
    expect((await item(claim, { categoryId: cats.MILEAGE, quantity: 10, vehicle: 'two_wheeler', description: 'Scooter' })).json().error.message).toMatch(/no mileage rate for a two-wheeler/);
    expect((await item(claim, { categoryId: cats.PERDIEM, quantity: 1.25, tier: 'METRO', description: 'Odd' })).json().error.message).toMatch(/half days/);
    expect((await item(claim, { categoryId: cats.PERDIEM, tier: 'METRO', description: 'No days' })).json().error.message).toMatch(/number of days/);

    const detail = (await emp.get(`/api/v1/expenses/claims/${claim}`)).json();
    expect(detail.total).toBe('2550.00');
    expect(detail.items.find((i: { calc: string }) => i.calc === 'mileage')).toMatchObject({ quantity: '42.50', rate: '9.50', vehicle: 'car' });

    const quote = (await emp.get(`/api/v1/expenses/allowance-quote?kind=per_diem&tier=METRO&date=${plus(20)}&to=${plus(22)}`)).json();
    expect(quote).toMatchObject({ rate: '1500.00', gradeSpecific: true, quantity: 3, amount: '4500.00' });
    expect((await emp.get(`/api/v1/expenses/allowance-quote?kind=mileage&vehicle=two_wheeler&date=${today}`)).json()).toEqual({ rate: null });
  });

  it("per diem on a trip's claim stays within the trip's days", async () => {
    const t = await emp.post('/api/v1/travel/requests', { purpose: 'Audit at the Mumbai branch', origin: 'Pune', destination: 'Mumbai', travelMode: 'rail',
      startDate: today, endDate: plus(1), estimate: { travel: 800, meals: 3000 } });
    expect(t.statusCode, t.body).toBe(201);
    const inbox = (await mgr.get('/api/v1/approvals/inbox')).json().items.find((x: { entity_id: string }) => x.entity_id === t.json().id);
    expect((await mgr.post(`/api/v1/approvals/${inbox.id}/act`, { action: 'approve' })).statusCode).toBe(200);
    const c = await emp.post(`/api/v1/travel/requests/${t.json().id}/claim`);
    expect(c.statusCode, c.body).toBe(201);
    const claim = c.json().id;
    expect((await item(claim, { categoryId: cats.PERDIEM, quantity: 2, tier: 'METRO', description: 'Mumbai, two days' })).statusCode).toBe(201);
    expect((await item(claim, { categoryId: cats.PERDIEM, quantity: 0.5, tier: 'METRO', description: 'One more' })).json().error.message).toMatch(/lasts 2 day\(s\); 2.00 already claimed/);
    expect((await item(claim, { categoryId: cats.PERDIEM, quantity: 1, tier: 'METRO', expenseDate: plus(-1), description: 'Before' })).json().error.message).toMatch(/must fall between/);
  });

  it('only a rate not yet in force can be withdrawn', async () => {
    const list = (await fin.get('/api/v1/expenses/allowance-rates')).json().items;
    const scheduled = list.find((x: { state: string }) => x.state === 'scheduled');
    const current = list.find((x: { state: string }) => x.state === 'current');
    expect((await fin.del(`/api/v1/expenses/allowance-rates/${current.id}`)).statusCode).toBe(409);
    expect((await fin.del(`/api/v1/expenses/allowance-rates/${scheduled.id}`)).statusCode).toBe(200);
  });
});
