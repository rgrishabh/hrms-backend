import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { inApp, flags, makeApp, ownerQuery, testCipher } from './helpers.js';
import { TEST_OWNER_URL } from './env.js';
import { createRng, insertOrganization, organizationFactory } from '../src/db/factories.js';
import { DEMO_HEADCOUNT, generateDemo } from '../src/db/demo.js';
import { CIN_RE, IFSC_RE, PAN_RE, TAN_RE, isValidGstin } from '../src/core/settings/india.js';
import { assignableRoles } from '../src/core/auth/permissions.js';

const today = '2026-11-05';
const MODES = ['single', 'single_hr', 'multi'] as const;

describe('factories, as data', () => {
  it('the same seed gives the same organization; another seed another', () => {
    const a = organizationFactory({ seed: 42, mode: 'multi', headcount: 100, today });
    expect(organizationFactory({ seed: 42, mode: 'multi', headcount: 100, today })).toEqual(a);
    const b = organizationFactory({ seed: 43, mode: 'multi', headcount: 100, today });
    expect(b.employees.map((e) => e.firstName + e.lastName)).not.toEqual(a.employees.map((e) => e.firstName + e.lastName));
    expect(createRng(1).next()).toBe(createRng(1).next());
  });

  it('uses no clock and no global randomness', () => {
    const source = readFileSync('src/db/factories.ts', 'utf8');
    for (const banned of ['Math.random', 'Date.now', 'new Date()', 'randomUUID', 'randomBytes']) expect(source, banned).not.toContain(banned);
  });

  it.each(MODES)('%s: exactly the count, the same people as any mode, and roles that exist in the mode', (mode) => {
    const o = organizationFactory({ seed: 7, mode, headcount: 100, today });
    expect(o.employees).toHaveLength(100);
    const roles = new Set(o.employees.flatMap((e) => e.roles));
    for (const r of roles) expect(assignableRoles(mode)).toContain(r);
    expect(roles.has(mode === 'multi' ? 'tenant_admin' : 'owner')).toBe(true);
    if (mode === 'single') expect([...roles].sort()).toEqual(['employee', 'owner']);
    if (mode === 'single_hr') expect([...roles].sort()).toEqual(['employee', 'hr_admin', 'hr_executive', 'owner']);
    const m = organizationFactory({ seed: 7, mode: 'multi', headcount: 100, today });
    const person = (e: (typeof o.employees)[number]) => `${e.code}|${e.firstName}|${e.lastName}|${e.dateOfJoining}|${e.basic}|${e.managerCode}`;
    expect(o.employees.map(person)).toEqual(m.employees.map(person));
  });

  it('the organization holds together', () => {
    const o = organizationFactory({ seed: 7, mode: 'multi', headcount: 100, today });
    const codes = new Set(o.employees.map((e) => e.code));
    expect(codes.size).toBe(100);
    expect(new Set(o.employees.map((e) => e.email)).size).toBe(100);
    expect(o.employees.filter((e) => !e.managerCode)).toHaveLength(1);
    for (const e of o.employees) if (e.managerCode) expect(codes.has(e.managerCode)).toBe(true);
    for (const e of o.employees) {
      expect(o.grades.map((g) => g.code)).toContain(e.grade);
      expect(o.designations.map((d) => d.name)).toContain(e.designation);
      expect(e.dateOfJoining <= today).toBe(true);
    }
    expect(new Set(o.employees.map((e) => e.department)).size).toBe(o.departments.length);
    expect(new Set(o.employees.map((e) => e.managerCode)).size).toBeGreaterThan(5);
  });

  it('invented registration numbers still pass the validators', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { company: c } = organizationFactory({ seed, mode: 'single', headcount: 20, today });
      expect(isValidGstin(c.gstin), c.gstin).toBe(true);
      expect(c.pan).toMatch(PAN_RE);
      expect(c.tan).toMatch(TAN_RE);
      expect(c.cin).toMatch(CIN_RE);
      expect(c.bankIfsc).toMatch(IFSC_RE);
      expect(c.gstin.slice(2, 12)).toBe(c.pan);
      expect(c.legalName).toMatch(/\(demo\)$/);
    }
  });
});

async function bareTenant() {
  const slug = 'f' + randomBytes(5).toString('hex');
  const [t] = await ownerQuery<{ id: string }>(`INSERT INTO tenants (slug, name) VALUES ($1,'Acme Real Client') RETURNING id`, [slug]);
  await ownerQuery(
    `INSERT INTO tenant_domains (tenant_id, hostname, verification_token, verification_status, verified_at, activation_status) VALUES ($1,$2,'x','verified',now(),'active')`,
    [t!.id, `${slug}.test`],
  );
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,'Admin','x') RETURNING id`, [
    t!.id,
    `a@${slug}.test`,
  ]);
  await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'tenant_admin')`, [u!.id, t!.id]);
  return t!.id;
}

describe('factories, written down', () => {
  let c: pg.Client;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: TEST_OWNER_URL });
    await c.connect();
  });
  afterAll(async () => {
    await c.end();
  });

  it.each(MODES)('%s: inserts the count, and the database reads back the same people from the same seed', async (mode) => {
    const read = async (tid: string) =>
      (
        await ownerQuery<{ s: string }>(
          `SELECT string_agg(employee_code||first_name||last_name||date_of_joining||coalesce(grade,'')||coalesce(designation,''), ',' ORDER BY employee_code) AS s, count(*) FILTER (WHERE user_id IS NOT NULL)::text AS logins FROM employees WHERE tenant_id=$1`,
          [tid],
        )
      )[0]!;
    const run = async () => {
      const tid = await bareTenant();
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.platform_bypass','on',true)`);
      const org = organizationFactory({ seed: 99, mode, headcount: 40, today, domain: `${tid}.test` });
      await insertOrganization(c, tid, org, { passwordHash: 'x', cipher: testCipher, payroll: true });
      await c.query('COMMIT');
      return tid;
    };
    const [a, b] = [await run(), await run()];
    expect((await ownerQuery<{ n: number }>(`SELECT count(*)::int AS n FROM employees WHERE tenant_id=$1`, [a]))[0]!.n).toBe(40);
    const norm = (x: string) => x;
    expect(norm((await read(a)).s)).toBe(norm((await read(b)).s));
    const [p] = await ownerQuery<{ pan_enc: string; pan_last4: string }>(`SELECT pan_enc, pan_last4 FROM company_profile WHERE tenant_id=$1`, [a]);
    expect(testCipher.decrypt(p!.pan_enc).slice(-4)).toBe(p!.pan_last4);
    expect(p!.pan_enc.startsWith('v2.')).toBe(true);
  });
});

describe('the demo dataset of about 100', () => {
  let apps: Record<string, FastifyInstance>;
  let c: pg.Client;
  const FLAGS = 'default,payroll,recruitment,assets';
  beforeAll(async () => {
    apps = {};
    for (const m of MODES) apps[m] = await makeApp({ ...flags(FLAGS), ORG_MANAGEMENT_MODE: m });
    c = new pg.Client({ connectionString: TEST_OWNER_URL });
    await c.connect();
  });
  afterAll(async () => {
    await c.end();
    for (const a of Object.values(apps)) await a.close();
  });

  it('the command line uses it', () => {
    expect(DEMO_HEADCOUNT).toBe(100);
  });

  const generate = async (mode: (typeof MODES)[number], flagApp = apps[mode]!) => {
    const tid = await bareTenant();
    await inApp(flagApp, () =>
      generateDemo(c, { password: 'Demo-Test-Password-1', today, tenantId: tid, features: flagApp.deps.env.enabledFeatures, mode, headcount: DEMO_HEADCOUNT, cipher: testCipher }),
    );
    return tid;
  };
  const people = async (tid: string) =>
    (
      await ownerQuery<{ s: string }>(
        `SELECT string_agg(employee_code||first_name||last_name||date_of_joining||coalesce(grade,'')||coalesce(designation,''), ',' ORDER BY employee_code) AS s FROM employees WHERE tenant_id=$1`,
        [tid],
      )
    )[0]!.s;

  it('in each mode: 100 people, the same people, with grades, managers, leave, attendance and payroll; no real client name', async () => {
    const seen: string[] = [];
    for (const mode of MODES) {
      const tid = await generate(mode);
      const [n] = await ownerQuery<Record<string, number>>(
        `SELECT (SELECT count(*)::int FROM employees WHERE tenant_id=$1) AS employees, (SELECT count(*)::int FROM employees WHERE tenant_id=$1 AND reporting_manager_id IS NOT NULL) AS managed,
        (SELECT count(*)::int FROM grades WHERE tenant_id=$1) AS grades, (SELECT count(*)::int FROM designations WHERE tenant_id=$1) AS designations, (SELECT count(*)::int FROM departments WHERE tenant_id=$1) AS departments,
        (SELECT count(*)::int FROM leave_requests WHERE tenant_id=$1) AS leave, (SELECT count(*)::int FROM attendance_daily WHERE tenant_id=$1) AS days, (SELECT count(*)::int FROM employee_salaries WHERE tenant_id=$1) AS salaries, (SELECT count(*)::int FROM statutory_rules WHERE tenant_id=$1) AS statutory`,
        [tid],
      );
      expect(n, mode).toMatchObject({ employees: 100, salaries: 100, statutory: 0, departments: 11 });
      expect(n!.managed).toBeGreaterThan(90);
      expect(n!.leave).toBeGreaterThan(10);
      expect(n!.days).toBeGreaterThan(1500);
      expect(n!.grades).toBeGreaterThan(3);
      expect(n!.designations).toBeGreaterThan(10);
      seen.push(await people(tid));
      const [le] = await ownerQuery<{ name: string }>(`SELECT name FROM legal_entities WHERE tenant_id=$1`, [tid]);
      expect(le!.name).toMatch(/\(demo\)$/);
      expect(le!.name).not.toContain('Acme');
      const [co] = await ownerQuery<{ bank_name: string | null }>(`SELECT bank_name FROM company_profile WHERE tenant_id=$1`, [tid]);
      expect(co!.bank_name).toMatch(/fictional/i);
      // Every title anyone holds is in the master.
      expect(
        (
          await ownerQuery(
            `SELECT 1 FROM employees e WHERE e.tenant_id=$1 AND e.designation IS NOT NULL AND NOT EXISTS (SELECT 1 FROM designations d WHERE d.tenant_id=$1 AND d.name=e.designation)`,
            [tid],
          )
        ).length,
      ).toBe(0);
      expect(
        (
          await ownerQuery(
            `SELECT 1 FROM employees e WHERE e.tenant_id=$1 AND e.grade IS NOT NULL AND NOT EXISTS (SELECT 1 FROM grades g WHERE g.tenant_id=$1 AND g.code=e.grade)`,
            [tid],
          )
        ).length,
      ).toBe(0);
    }
    expect(seen[0]).toBe(seen[1]);
    expect(seen[1]).toBe(seen[2]);
  }, 180000);

  it('run again from a clean organization it comes out the same', async () => {
    const [a, b] = [await people(await generate('single')), await people(await generate('single'))];
    expect(a).toBe(b);
  }, 120000);

  it('follows the flags: with payroll off, no salaries and no bank details', async () => {
    const off = await makeApp({ ...flags('default'), ORG_MANAGEMENT_MODE: 'multi' });
    const tid = await generate('multi', off);
    expect((await ownerQuery(`SELECT 1 FROM employee_salaries WHERE tenant_id=$1`, [tid])).length).toBe(0);
    const [co] = await ownerQuery<Record<string, unknown>>(`SELECT bank_account_enc, pf_registration, gstin FROM company_profile WHERE tenant_id=$1`, [tid]);
    expect(co).toMatchObject({ bank_account_enc: null, pf_registration: null });
    expect(co!.gstin).toBeTruthy();
    expect((await ownerQuery<{ n: number }>(`SELECT count(*)::int AS n FROM employees WHERE tenant_id=$1`, [tid]))[0]!.n).toBe(100);
    await off.close();
  }, 120000);
});
