import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { makeApp, Client, ownerQuery, flags, seal } from './helpers.js';
import { readXlsx } from './helpers.js';
import { TEST_OWNER_URL } from './env.js';
import { generateDemo } from '../src/db/demo.js';
import { addDays, localDate } from '../src/modules/attendance/time.js';
import { addMonths } from '../src/modules/reports/registry.js';

// A demo laboratory (63 employees, 30 days of attendance, leave, training…) is the fixture.
const MODULES = 'default,leave,payroll,expenses,training,lab.competency';
const today = localDate(new Date(), 'Asia/Kolkata');
const password = 'Demo-Test-Password-1';
let app: FastifyInstance; let tid: string; let host: string;
const as: Record<string, Client> = {};
type Report = { columns: { key: string; type: string }[]; rows: Record<string, unknown>[]; totals: Record<string, unknown> | null; notes: string[]; scope: string };

beforeAll(async () => {
  app = await makeApp({ ...flags(MODULES) });
  const slug = 'r' + randomBytes(5).toString('hex');
  host = `${slug}.test`;
  const [t] = await ownerQuery<{ id: string }>(`INSERT INTO tenants (slug, name) VALUES ($1,'Report Labs') RETURNING id`, [slug]);
  tid = t!.id;
  await ownerQuery(`INSERT INTO tenant_branding (tenant_id, display_name) VALUES ($1,'Report Labs')`, [tid]);
  await ownerQuery(`INSERT INTO tenant_domains (tenant_id, hostname, verification_token, verification_status, verified_at, activation_status) VALUES ($1,$2,'x','verified',now(),'active')`, [tid, host]);
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,'Admin','x') RETURNING id`, [tid, `admin@${host}`]);
  await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'tenant_admin')`, [u!.id, tid]);
  const c = new pg.Client({ connectionString: TEST_OWNER_URL });
  await c.connect();
  try { await generateDemo(c, { password, today, tenantId: tid, features: app.deps.env.enabledFeatures }); } finally { await c.end(); }
  for (const p of ['hr.head', 'lab.manager', 'director', 'payroll', 'finance', 'analyst', 'quality']) as[p] = await Client.login(app, host, `${p}@${host}`, password);
}, 120_000);
afterAll(async () => { await app.close(); });

const run = async (who: string, key: string, q = '') => {
  const r = await as[who]!.get(`/api/v1/reports/${key}?reveal=1${q ? `&${q}` : ''}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Report;
};

describe('reports', () => {
  it('lists only the reports each role may run, with their scope', async () => {
    const keys = async (who: string) => Object.fromEntries(((await as[who]!.get('/api/v1/reports')).json().items as { key: string; scope: string }[]).map((i) => [i.key, i.scope]));
    expect(await keys('hr.head')).toMatchObject({ headcount: 'all', attrition: 'all', attendance_summary: 'all', leave_taken: 'all', leave_balances: 'all', payroll_cost: 'all', training_expiry: 'all', authorization_reviews: 'all' });
    expect(await keys('hr.head')).not.toHaveProperty('expenses');
    expect(await keys('lab.manager')).toEqual({ attendance_summary: 'team', leave_taken: 'team', leave_balances: 'team', training_expiry: 'all', authorization_reviews: 'all' });
    expect(await keys('finance')).toEqual({ payroll_cost: 'all', expenses: 'all' });
    expect(await keys('analyst')).toEqual({});
    expect((await as.analyst!.get('/api/v1/reports/headcount')).statusCode).toBe(403);
    expect((await as.finance!.get('/api/v1/reports/headcount')).statusCode).toBe(403);
    expect((await as['hr.head']!.get('/api/v1/reports/nope')).statusCode).toBe(404);
  });

  it('headcount matches the employee records, by every grouping', async () => {
    const [{ n }] = (await ownerQuery<{ n: number }>(`SELECT count(*)::int AS n FROM employees WHERE tenant_id=$1 AND status IN ('active','on_notice') AND date_of_joining <= $2`, [tid, today])) as [{ n: number }];
    for (const g of ['department', 'branch', 'legal_entity', 'employment_type', 'grade', 'designation']) {
      const r = await run('hr.head', 'headcount', `groupBy=${g}`);
      expect(r.totals!.headcount).toBe(n);
      expect(r.rows.reduce((s, x) => s + (x.headcount as number), 0)).toBe(n);
    }
    const byType = await run('hr.head', 'headcount', 'groupBy=employment_type');
    expect(byType.rows.map((x) => x.grp)).toContain('Permanent');
    // Before anyone joined: nobody.
    expect((await run('hr.head', 'headcount', 'asOf=2000-01-01')).rows).toEqual([]);
  });

  it('attrition: closing = opening + joiners − leavers, and leavers appear in the movements list', async () => {
    const [x] = await ownerQuery<{ id: string; employee_code: string }>(`SELECT id, employee_code FROM employees WHERE tenant_id=$1 AND status='active' AND user_id IS NULL AND date_of_joining < $2 ORDER BY employee_code DESC LIMIT 1`, [tid, addDays(today, -60)]);
    await ownerQuery(`UPDATE employees SET status='exited', exit_date=$3 WHERE tenant_id=$1 AND id=$2`, [tid, x!.id, addDays(today, -5)]);
    const from = addDays(today, -40);
    const r = await run('hr.head', 'attrition', `from=${from}&to=${today}`);
    for (const row of [...r.rows, r.totals!]) expect(row.closing).toBe((row.opening as number) + (row.joiners as number) - (row.leavers as number));
    expect(r.totals!.leavers).toBeGreaterThanOrEqual(1);
    expect(r.totals!.attrition).toBeGreaterThan(0);
    const m = await run('hr.head', 'joiners_leavers', `from=${from}&to=${today}&event=left`);
    expect(m.rows.find((row) => row.employee_code === x!.employee_code)).toMatchObject({ event: 'Left', date: addDays(today, -5) });
    expect(m.columns.map((c) => c.key)).toContain('separation'); // HR (lifecycle.read) sees the separation type
  });

  it('attendance: managers see only their reporting team; HR sees everyone', async () => {
    const from = addDays(today, -20); const to = addDays(today, -1);
    const all = await run('hr.head', 'attendance_summary', `from=${from}&to=${to}`);
    const team = await run('lab.manager', 'attendance_summary', `from=${from}&to=${to}`);
    expect(team.scope).toBe('team');
    expect(team.notes[0]).toMatch(/reporting team/);
    const [{ n }] = (await ownerQuery<{ n: number }>(`SELECT count(DISTINCT ad.employee_id)::int AS n FROM attendance_daily ad JOIN employees e ON e.tenant_id=ad.tenant_id AND e.id=ad.employee_id
      JOIN employees m ON m.tenant_id=e.tenant_id AND m.id=e.reporting_manager_id JOIN users u ON u.id=m.user_id
      WHERE ad.tenant_id=$1 AND u.email=$2 AND ad.work_date BETWEEN $3 AND $4`, [tid, `lab.manager@${host}`, from, to])) as [{ n: number }];
    expect(team.rows.length).toBe(n);
    expect(team.rows.length).toBeGreaterThan(0);
    expect(team.rows.length).toBeLessThan(all.rows.length);
    expect(team.rows.every((row) => row.department === 'Water & Wastewater')).toBe(true);
    const t = all.totals!;
    expect(t.present).toBe(all.rows.reduce((s, row) => s + (row.present as number), 0));
    expect(t.attendance_pct).toBeGreaterThan(50);
    expect(t.attendance_pct).toBeLessThanOrEqual(100);
    const dept = await run('hr.head', 'attendance_summary', `from=${from}&to=${to}&groupBy=department`);
    expect(dept.totals!.working).toBe(t.working);
    expect(dept.totals!.employees).toBe(all.rows.length);
  });

  it('leave taken adds up the same way by employee, department and leave type; balances match the ledger', async () => {
    const from = addDays(today, -60);
    const byEmp = await run('hr.head', 'leave_taken', `from=${from}&to=${today}`);
    const byDept = await run('hr.head', 'leave_taken', `from=${from}&to=${today}&groupBy=department`);
    const byType = await run('hr.head', 'leave_taken', `from=${from}&to=${today}&groupBy=leave_type`);
    expect(byType.totals!.days).toBeGreaterThan(0);
    expect(byEmp.totals!.total).toBeCloseTo(byType.totals!.days as number, 0);
    expect(byDept.totals!.total).toBeCloseTo(byEmp.totals!.total as number, 1);
    const cat = (await as['lab.manager']!.get('/api/v1/reports')).json().items as { key: string; params: { key: string; default: number }[] }[];
    const year = cat.find((i) => i.key === 'leave_balances')!.params[0]!.default;
    const bal = await run('lab.manager', 'leave_balances');
    const analyst = bal.rows.find((r) => r.name === 'Aditya Joshi')!;
    const [{ days }] = (await ownerQuery<{ days: string }>(`SELECT coalesce(sum(l.days),0) AS days FROM leave_ledger l JOIN leave_types t ON t.id=l.leave_type_id
      JOIN employees e ON e.id=l.employee_id WHERE l.tenant_id=$1 AND t.code='CL' AND e.first_name='Aditya' AND e.last_name='Joshi' AND l.leave_year=$2`, [tid, year])) as [{ days: string }];
    expect(analyst.t_CL).toBe(Number(days));
    expect(bal.rows.every((r) => r.department === 'Water & Wastewater')).toBe(true);
  });

  it('payroll cost totals approved runs only', async () => {
    const [run1] = await ownerQuery<{ id: string }>(`INSERT INTO payroll_runs (tenant_id, legal_entity_id, period, status, created_by)
      SELECT $1, le.id, $2, 'computed', (SELECT id FROM users WHERE tenant_id=$1 LIMIT 1) FROM legal_entities le WHERE le.tenant_id=$1 LIMIT 1 RETURNING id`, [tid, addMonths(today.slice(0, 7), -1)]);
    const [draft] = await ownerQuery<{ id: string }>(`INSERT INTO payroll_runs (tenant_id, legal_entity_id, period, status, created_by)
      SELECT $1, le.id, $2, 'computed', (SELECT id FROM users WHERE tenant_id=$1 LIMIT 1) FROM legal_entities le WHERE le.tenant_id=$1 LIMIT 1 RETURNING id`, [tid, today.slice(0, 7)]);
    for (const [rid, k] of [[run1!.id, 1], [draft!.id, 100]] as const) {
      await ownerQuery(`INSERT INTO payroll_items (tenant_id, run_id, employee_id, days_in_period, employed_days, lop_days, paid_days, data_enc, calc_version)
        SELECT $1, $2, id, 30, 30, 1, 29, $3, 1 FROM employees WHERE tenant_id=$1 AND status='active' AND user_id IS NULL ORDER BY employee_code LIMIT 3`,
        [tid, rid, seal({ lines: [], gross: 30000 * k, deductions: 2000 * k, net: 28000 * k, employerCost: 31800 * k, warnings: [] })]);
    }
    await ownerQuery(`UPDATE payroll_runs SET status='finalized', finalized_at=now() WHERE id=$1`, [run1!.id]);
    const r = await run('payroll', 'payroll_cost');
    expect(r.rows).toHaveLength(1);
    expect(r.totals).toMatchObject({ employees: 3, gross: 90000, deductions: 6000, net: 84000, employer_cost: 95400, lop_days: 3 });
    const csv = await as.payroll!.get('/api/v1/reports/payroll_cost/export.csv');
    expect(csv.body).toContain('Total,3,90000.00,6000.00,84000.00,95400.00,3');
    // The same report as Excel: numbers stay numbers, totals bold (money style 7).
    const x = await as.payroll!.get('/api/v1/reports/payroll_cost/export.xlsx');
    expect(x.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(x.headers['content-disposition']).toMatch(/payroll_cost-\d{4}-\d{2}-\d{2}\.xlsx/);
    const sheet = readXlsx(x.rawPayload)['xl/worksheets/sheet1.xml']!;
    expect(sheet).toContain('<t xml:space="preserve">Total</t>');
    expect(sheet).toMatch(/s="7"><v>90000<\/v>/);
    expect(readXlsx(x.rawPayload)['xl/workbook.xml']).toContain('name="Payroll cost"');
    expect((await run('payroll', 'payroll_cost', 'groupBy=department')).totals!.net).toBe(84000);
  });

  it('expenses by category for approved claims', async () => {
    await ownerQuery(`UPDATE expense_claims c SET status='approved', submitted_at=now(), approved_at=now() FROM employees e
      WHERE c.tenant_id=$1 AND e.id=c.employee_id AND e.first_name='Pooja'`, [tid]);
    const r = await run('finance', 'expenses');
    expect(r.totals).toMatchObject({ claims: 1, items: 2, amount: 960 });
    expect(r.rows.map((x) => x.grp).sort()).toEqual(['Local travel', 'Meals']);
    expect((await run('finance', 'expenses', 'status=pending')).rows).toEqual([]);
    const byEmp = await run('finance', 'expenses', 'groupBy=employee');
    expect(byEmp.rows[0]).toMatchObject({ name: 'Pooja Yadav', amount: 960 });
  });

  it('training and authorization due lists stay within the window and are sorted', async () => {
    for (const key of ['training_expiry', 'authorization_reviews']) {
      const r = await run('quality', key, 'withinDays=365');
      const days = r.rows.map((x) => x.days_left as number);
      expect(days.every((d) => d <= 365)).toBe(true);
      expect([...days].sort((a, b) => a - b)).toEqual(days);
      const expired = await run('quality', key, 'withinDays=365&show=expired');
      expect(expired.rows.every((x) => (x.days_left as number) < 0)).toBe(true);
    }
    expect((await run('quality', 'training_expiry', 'withinDays=365')).rows.length).toBeGreaterThan(0);
  });

  it('validates parameters', async () => {
    const hr = as['hr.head']!;
    expect((await hr.get(`/api/v1/reports/attrition?from=${today}&to=${addDays(today, -1)}`)).statusCode).toBe(400);
    expect((await hr.get('/api/v1/reports/attendance_summary?from=2020-01-01&to=2024-01-01')).statusCode).toBe(400);
    expect((await hr.get('/api/v1/reports/headcount?groupBy=salary')).statusCode).toBe(400);
    expect((await hr.get('/api/v1/reports/headcount?asOf=2024-02-30')).statusCode).toBe(400);
    expect((await hr.get('/api/v1/reports/payroll_cost?from=2024-13')).statusCode).toBe(400);
  });

  it('CSV export neutralizes formulas and is audited', async () => {
    await ownerQuery(`UPDATE employees SET designation='=HYPERLINK("http://x","y")' WHERE tenant_id=$1 AND employee_code=(SELECT min(employee_code) FROM employees WHERE tenant_id=$1 AND status='active')`, [tid]);
    const r = await as['hr.head']!.get('/api/v1/reports/headcount/export.csv?groupBy=designation');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['cache-control']).toMatch(/no-store/);
    expect(r.body).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(r.body.split('\r\n')[0]).toContain('Designation,Headcount');
    const [log] = await ownerQuery<{ target_id: string; change_metadata: { params: { groupBy: string } } }>(`SELECT target_id, change_metadata FROM audit_logs WHERE tenant_id=$1 AND action='reports.exported' ORDER BY created_at DESC LIMIT 1`, [tid]);
    expect(log).toMatchObject({ target_id: 'headcount', change_metadata: { params: { groupBy: 'designation' } } });
  });
  // Last: the enabled-module list is process-wide, so a second app changes it for the rest of the file.
  it('hides reports whose module is not enabled for the installation', async () => {
    const app2 = await makeApp({ ...flags('default,leave') });
    try {
      const hr = await Client.login(app2, host, `hr.head@${host}`, password);
      const keys = ((await hr.get('/api/v1/reports')).json().items as { key: string }[]).map((i) => i.key);
      expect(keys).toContain('headcount');
      expect(keys).not.toContain('payroll_cost');
      expect((await hr.get('/api/v1/reports/payroll_cost')).statusCode).toBe(404);
    } finally { await app2.close(); }
  });
});
