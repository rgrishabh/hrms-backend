import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery } from './helpers.js';
import { TEST_OWNER_URL } from './env.js';
import { generateDemo } from '../src/db/demo.js';
import { addDays, localDate } from '../src/modules/attendance/time.js';

const today = localDate(new Date(), 'Asia/Kolkata');
const password = 'Demo-Test-Password-1';
let app: FastifyInstance; let c: pg.Client;
let tid: string; let host: string;

beforeAll(async () => {
  app = await makeApp({ ENABLED_MODULES: 'default,leave,overtime,field_duty,expenses,travel' });
  c = new pg.Client({ connectionString: TEST_OWNER_URL });
  await c.connect();
  // A bare, freshly bootstrapped organization: domain + one administrator, no employees.
  const slug = 'd' + randomBytes(5).toString('hex');
  host = `${slug}.test`;
  const [t] = await ownerQuery<{ id: string }>(`INSERT INTO tenants (slug, name) VALUES ($1,'Demo Labs') RETURNING id`, [slug]);
  tid = t!.id;
  await ownerQuery(`INSERT INTO tenant_branding (tenant_id, display_name) VALUES ($1,'Demo Labs')`, [tid]);
  await ownerQuery(`INSERT INTO tenant_domains (tenant_id, hostname, verification_token, verification_status, verified_at, activation_status) VALUES ($1,$2,'x','verified',now(),'active')`, [tid, host]);
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,'Admin','x') RETURNING id`, [tid, `admin@${host}`]);
  await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'tenant_admin')`, [u!.id, tid]);
});
afterAll(async () => { await c.end(); await app.close(); });

describe('demo data generator', () => {
  it('refuses an organization that has real (non-demo) employees, and changes nothing', async () => {
    const T = await createTenant();
    await expect(generateDemo(c, { password, today, tenantId: T.id })).rejects.toThrow(/non-demo employee/);
    expect((await ownerQuery(`SELECT 1 FROM employees WHERE tenant_id=$1 AND employee_code LIKE 'DM-%'`, [T.id])).length).toBe(0);
  });

  it('fills an empty organization across modules, then is idempotent', async () => {
    const r = await generateDemo(c, { password, today, tenantId: tid });
    expect(r!.logins).toHaveLength(10);
    const [counts] = await ownerQuery<Record<string, number>>(`SELECT
      (SELECT count(*)::int FROM employees WHERE tenant_id=$1) AS employees,
      (SELECT count(*)::int FROM attendance_daily WHERE tenant_id=$1) AS days,
      (SELECT count(*)::int FROM job_applications WHERE tenant_id=$1) AS applications,
      (SELECT count(*)::int FROM employee_salaries WHERE tenant_id=$1) AS salaries,
      (SELECT count(*)::int FROM statutory_rules WHERE tenant_id=$1) AS statutory`, [tid]);
    expect(counts).toMatchObject({ employees: 63, applications: 10, salaries: 63, statutory: 0 }); // never ships statutory values
    expect(counts!.days).toBeGreaterThan(1000);
    expect(await generateDemo(c, { password, today, tenantId: tid })).toBeNull();
    expect((await ownerQuery(`SELECT 1 FROM employees WHERE tenant_id=$1`, [tid])).length).toBe(63);
  });

  it('demo logins work and see their own data', async () => {
    const analyst = await Client.login(app, host, `analyst@${host}`, password);
    const bal = (await analyst.get('/api/v1/leave/balances')).json();
    expect(bal.items.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(['CL', 'SL', 'EL']));
    const att = (await analyst.get(`/api/v1/attendance/me?from=${addDays(today, -10)}&to=${addDays(today, -1)}`)).json();
    expect(att.days.length).toBeGreaterThan(0);
    // overtime: an approved compensatory off already credited, and late evenings still to claim
    const mine = (await analyst.get('/api/v1/overtime/claims')).json().items;
    expect(mine).toEqual([expect.objectContaining({ status: 'approved', payout: 'comp_off' })]);
    expect(bal.items.find((i: { code: string }) => i.code === 'COMP')?.available).toBeTruthy();
    const e = (await analyst.get('/api/v1/overtime/eligible')).json();
    expect(e.items.filter((d: { overtime_minutes: number }) => d.overtime_minutes >= 240).length).toBeGreaterThan(0);
    expect(e.payout).toMatchObject({ pay: false, compOff: { code: 'COMP' } }); // pay rate is the organization's to set

    // field duty: the sampler's site visits are on-duty days without office punches; one visit still to report on; out today
    const sampler = await Client.login(app, host, `sampler@${host}`, password);
    const duty = (await sampler.get('/api/v1/field-duty/requests')).json().items;
    expect(duty.length).toBe(4);   // three site visits, and next week's trip
    expect(duty.filter((d: { purpose: string }) => d.purpose === 'official_work')).toHaveLength(1);
    expect(duty.every((d: { status: string }) => d.status === 'approved')).toBe(true);
    expect(duty.filter((d: { outcome: string | null; start_date: string }) => !d.outcome && d.start_date < today)).toHaveLength(1);
    const days = (await sampler.get(`/api/v1/attendance/me?from=${addDays(today, -16)}&to=${addDays(today, -1)}`)).json().days;
    expect(days.filter((d: { status: string; punch_count: number }) => d.status === 'on_duty' && d.punch_count === 0).length).toBeGreaterThanOrEqual(2);

    // travel: the analyst's completed trip (advance paid, claim in draft); the sampler's trip awaiting its advance
    const trips = (await analyst.get('/api/v1/travel/requests')).json().items;
    expect(trips).toEqual([expect.objectContaining({ status: 'completed', advance_paid_amount: '1500.00' })]);
    expect((await analyst.get(`/api/v1/travel/requests/${trips[0].id}`)).json().settlement).toMatchObject({ outstanding: '1500.00', openClaims: 1 });
    expect((await sampler.get('/api/v1/travel/requests')).json().items).toEqual([expect.objectContaining({ status: 'approved', advance_requested: '5000.00', advance_paid_amount: null })]);
  });
});
