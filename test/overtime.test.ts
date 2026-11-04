import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, PASSWORD, type TenantFixture } from './helpers.js';
import { hashPassword } from '../src/core/crypto/index.js';
import { compOffDays } from '../src/modules/overtime/service.js';
import pg from 'pg';
import { TEST_OWNER_URL } from './env.js';
import { createApprovalRequest } from '../src/core/workflow/engine.js';
import type { Db } from '../src/db/tx.js';

// Pay settings here are TEST FIXTURES, not statutory values.
let app: FastifyInstance; let T: TenantFixture;
let hr: Client; let emp: Client; let mgr: Client; let other: Client; let pay: Client; let fin: Client;
let empId: string;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const back = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const PERIOD = today.slice(0, 7);
const [D1, D2, D3, D4] = [back(2), back(3), back(4), back(5)];

const set = (key: string, value: unknown) => hr.put(`/api/v1/tenant/settings/${key}`, { value });
const approve = async (c: Client, entityId: string) => {
  const item = (await c.get('/api/v1/approvals/inbox')).json().items.find((x: { entity_id: string }) => x.entity_id === entityId);
  expect(item, 'visible to approver').toBeTruthy();
  const r = await c.post(`/api/v1/approvals/${item.id}/act`, { action: 'approve' });
  expect(r.statusCode, r.body).toBe(200);
  return item;
};
const claim = (c: Client, workDate: string, minutes: number, payout: 'pay' | 'comp_off') => c.post('/api/v1/overtime/claims', { workDate, minutes, payout, reason: 'Late ICP-MS batch for a client deadline' });
const status = async (id: string) => (await emp.get(`/api/v1/overtime/claims/${id}`)).json().status;

beforeAll(async () => {
  app = await makeApp({ ENABLED_MODULES: 'default,payroll,overtime' });
  T = await createTenant();
  empId = T.users.employee!.employeeId!;
  hr = await Client.login(app, T.host, T.users.hr!.email);
  emp = await Client.login(app, T.host, T.users.employee!.email);
  mgr = await Client.login(app, T.host, T.users.manager!.email);
  other = await Client.login(app, T.host, T.users.other!.email);
  pay = await Client.login(app, T.host, T.users.payroll!.email);
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,'Finance',$3) RETURNING id`, [T.id, `fin@${T.host}`, await hashPassword(PASSWORD)]);
  await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'finance_manager')`, [u!.id, T.id]);
  fin = await Client.login(app, T.host, `fin@${T.host}`);
  await ownerQuery(`UPDATE employees SET date_of_joining='2025-01-01' WHERE tenant_id=$1`, [T.id]);
  for (const [d, ot] of [[D1, 150], [D2, 300], [D3, 90], [D4, 60]] as const)
    await ownerQuery(`INSERT INTO attendance_daily (tenant_id, employee_id, work_date, day_type, status, worked_minutes, overtime_minutes, calc_version) VALUES ($1,$2,$3,'working','present',$4,$5,2)`,
      [T.id, empId, d, 540 + ot, ot]);
  for (const c of [{ code: 'BASIC', name: 'Basic', kind: 'earning', pfWage: true, position: 1 }, { code: 'HRA', name: 'House rent allowance', kind: 'earning', calc: 'percent', baseCodes: ['BASIC'], position: 2 }])
    expect((await pay.post('/api/v1/payroll/components', c)).statusCode).toBe(201);
  const s = await pay.post(`/api/v1/payroll/employees/${empId}/salaries`, { effectiveFrom: '2025-01-01', amounts: { BASIC: 26000, HRA: 40 }, reason: 'Initial salary' });
  expect(s.statusCode, s.body).toBe(201);
  await approve(fin, s.json().id);
});
afterAll(async () => { await app.close(); });

describe('overtime', () => {
  it('is usable only once attendance records overtime', async () => {
    expect((await emp.get('/api/v1/overtime/eligible')).json().error.code).toBe('feature_unavailable');
    expect((await set('attendance.overtime_enabled', true)).statusCode).toBe(200);
    const e = (await emp.get('/api/v1/overtime/eligible')).json();
    expect(e.items.map((d: { work_date: string }) => d.work_date)).toEqual([D1, D2, D3, D4]);
    expect(e.payout).toMatchObject({ pay: false, compOff: null });
    expect(e.payout.payBlocker).toMatch(/pay rate, ordinary rate components, days per month, hours per day, ESI treatment/);
  });

  it('a claim is limited by what attendance recorded, and needs the organization to set the pay rate', async () => {
    expect((await claim(emp, D1, 151, 'pay')).statusCode).toBe(400);           // more than recorded
    expect((await claim(emp, D1, 20, 'pay')).statusCode).toBe(400);            // below the 30-minute minimum
    expect((await claim(emp, back(-1), 60, 'pay')).statusCode).toBe(400);      // future
    expect((await claim(emp, back(40), 60, 'pay')).statusCode).toBe(400);      // outside the window
    expect((await claim(emp, D1, 120, 'pay')).json().error.message).toMatch(/not set up/);
    expect((await claim(emp, D1, 120, 'comp_off')).json().error.message).toMatch(/not offered/);
    for (const [k, v] of [['overtime.rate_multiplier', 2], ['overtime.rate_basis', 'basic'], ['overtime.days_divisor', 26], ['overtime.hours_per_day', 8], ['overtime.esi_wages', 'exclude']] as const)
      expect((await set(k, v)).statusCode, k).toBe(200);
    expect((await emp.get('/api/v1/overtime/eligible')).json().payout.pay).toBe(true);
  });

  it('the manager, then HR approve; nobody approves their own; the summary carries no pay', async () => {
    const r = await claim(emp, D1, 120, 'pay');
    expect(r.statusCode, r.body).toBe(201);
    expect((await claim(emp, D1, 30, 'pay')).statusCode).toBe(409);            // one live claim per day
    expect((await emp.get('/api/v1/approvals/inbox')).json().items.some((x: { entity_id: string }) => x.entity_id === r.json().id)).toBe(false);
    expect((await other.get(`/api/v1/overtime/claims/${r.json().id}`)).statusCode).toBe(404);
    const step = await approve(mgr, r.json().id);
    expect(step.summary).toMatch(/2 h overtime on .* \(paid\)/);
    expect(step.summary).not.toMatch(/₹|\d{3,}\.\d/);
    expect(await status(r.json().id)).toBe('pending');
    await approve(hr, r.json().id);
    expect(await status(r.json().id)).toBe('approved');
    expect((await mgr.get('/api/v1/overtime/claims?scope=team')).json().items.map((c: { id: string }) => c.id)).toContain(r.json().id);
    expect((await emp.get('/api/v1/overtime/claims?scope=all')).statusCode).toBe(403);
  });

  it('payroll pays approved overtime once, at the configured rate on the salary of the day worked', async () => {
    const run = (await pay.post('/api/v1/payroll/runs', { period: PERIOD, legalEntityId: T.legalEntityId })).json().id;
    for (let i = 0; i < 2; i++) expect((await pay.post(`/api/v1/payroll/runs/${run}/compute`)).statusCode).toBe(200); // recompute does not double it
    const item = (await pay.get(`/api/v1/payroll/runs/${run}`)).json().items[0];
    const ot = item.lines.filter((l: { code: string }) => l.code === 'OT');
    // 26000 BASIC ÷ 26 days ÷ 8 h = 125/h; 2 h × 2 = 500. HRA is not in the ordinary-rate basis.
    expect(ot).toHaveLength(1);
    expect(ot[0]).toMatchObject({ kind: 'earning', amount: 500 });
    expect(ot[0].name).toMatch(/^Overtime \(2 h/);
    expect(item.lines.find((l: { code: string }) => l.code === 'PF_EE')).toBeUndefined(); // no PF rule here; OT is never PF wages anyway
    const [c] = await ownerQuery<{ payroll_run_id: string }>(`SELECT payroll_run_id FROM overtime_claims WHERE tenant_id=$1 AND work_date=$2`, [T.id, D1]);
    expect(c!.payroll_run_id).toBe(run);

    // HR cancels it before submission: the run must be recomputed, and then pays nothing.
    const id = (await emp.get('/api/v1/overtime/claims')).json().items.find((x: { work_date: string }) => x.work_date === D1).id;
    expect((await emp.post(`/api/v1/overtime/claims/${id}/cancel`, { reason: 'test' })).statusCode).toBe(403);
    const x = await hr.post(`/api/v1/overtime/claims/${id}/cancel`, { reason: 'Recorded against the wrong day' });
    expect(x.json()).toMatchObject({ ok: true, payrollRunToRecompute: PERIOD });
    expect((await pay.post(`/api/v1/payroll/runs/${run}/submit`)).statusCode).toBe(409);
    await pay.post(`/api/v1/payroll/runs/${run}/compute`);
    expect((await pay.get(`/api/v1/payroll/runs/${run}`)).json().items[0].lines.some((l: { code: string }) => l.code === 'OT')).toBe(false);
    expect((await pay.post(`/api/v1/payroll/runs/${run}/cancel`, { reason: 'test cleanup' })).statusCode).toBeLessThan(300);
  });

  it('compensatory off credits whole half days to the configured leave type and is taken back on cancel', async () => {
    expect(compOffDays(240, 480)).toBe(0.5); expect(compOffDays(479, 480)).toBe(0.5); expect(compOffDays(480, 480)).toBe(1); expect(compOffDays(239, 480)).toBe(0);
    await ownerQuery(`INSERT INTO leave_types (tenant_id, code, name, accrual_method, annual_entitlement) VALUES ($1,'COMP','Compensatory off','none',0)`, [T.id]);
    expect((await set('overtime.comp_off_leave_type', 'comp')).statusCode).toBe(200);
    expect((await claim(emp, D3, 90, 'comp_off')).statusCode).toBe(400);       // less than half a day
    const r = await claim(emp, D2, 300, 'comp_off');
    expect(r.statusCode, r.body).toBe(201);
    await approve(mgr, r.json().id); await approve(hr, r.json().id);
    const credit = async () => Number((await ownerQuery<{ s: string }>(`SELECT coalesce(sum(days),0)::text AS s FROM leave_ledger l JOIN leave_types t ON t.id=l.leave_type_id
      WHERE l.tenant_id=$1 AND l.employee_id=$2 AND t.code='COMP'`, [T.id, empId]))[0]!.s);
    expect(await credit()).toBe(0.5);
    expect((await emp.get(`/api/v1/overtime/claims/${r.json().id}`)).json()).toMatchObject({ status: 'approved', comp_off_days: '0.5' });
    expect((await hr.post(`/api/v1/overtime/claims/${r.json().id}/cancel`, { reason: 'Duplicate of a paid claim' })).statusCode).toBe(200);
    expect(await credit()).toBe(0);
  });

  it('the claimant can withdraw a pending claim; the quarterly limit is enforced', async () => {
    const r = await claim(emp, D3, 90, 'pay');
    expect((await mgr.post(`/api/v1/overtime/claims/${r.json().id}/withdraw`)).statusCode).toBe(403);
    expect((await emp.post(`/api/v1/overtime/claims/${r.json().id}/withdraw`)).statusCode).toBe(200);
    expect(await status(r.json().id)).toBe('cancelled');
    expect((await mgr.get('/api/v1/approvals/inbox')).json().items.some((x: { entity_id: string }) => x.entity_id === r.json().id)).toBe(false);
    expect((await set('overtime.quarter_cap_hours', 1)).statusCode).toBe(200);
    expect((await claim(emp, D4, 60, 'pay')).statusCode).toBe(201);           // exactly 1 h
    expect((await claim(emp, D3, 30, 'pay')).json().error.message).toMatch(/limit of 1 hours for the quarter/);
  });
});

describe('comp-off leave year (AUDIT 4.2)', () => {
  beforeAll(async () => { expect((await set('overtime.quarter_cap_hours', 500)).statusCode).toBe(200); });
  const approvedYear = async (workDate: string) => {
    const [cl] = await ownerQuery<{ id: string }>(`INSERT INTO overtime_claims (tenant_id, employee_id, work_date, minutes, recorded_minutes, payout, reason, created_by)
      VALUES ($1,$2,$3,480,480,'comp_off','Fixture claim',$4) RETURNING id`, [T.id, empId, workDate, T.users.employee!.id]);
    const c = new pg.Client({ connectionString: TEST_OWNER_URL });
    await c.connect();
    await c.query(`SELECT set_config('app.platform_bypass','on',false)`);
    await createApprovalRequest(c as unknown as Db, T.id, { entityType: 'overtime_claim', entityId: cl!.id, requesterId: T.users.employee!.id, summary: 'Fixture', steps: [{ kind: 'permission', permission: 'overtime.approve' }] });
    await c.end();
    await approve(hr, cl!.id);
    return (await ownerQuery<{ leave_year: number }>(`SELECT leave_year FROM leave_ledger WHERE tenant_id=$1 AND reference=$2`, [T.id, `overtime:${cl!.id}:credit`]))[0]!.leave_year;
  };

  it('is credited to the leave year of the work date', async () => {
    expect(await approvedYear('2025-12-20')).toBe(2025);
  });

  it('or to the current year when that year is already closed', async () => {
    await ownerQuery(`INSERT INTO leave_year_closures (tenant_id, leave_year) VALUES ($1,2024)`, [T.id]);
    expect(await approvedYear('2024-12-20')).toBe(Number(today.slice(0, 4)));
  });
});
