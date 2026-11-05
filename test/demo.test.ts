import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, flags, inApp } from './helpers.js';
import { TEST_OWNER_URL } from './env.js';
import { demoRoles, generateDemo } from '../src/db/demo.js';
import { addDays, localDate } from '../src/modules/attendance/time.js';

const today = localDate(new Date(), 'Asia/Kolkata');
const password = 'Demo-Test-Password-1';
let app: FastifyInstance;
let c: pg.Client;
let tid: string;
let host: string;

beforeAll(async () => {
  app = await makeApp({
    ...flags(
      'default,leave,comp_off,overtime,field_duty,expenses,travel,payroll,loans,salary_advance,training,lab.competency,core.policies,recruitment,core.onboarding,core.offboarding,assets,performance,posh,grievance',
    ),
  });
  c = new pg.Client({ connectionString: TEST_OWNER_URL });
  await c.connect();
  // A bare, freshly bootstrapped organization: domain + one administrator, no employees.
  const slug = 'd' + randomBytes(5).toString('hex');
  host = `${slug}.test`;
  const [t] = await ownerQuery<{ id: string }>(`INSERT INTO tenants (slug, name) VALUES ($1,'Demo Labs') RETURNING id`, [slug]);
  tid = t!.id;
  await ownerQuery(`INSERT INTO tenant_branding (tenant_id, display_name) VALUES ($1,'Demo Labs')`, [tid]);
  await ownerQuery(
    `INSERT INTO tenant_domains (tenant_id, hostname, verification_token, verification_status, verified_at, activation_status) VALUES ($1,$2,'x','verified',now(),'active')`,
    [tid, host],
  );
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,'Admin','x') RETURNING id`, [tid, `admin@${host}`]);
  await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'tenant_admin')`, [u!.id, tid]);
});
afterAll(async () => {
  await c.end();
  await app.close();
});

describe('demo data generator', () => {
  it('refuses an organization that has real (non-demo) employees, and changes nothing', async () => {
    const T = await createTenant();
    await expect(generateDemo(c, { password, today, tenantId: T.id, features: app.deps.env.enabledFeatures })).rejects.toThrow(/non-demo employee/);
    expect((await ownerQuery(`SELECT 1 FROM employees WHERE tenant_id=$1 AND employee_code LIKE 'DM-%'`, [T.id])).length).toBe(0);
  });

  it('fills an empty organization across modules, then is idempotent', async () => {
    const r = await generateDemo(c, { password, today, tenantId: tid, features: app.deps.env.enabledFeatures });
    expect(r!.logins).toHaveLength(10);
    const [counts] = await ownerQuery<Record<string, number>>(
      `SELECT
      (SELECT count(*)::int FROM employees WHERE tenant_id=$1) AS employees,
      (SELECT count(*)::int FROM attendance_daily WHERE tenant_id=$1) AS days,
      (SELECT count(*)::int FROM job_applications WHERE tenant_id=$1) AS applications,
      (SELECT count(*)::int FROM employee_salaries WHERE tenant_id=$1) AS salaries,
      (SELECT count(*)::int FROM statutory_rules WHERE tenant_id=$1) AS statutory`,
      [tid],
    );
    expect(counts).toMatchObject({ employees: 63, applications: 10, salaries: 63, statutory: 0 }); // never ships statutory values
    expect(counts!.days).toBeGreaterThan(1000);
    expect(await generateDemo(c, { password, today, tenantId: tid, features: app.deps.env.enabledFeatures })).toBeNull();
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

    // advances and loans: the analyst's salary advance, paid out, recovered from this month
    const loans = (await analyst.get('/api/v1/loans/requests?reveal=1')).json().items;
    expect(loans).toEqual([expect.objectContaining({ kind: 'salary_advance', status: 'disbursed', installment_amount: '5000.00', outstanding: '15000.00' })]);

    // field duty: the sampler's site visits are on-duty days without office punches; one visit still to report on; out today
    const sampler = await Client.login(app, host, `sampler@${host}`, password);
    const duty = (await sampler.get('/api/v1/field-duty/requests')).json().items;
    expect(duty.length).toBe(4); // three site visits, and next week's trip
    expect(duty.filter((d: { purpose: string }) => d.purpose === 'official_work')).toHaveLength(1);
    expect(duty.every((d: { status: string }) => d.status === 'approved')).toBe(true);
    expect(duty.filter((d: { outcome: string | null; start_date: string }) => !d.outcome && d.start_date < today)).toHaveLength(1);
    const days = (await sampler.get(`/api/v1/attendance/me?from=${addDays(today, -16)}&to=${addDays(today, -1)}`)).json().days;
    expect(days.filter((d: { status: string; punch_count: number }) => d.status === 'on_duty' && d.punch_count === 0).length).toBeGreaterThanOrEqual(2);

    // travel: the analyst's completed trip (advance paid, claim in draft); the sampler's trip awaiting its advance
    const trips = (await analyst.get('/api/v1/travel/requests')).json().items;
    expect(trips).toEqual([expect.objectContaining({ status: 'completed', advance_paid_amount: '1500.00' })]);
    expect((await analyst.get(`/api/v1/travel/requests/${trips[0].id}`)).json().settlement).toMatchObject({ outstanding: '1500.00', openClaims: 1 });
    expect((await sampler.get('/api/v1/travel/requests')).json().items).toEqual([
      expect.objectContaining({ status: 'approved', advance_requested: '5000.00', advance_paid_amount: null }),
    ]);
  });
});

describe('demo data in each management mode', () => {
  it('seeds single, single_hr and multi deterministically, with roles that exist in the mode', async () => {
    const seededRoles = async (mode: 'single' | 'single_hr' | 'multi') => {
      const a = await makeApp({ ...flags('default,payroll'), ORG_MANAGEMENT_MODE: mode });
      const slug = 'd' + randomBytes(5).toString('hex');
      const [t] = await ownerQuery<{ id: string }>(`INSERT INTO tenants (slug, name) VALUES ($1,'Demo') RETURNING id`, [slug]);
      await ownerQuery(
        `INSERT INTO tenant_domains (tenant_id, hostname, verification_token, verification_status, verified_at, activation_status) VALUES ($1,$2,'x','verified',now(),'active')`,
        [t!.id, `${slug}.test`],
      );
      const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,'Admin','x') RETURNING id`, [
        t!.id,
        `a@${slug}.test`,
      ]);
      await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'tenant_admin')`, [u!.id, t!.id]);
      const db = new pg.Client({ connectionString: TEST_OWNER_URL });
      await db.connect();
      await inApp(a, () => generateDemo(db, { password, today: '2026-11-05', tenantId: t!.id, features: a.deps.env.enabledFeatures, mode }));
      await db.end();
      const roles = await ownerQuery<{ role_key: string }>(`SELECT DISTINCT role_key FROM user_roles WHERE tenant_id=$1 ORDER BY role_key`, [t!.id]);
      const names = await ownerQuery<{ s: string }>(
        `SELECT string_agg(employee_code||first_name||last_name||date_of_joining, ',' ORDER BY employee_code) AS s FROM employees WHERE tenant_id=$1`,
        [t!.id],
      );
      const salaries = await ownerQuery<{ amounts_enc: string }>(`SELECT amounts_enc FROM employee_salaries WHERE tenant_id=$1 ORDER BY employee_id`, [t!.id]);
      await a.close();
      expect(salaries.length).toBeGreaterThan(0);
      for (const s of salaries) expect(s.amounts_enc.startsWith('v2.')).toBe(true);
      return { roles: roles.map((r) => r.role_key), people: names[0]!.s.replace(/DM-/g, '') };
    };
    const single = await seededRoles('single');
    const singleHr = await seededRoles('single_hr');
    const multi = await seededRoles('multi');
    expect(single.roles).toEqual(['employee', 'owner', 'tenant_admin']);
    expect(singleHr.roles).toEqual(['employee', 'hr_admin', 'hr_executive', 'owner', 'tenant_admin']);
    expect(multi.roles).toContain('payroll_manager');
    expect(multi.roles).not.toContain('owner');
    expect(single.people).toBe(singleHr.people);
    expect(single.people).toBe(multi.people);
    expect(demoRoles(['payroll_manager', 'employee'], 'single')).toEqual(['employee']);
  }, 120000);
});
