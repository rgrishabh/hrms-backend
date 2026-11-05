import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { problem, makeApp, createTenant, Client, ownerQuery, type TenantFixture, flags } from './helpers.js';
import { addDays, localDate } from '../src/modules/attendance/time.js';

const today = localDate(new Date(), 'Asia/Kolkata');
let app: FastifyInstance;
let T: TenantFixture;
let hr: Client;
let mgr: Client;
let emp: Client;
let other: Client;
let itU: Client;
let empId: string;
let cycleId: string;
let reviewId: string;
const rv = async (c: Client) => (await c.get(`/api/v1/performance/reviews/${reviewId}`)).json();

beforeAll(async () => {
  app = await makeApp({ ...flags('default,performance,assets,core.offboarding') });
  T = await createTenant();
  empId = T.users.employee!.employeeId!;
  hr = await Client.login(app, T.host, T.users.hr!.email);
  mgr = await Client.login(app, T.host, T.users.manager!.email);
  emp = await Client.login(app, T.host, T.users.employee!.email);
  other = await Client.login(app, T.host, T.users.other!.email);
  itU = await Client.login(app, T.host, T.users.it!.email);
  await ownerQuery(`UPDATE employees SET date_of_joining='2025-01-01' WHERE tenant_id=$1`, [T.id]);
});
afterAll(async () => {
  await app.close();
});

describe('performance', () => {
  it('a cycle creates reviews for active staff; goals are weighted and agreed by the manager', async () => {
    expect((await emp.post('/api/v1/performance/cycles', { name: 'x', periodStart: '2026-04-01', periodEnd: '2027-03-31' })).statusCode).toBe(403);
    cycleId = (await hr.post('/api/v1/performance/cycles', { name: 'FY 2026-27', periodStart: '2026-04-01', periodEnd: '2027-03-31' })).json().id;
    expect((await emp.get('/api/v1/performance/cycles')).json().items).toEqual([]); // drafts hidden
    const act = (await hr.post(`/api/v1/performance/cycles/${cycleId}/activate`)).json();
    expect(act.reviews).toBeGreaterThanOrEqual(3);
    const g1 = await emp.post(`/api/v1/performance/cycles/${cycleId}/goals/${empId}`, {
      title: 'Report TAT ≤ 3 days for 95% of water samples',
      measure: 'LIMS TAT report',
      weight: 60,
    });
    expect(g1.statusCode).toBe(201);
    expect(problem(await emp.post(`/api/v1/performance/cycles/${cycleId}/goals/${empId}`, { title: 'Too heavy', weight: 50 })).detail).toMatch(/total 110%/);
    expect((await mgr.post(`/api/v1/performance/cycles/${cycleId}/goals/${empId}`, { title: 'Obtain authorization on two new methods', weight: 40 })).statusCode).toBe(201);
    expect((await other.get(`/api/v1/performance/cycles/${cycleId}/goals/${empId}`)).statusCode).toBe(404);
    expect((await emp.post(`/api/v1/performance/goals/${g1.json().id}/agree`)).statusCode).toBe(403);
    expect((await mgr.post(`/api/v1/performance/goals/${g1.json().id}/agree`)).statusCode).toBe(200);
    const goals = (await emp.get(`/api/v1/performance/cycles/${cycleId}/goals/${empId}`)).json();
    expect(goals).toMatchObject({ totalWeight: 100 });
    expect(goals.items.every((g: { status: string }) => g.status === 'agreed')).toBe(true);
  });

  it('self → manager → HR final; ratings hidden from the employee until final; acknowledgement', async () => {
    reviewId = (await emp.get(`/api/v1/performance/reviews?cycleId=${cycleId}&scope=mine`)).json().items[0].id;
    expect(
      problem(
        await mgr.post(`/api/v1/performance/reviews/${reviewId}/manager`, {
          rating: 4,
          comments: 'Strong analyst, reliable on TAT and CRM checks.',
          expectedVersion: (await rv(mgr)).version,
        }),
      ).detail,
    ).toMatch(/self-review/);
    expect((await emp.post(`/api/v1/performance/reviews/${reviewId}/self`, { rating: 4, comments: 'short', expectedVersion: (await rv(emp)).version })).statusCode).toBe(400);
    expect(
      (
        await emp.post(`/api/v1/performance/reviews/${reviewId}/self`, {
          rating: 4,
          comments: 'Met TAT targets; authorized on ICP-OES in September.',
          expectedVersion: (await rv(emp)).version,
        })
      ).statusCode,
    ).toBe(200);
    expect((await other.get(`/api/v1/performance/reviews/${reviewId}`)).statusCode).toBe(404);
    expect(
      (await emp.post(`/api/v1/performance/reviews/${reviewId}/manager`, { rating: 5, comments: 'I rate myself as my manager would.', expectedVersion: (await rv(emp)).version }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await mgr.post(`/api/v1/performance/reviews/${reviewId}/manager`, {
          rating: 3,
          comments: 'Good on TAT; one method authorization still pending.',
          expectedVersion: (await rv(mgr)).version,
        })
      ).statusCode,
    ).toBe(200);
    expect((await rv(emp)).manager_rating).toBeNull();
    expect((await emp.get(`/api/v1/performance/reviews?cycleId=${cycleId}&scope=mine`)).json().items[0].manager_rating).toBeNull();
    expect((await mgr.post(`/api/v1/performance/reviews/${reviewId}/finalize`, { rating: 3, expectedVersion: (await rv(mgr)).version })).statusCode).toBe(403);
    expect(
      (await hr.post(`/api/v1/performance/reviews/${reviewId}/finalize`, { rating: 3, comments: 'Calibrated with the lab panel.', expectedVersion: (await rv(hr)).version }))
        .statusCode,
    ).toBe(200);
    const seen = await rv(emp);
    expect(seen).toMatchObject({ final_rating: 3, manager_rating: 3, status: 'finalized' });
    expect(
      (await emp.post(`/api/v1/performance/reviews/${reviewId}/acknowledge`, { comments: 'Discussed; agreed plan for the second method.', expectedVersion: seen.version }))
        .statusCode,
    ).toBe(200);
    expect(problem(await hr.post(`/api/v1/performance/cycles/${cycleId}/close`)).detail).toMatch(/not finalized/);
  });
});

describe('performance: no one sees or settles their own rating early', () => {
  it('HR does not see their own manager rating in the all-staff list before finalization', async () => {
    await ownerQuery(`UPDATE performance_reviews SET manager_rating=2, status='manager_submitted' WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`, [
      T.id,
      cycleId,
      T.users.hr!.employeeId,
    ]);
    const items = (await hr.get(`/api/v1/performance/reviews?cycleId=${cycleId}&scope=all`)).json().items as { employee_id: string; manager_rating: number | null }[];
    expect(items.find((r) => r.employee_id === T.users.hr!.employeeId)!.manager_rating).toBeNull();
    expect(items.find((r) => r.employee_id === empId)!.manager_rating).toBe(3); // others' ratings remain visible to HR
    const [{ m }] = (await ownerQuery<{ m: { rating: number | null } }>(
      `SELECT change_metadata AS m FROM audit_logs WHERE tenant_id=$1 AND action='performance.review_manager' ORDER BY created_at DESC LIMIT 1`,
      [T.id],
    )) as [{ m: { rating: number | null } }];
    expect(m.rating).toBeNull(); // ratings before finalization are not in the audit log
  });

  it('the reviewing manager cannot also finalize, even with HR rights', async () => {
    const id = (await other.get(`/api/v1/performance/reviews?cycleId=${cycleId}&scope=mine`)).json().items[0].id as string;
    await ownerQuery(`UPDATE employees SET reporting_manager_id=$2 WHERE id=$1`, [T.users.other!.employeeId, T.users.manager!.employeeId]);
    await ownerQuery(`UPDATE performance_reviews SET reviewer_id=$2, manager_rating=4, status='manager_submitted' WHERE id=$1`, [id, T.users.manager!.employeeId]);
    await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'hr_admin')`, [T.users.manager!.id, T.id]);
    try {
      const v = async (c: Client) => (await c.get(`/api/v1/performance/reviews/${id}`)).json().version as number;
      const r = await mgr.post(`/api/v1/performance/reviews/${id}/finalize`, { rating: 4, expectedVersion: await v(mgr) });
      expect(r.statusCode).toBe(403);
      expect(problem(r).detail).toMatch(/different person/);
      expect((await hr.post(`/api/v1/performance/reviews/${id}/finalize`, { rating: 4, expectedVersion: await v(hr) })).statusCode).toBe(200);
    } finally {
      await ownerQuery(`DELETE FROM user_roles WHERE user_id=$1 AND role_key='hr_admin'`, [T.users.manager!.id]);
    }
  });
});

describe('assets', () => {
  let assetId: string;
  it('register, issue with acknowledgement, calibration gate, return, history', async () => {
    expect((await emp.post('/api/v1/assets', { tag: 'LAB-PH-01', name: 'pH meter', category: 'lab_instrument' })).statusCode).toBe(403);
    const r = await itU.post('/api/v1/assets', { tag: 'LAB-PH-01', name: 'pH meter', category: 'lab_instrument', serialNumber: 'PHM-2231', calibrationDue: addDays(today, -1) });
    expect(r.statusCode).toBe(201);
    assetId = r.json().id;
    expect((await itU.post('/api/v1/assets', { tag: 'LAB-PH-01', name: 'dup', category: 'it' })).statusCode).toBe(409);
    expect(problem(await itU.post(`/api/v1/assets/${assetId}/issue`, { employeeId: empId, issuedAt: today })).detail).toMatch(/Calibration expired/);
    await itU.put(`/api/v1/assets/${assetId}`, { tag: 'LAB-PH-01', name: 'pH meter', category: 'lab_instrument', serialNumber: 'PHM-2231', calibrationDue: addDays(today, 7) });
    expect((await itU.post(`/api/v1/assets/${assetId}/issue`, { employeeId: empId, issuedAt: today, conditionOut: 'Good, with electrode' })).statusCode).toBe(200);
    expect((await itU.post(`/api/v1/assets/${assetId}/issue`, { employeeId: T.users.other!.employeeId, issuedAt: today })).statusCode).toBe(409);
    const mine = (await emp.get('/api/v1/assets/mine')).json().items;
    expect(mine).toHaveLength(1);
    expect((await other.post(`/api/v1/assets/assignments/${mine[0].id}/acknowledge`)).statusCode).toBe(404);
    expect((await emp.post(`/api/v1/assets/assignments/${mine[0].id}/acknowledge`)).statusCode).toBe(200);
    expect((await itU.runJob('assets.daily')).json().status).toBe('succeeded');
    expect((await ownerQuery(`SELECT 1 FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND kind='assets.calibration'`, [T.id, T.users.it!.id])).length).toBe(1);
  });

  it('unreturned assets block exit completion until received or recorded lost', async () => {
    const [s] = await ownerQuery<{ id: string }>(
      `INSERT INTO separations (tenant_id, employee_id, kind, reason, notice_date, requested_lwd, approved_lwd, notice_days_required, status, initiated_by)
      VALUES ($1,$2,'resignation','Moving abroad',$3::date - 40,$3::date - 1,$3::date - 1,30,'approved',$4) RETURNING id`,
      [T.id, empId, today, T.users.hr!.id],
    );
    const blocked = await hr.post(`/api/v1/lifecycle/separations/${s!.id}/complete`, { rehireEligible: true });
    expect(problem(blocked).detail).toMatch(/Assets not returned: LAB-PH-01/);
    expect((await itU.post(`/api/v1/assets/${assetId}/receive`, { returnedAt: today, outcome: 'lost' })).statusCode).toBe(400); // explain a loss
    expect((await itU.post(`/api/v1/assets/${assetId}/receive`, { returnedAt: today, outcome: 'returned', conditionIn: 'Good' })).statusCode).toBe(200);
    expect((await hr.post(`/api/v1/lifecycle/separations/${s!.id}/complete`, { rehireEligible: true })).statusCode).toBe(200);
    const h = (await itU.get(`/api/v1/assets/${assetId}/history`)).json().items;
    expect(h[0]).toMatchObject({ outcome: 'returned', condition_out: 'Good, with electrode' });
    expect((await itU.get('/api/v1/assets?status=available')).json().items.some((x: { id: string }) => x.id === assetId)).toBe(true);
  });
});
