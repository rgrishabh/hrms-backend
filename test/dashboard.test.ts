import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { makeApp, Client, ownerQuery, flags } from './helpers.js';
import { TEST_OWNER_URL } from './env.js';
import { generateDemo } from '../src/db/demo.js';
import { localDate } from '../src/modules/attendance/time.js';
import { recalculateRange, teamEmployeeIds } from '../src/modules/attendance/service.js';
import type { Db } from '../src/db/tx.js';

// A demo laboratory is the fixture; today's punches and one leave are added so "today" has data.
const MODULES = 'default,leave,payroll,expenses,training,lab.competency,recruitment';
const today = localDate(new Date(), 'Asia/Kolkata');
const password = 'Demo-Test-Password-1';
let app: FastifyInstance;
let tid: string;
let host: string;
const as: Record<string, Client> = {};
let team: string[] = [];
let leaver = '';
type Tile = { key: string; label: string; value: number | string; detail?: string; href?: string; tone?: string };
type Summary = { today: string; sections: { key: string; tiles: Tile[] }[]; lists: { key: string; items: { primary: string }[]; more?: number }[] };

const summary = async (who: string) => {
  const r = await as[who]!.get('/api/v1/dashboard');
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Summary;
};
const tile = (s: Summary, key: string) => s.sections.flatMap((x) => x.tiles).find((t) => t.key === key);
const section = (s: Summary, key: string) => s.sections.find((x) => x.key === key);

beforeAll(async () => {
  app = await makeApp({ ...flags(MODULES) });
  const slug = 'h' + randomBytes(5).toString('hex');
  host = `${slug}.test`;
  const [t] = await ownerQuery<{ id: string }>(`INSERT INTO tenants (slug, name) VALUES ($1,'Dash Labs') RETURNING id`, [slug]);
  tid = t!.id;
  await ownerQuery(`INSERT INTO tenant_branding (tenant_id, display_name) VALUES ($1,'Dash Labs')`, [tid]);
  await ownerQuery(
    `INSERT INTO tenant_domains (tenant_id, hostname, verification_token, verification_status, verified_at, activation_status) VALUES ($1,$2,'x','verified',now(),'active')`,
    [tid, host],
  );
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,'Admin','x') RETURNING id`, [tid, `admin@${host}`]);
  await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'tenant_admin')`, [u!.id, tid]);
  const c = new pg.Client({ connectionString: TEST_OWNER_URL });
  await c.connect();
  try {
    await generateDemo(c, { password, today, tenantId: tid, features: app.deps.env.enabledFeatures });
    const [mgr] = await ownerQuery<{ id: string }>(`SELECT e.id FROM employees e JOIN users u ON u.id=e.user_id WHERE e.tenant_id=$1 AND u.email=$2`, [tid, `lab.manager@${host}`]);
    team = await teamEmployeeIds(c as unknown as Db, tid, mgr!.id);
    const members = await ownerQuery<{ id: string; code: string }>(
      `SELECT id, employee_code AS code FROM employees WHERE id = ANY($1) AND status IN ('active','on_notice') AND date_of_joining < $2 ORDER BY employee_code`,
      [team, today],
    );
    // two team members clocked in this morning
    for (const m of members.slice(0, 2)) {
      await ownerQuery(`INSERT INTO attendance_events (tenant_id, employee_id, source, source_ref, event_time, direction) VALUES ($1,$2,'web',$3,$4,'in')`, [
        tid,
        m.id,
        `t-${m.code}`,
        `${today}T03:50:00Z`,
      ]);
      await recalculateRange(c as unknown as Db, tid, m.id, today, today);
    }
    // a third is on approved leave today
    leaver = members[2]!.id;
    const [lt] = await ownerQuery<{ id: string; year: number }>(
      `SELECT t.id, (SELECT max(leave_year) FROM leave_ledger WHERE tenant_id=$1)::int AS year FROM leave_types t WHERE t.tenant_id=$1 AND t.code='CL'`,
      [tid],
    );
    await ownerQuery(`DELETE FROM leave_requests WHERE tenant_id=$1 AND employee_id=$2 AND end_date >= $3`, [tid, leaver, today]);
    await ownerQuery(
      `INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id, leave_year, start_date, end_date, days, reason, status, requested_by)
      VALUES ($1,$2,$3,$4,$5,$5,1,'Family function','approved',(SELECT id FROM users WHERE email=$6))`,
      [tid, leaver, lt!.id, lt!.year, today, `hr.head@${host}`],
    );
  } finally {
    await c.end();
  }
  for (const p of ['hr.head', 'lab.manager', 'finance', 'analyst', 'quality', 'payroll']) as[p] = await Client.login(app, host, `${p}@${host}`, password);
}, 120_000);
afterAll(async () => {
  await app.close();
});

describe('dashboard', () => {
  it('HR sees organization numbers that match the records', async () => {
    const s = await summary('hr.head');
    const [{ n }] = (await ownerQuery<{ n: number }>(`SELECT count(*)::int AS n FROM employees WHERE tenant_id=$1 AND status IN ('active','on_notice') AND date_of_joining <= $2`, [
      tid,
      today,
    ])) as [{ n: number }];
    expect(tile(s, 'headcount')).toMatchObject({ value: n, href: '/reports?r=headcount' });
    expect(tile(s, 'org_in')).toMatchObject({ value: 2, detail: `of ${n}` });
    const onLeave = tile(s, 'org_leave')!.value as number;
    expect(onLeave).toBeGreaterThanOrEqual(1);
    const list = s.lists.find((l) => l.key === 'on_leave_today')!;
    expect(list.items.length + (list.more ?? 0)).toBe(onLeave);
    // the identity: everyone expected today is clocked in, on leave, off, or not yet in
    expect(tile(s, 'org_not_in')!.value as number).toBeLessThanOrEqual(n - 2 - onLeave);
    expect(section(s, 'team')).toBeUndefined(); // organization-wide access replaces the team view
    expect(tile(s, 'joined')!.href).toContain('/reports?r=joiners_leavers');
  });

  it('a laboratory manager sees only their reporting team', async () => {
    const s = await summary('lab.manager');
    expect(section(s, 'org')).toBeUndefined();
    expect(tile(s, 'headcount')).toBeUndefined();
    expect(tile(s, 'team_size')!.value).toBe((await ownerQuery(`SELECT 1 FROM employees WHERE id = ANY($1) AND status IN ('active','on_notice')`, [team])).length);
    expect(tile(s, 'team_in')!.value).toBe(2);
    expect(tile(s, 'team_leave')!.value).toBeGreaterThanOrEqual(1);
    const list = s.lists.find((l) => l.key === 'on_leave_today')!;
    const [{ name }] = (await ownerQuery<{ name: string }>(`SELECT trim(first_name||' '||coalesce(last_name,'')) AS name FROM employees WHERE id=$1`, [leaver])) as [
      { name: string },
    ];
    expect(list.items.map((i) => i.primary)).toContain(name);
    // nobody outside the team appears in the list
    const outside = await ownerQuery<{ name: string }>(
      `SELECT DISTINCT trim(e.first_name||' '||coalesce(e.last_name,'')) AS name FROM leave_requests r JOIN employees e ON e.id=r.employee_id
      WHERE r.tenant_id=$1 AND r.status='approved' AND r.start_date <= $2 AND r.end_date >= $2 AND NOT (e.id = ANY($3))`,
      [tid, today, team],
    );
    for (const o of outside) expect(list.items.map((i) => i.primary)).not.toContain(o.name);
    // training and authorization tiles follow competency.read (laboratory managers have it)
    expect(section(s, 'me')!.tiles.some((t) => t.key.startsWith('leave_'))).toBe(true);
  });

  it('an employee sees only their own leave and nothing about others', async () => {
    const s = await summary('analyst');
    expect(s.sections.map((x) => x.key)).toEqual(['me']);
    const cl = tile(s, 'leave_CL')!;
    const bal = (await as.analyst!.get('/api/v1/leave/balances')).json().items.find((i: { code: string }) => i.code === 'CL');
    expect(cl.value).toBe(Number(bal.available));
    expect(s.lists.find((l) => l.key === 'on_leave_today')).toBeUndefined();
    const hol = s.lists.find((l) => l.key === 'holidays');
    if (hol) for (const h of hol.items as { date?: string }[]) expect(h.date! >= today).toBe(true);
  });

  it('finance sees approved claims waiting for reimbursement; payroll sees the latest run', async () => {
    const before = tile(await summary('finance'), 'expenses_to_pay');
    const [claim] = await ownerQuery<{ id: string; total: string }>(
      `SELECT id, total::text FROM expense_claims WHERE tenant_id=$1 AND status='submitted' ORDER BY created_at LIMIT 1`,
      [tid],
    );
    if (claim) await ownerQuery(`UPDATE expense_claims SET status='approved', approved_at=now() WHERE id=$1`, [claim.id]);
    const [{ n, amount }] = (await ownerQuery<{ n: number; amount: string }>(
      `SELECT count(*)::int AS n, coalesce(sum(total),0)::text AS amount FROM expense_claims WHERE tenant_id=$1 AND status='approved' AND batch_id IS NULL`,
      [tid],
    )) as [{ n: number; amount: string }];
    const after = tile(await summary('finance'), 'expenses_to_pay');
    if (n) expect(after).toMatchObject({ value: n, href: '/expenses?tab=finance', detail: `₹${Number(amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` });
    else expect(after).toBeUndefined();
    void before;
    // HR lacks expenses.pay
    expect(tile(await summary('hr.head'), 'expenses_to_pay')).toBeUndefined();
    expect(tile(await summary('payroll'), 'payroll')).toBeUndefined(); // the demo has no payroll runs
    // Latest period with an approved run and a draft full-and-final run: the tile shows the one furthest behind.
    const [le] = await ownerQuery<{ id: string }>(`SELECT id FROM legal_entities WHERE tenant_id=$1 LIMIT 1`, [tid]);
    const [emp] = await ownerQuery<{ id: string }>(`SELECT id FROM employees WHERE tenant_id=$1 LIMIT 1`, [tid]);
    const by = `(SELECT id FROM users WHERE email='payroll@${host}')`;
    await ownerQuery(
      `INSERT INTO payroll_runs (tenant_id, legal_entity_id, period, status, created_by) VALUES ($1,$2,'2026-09','paid',${by}), ($1,$2,'2026-10','approved',${by})`,
      [tid, le!.id],
    );
    await ownerQuery(`INSERT INTO payroll_runs (tenant_id, legal_entity_id, period, kind, employee_id, status, created_by) VALUES ($1,$2,'2026-10','fnf',$3,'draft',${by})`, [
      tid,
      le!.id,
      emp!.id,
    ]);
    expect(tile(await summary('payroll'), 'payroll')).toMatchObject({ label: 'Payroll · Oct 2026', value: 'Draft', detail: '2 runs', href: '/payroll', tone: 'warn' });
    expect(tile(await summary('analyst'), 'payroll')).toBeUndefined();
  });

  it('flags expired training and overdue authorization reviews for quality', async () => {
    const [emp] = await ownerQuery<{ id: string }>(`SELECT employee_id AS id FROM training_records WHERE tenant_id=$1 AND status='active' LIMIT 1`, [tid]);
    await ownerQuery(`UPDATE training_records SET expires_on=$3::date - 5 WHERE tenant_id=$1 AND employee_id=$2 AND status='active'`, [tid, emp!.id, today]);
    const s = await summary('quality');
    const t = tile(s, 'training_expiry')!;
    expect(t.tone).toBe('bad');
    expect(t.href).toBe('/reports?r=training_expiry&withinDays=30');
    // the tile agrees with the report it links to
    const report = (await as.quality!.get('/api/v1/reports/training_expiry?withinDays=30')).json();
    expect(t.value).toBe(report.rows.length);
    const ar = tile(s, 'authorization_reviews');
    if (ar) {
      const rep = (await as.quality!.get('/api/v1/reports/authorization_reviews?withinDays=30')).json();
      expect(ar.value).toBe(rep.rows.length);
    }
    expect(tile(await summary('analyst'), 'training_expiry')).toBeUndefined();
  });

  it('an administrator without an employee record still gets a dashboard', async () => {
    await ownerQuery(`UPDATE users SET password_hash=(SELECT password_hash FROM users WHERE email=$2) WHERE email=$1`, [`admin@${host}`, `analyst@${host}`]);
    const admin = await Client.login(app, host, `admin@${host}`, password);
    const r = await admin.get('/api/v1/dashboard');
    expect(r.statusCode).toBe(200);
    expect(r.json().sections.find((x: { key: string }) => x.key === 'me')).toBeUndefined();
  });

  it('requires a session', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/dashboard', headers: { host } });
    expect(r.statusCode).toBe(401);
  });
});
