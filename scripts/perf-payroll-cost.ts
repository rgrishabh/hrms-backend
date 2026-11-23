/**
 * Measures the payroll_cost report on a seeded dataset: 1,000 employees, 12 paid monthly runs (12,000 payroll items).
 * It drops and recreates the schema of the database it is given, so point it at a scratch database only.
 *
 *   PERF_OWNER_URL=postgres://... PERF_APP_URL=postgres://... npx tsx scripts/perf-payroll-cost.ts
 */
import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db/pool.js';
import { FieldCipher, hashPassword } from '../src/core/crypto/index.js';
import { loadEnv } from '../src/config/env.js';
import { TEST_BRAND } from '../test/env.js';

const OWNER = process.env.PERF_OWNER_URL;
const APP = process.env.PERF_APP_URL;
if (!OWNER || !APP) throw new Error('PERF_OWNER_URL and PERF_APP_URL are required');
const KEY = Buffer.alloc(32, 7).toString('base64');
const EMPLOYEES = Number(process.env.PERF_EMPLOYEES ?? 1000);
const MONTHS = 12;
const RUNS = 7;

const c = new pg.Client({ connectionString: OWNER });
await c.connect();
await c.query('DROP SCHEMA IF EXISTS public CASCADE');
await c.query('CREATE SCHEMA public');
await migrate(OWNER, () => undefined);
await c.query(`SELECT set_config('app.platform_bypass','on',false)`);
const host = 'perf.test';
const one = async (sql: string, p: unknown[] = []) => (await c.query<{ id: string }>(sql, p)).rows[0]!.id;
const t = await one(`INSERT INTO tenants (slug, name) VALUES ('perf','Perf') RETURNING id`);
await c.query(`INSERT INTO tenant_branding (tenant_id, display_name) VALUES ($1,'Perf')`, [t]);
await c.query(
  `INSERT INTO tenant_domains (tenant_id, hostname, verification_token, verification_status, verified_at, activation_status) VALUES ($1,$2,'x','verified',now(),'active')`,
  [t, host],
);
const le = await one(`INSERT INTO legal_entities (tenant_id, name) VALUES ($1,'LE') RETURNING id`, [t]);
const br = await one(`INSERT INTO branches (tenant_id, legal_entity_id, code, name, state) VALUES ($1,$2,'HQ','HQ','Maharashtra') RETURNING id`, [t, le]);
const PASSWORD = 'Perf-Password-123!';
const u = await one(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,'p@perf.test','P',$2) RETURNING id`, [t, await hashPassword(PASSWORD)]);
await c.query(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'payroll_manager')`, [u, t]);
for (let d = 0; d < 10; d++) await c.query(`INSERT INTO departments (tenant_id, code, name) VALUES ($1,$2,$3)`, [t, `D${d}`, `Department ${d}`]);
await c.query(
  `INSERT INTO employees (tenant_id, employee_code, first_name, last_name, legal_entity_id, branch_id, department_id, date_of_joining)
  SELECT $1, 'E'||g, 'Emp', 'N'||g, $2, $3, (SELECT id FROM departments WHERE tenant_id=$1 AND code='D'||(g%10)), '2020-01-01' FROM generate_series(1,$4::int) g`,
  [t, le, br, EMPLOYEES],
);
const encrypted = (await c.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payroll_items' AND column_name='data_enc'`)).rowCount === 1;
const cipher = new FieldCipher(KEY);
const emps = (await c.query<{ id: string; n: number }>(`SELECT id, row_number() OVER (ORDER BY employee_code)::int AS n FROM employees WHERE tenant_id=$1`, [t])).rows;
const seeded = Date.now();
for (let m = 0; m < MONTHS; m++) {
  const period = `2025-${String(m + 1).padStart(2, '0')}`;
  const run = await one(`INSERT INTO payroll_runs (tenant_id, legal_entity_id, period, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [t, le, period, u]);
  const vals = emps.map((e) => {
    const gross = 30000 + (e.n % 500) * 100;
    const ded = Math.round(gross * 0.12);
    const net = gross - ded;
    const cost = Math.round(gross * 1.13);
    const lines = [
      { code: 'BASIC', name: 'Basic', kind: 'earning', amount: gross },
      { code: 'PF_EE', name: 'PF', kind: 'deduction', amount: ded },
      { code: 'PF_EPF_ER', name: 'PF ER', kind: 'employer', amount: cost - gross },
    ];
    return { e: e.id, lop: e.n % 7 === 0 ? 1 : 0, lines, gross, ded, net, cost };
  });
  for (let i = 0; i < vals.length; i += 500) {
    const batch = vals.slice(i, i + 500);
    if (encrypted) {
      await c.query(
        `INSERT INTO payroll_items (tenant_id, run_id, employee_id, days_in_period, employed_days, lop_days, paid_days, data_enc, calc_version)
        SELECT $1,$2,x.e,30,30,x.l,30-x.l,x.d,6 FROM unnest($3::uuid[],$4::numeric[],$5::text[]) AS x(e,l,d)`,
        [
          t,
          run,
          batch.map((v) => v.e),
          batch.map((v) => v.lop),
          batch.map((v) => cipher.encrypt(JSON.stringify({ lines: v.lines, gross: v.gross, deductions: v.ded, net: v.net, employerCost: v.cost, warnings: [] }))),
        ],
      );
    } else {
      await c.query(
        `INSERT INTO payroll_items (tenant_id, run_id, employee_id, days_in_period, employed_days, lop_days, paid_days, lines, gross, deductions, net, employer_cost, calc_version)
        SELECT $1,$2,x.e,30,30,x.l,30-x.l,x.j::jsonb,x.g,x.d,x.n,x.c,6 FROM unnest($3::uuid[],$4::numeric[],$5::text[],$6::numeric[],$7::numeric[],$8::numeric[],$9::numeric[]) AS x(e,l,j,g,d,n,c)`,
        [
          t,
          run,
          batch.map((v) => v.e),
          batch.map((v) => v.lop),
          batch.map((v) => JSON.stringify(v.lines)),
          batch.map((v) => v.gross),
          batch.map((v) => v.ded),
          batch.map((v) => v.net),
          batch.map((v) => v.cost),
        ],
      );
    }
  }
  await c.query(`UPDATE payroll_runs SET status='paid', computed_at=now(), finalized_at=now(), paid_at=now() WHERE id=$1`, [run]);
}
await c.query('ANALYZE');
await c.end();
const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: APP,
  COOKIE_SECURE: 'false',
  ...TEST_BRAND,
  BRAND_DOMAIN: host,
  FEATURE_ATTENDANCE: 'true',
  FEATURE_PAYROLL: 'true',
  DATA_ENCRYPTION_KEY: KEY,
  SESSION_TTL_HOURS: '24',
  AUTH_RATE_LIMIT_PER_MINUTE: '10000',
  AUTH_ACCOUNT_RATE_LIMIT_PER_MINUTE: '10000',
  RATE_LIMIT_PER_MINUTE: '100000',
});
const pool = createPool(env.DATABASE_URL, 5);
const app = await buildApp({ env, pool, cipher });
const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'p@perf.test', password: PASSWORD }, headers: { host } });
if (login.statusCode !== 200) throw new Error(login.body);
const set = login.headers['set-cookie'];
const cookie = (Array.isArray(set) ? set[0]! : set!).split(';')[0]!;
const out: Record<string, unknown> = { encrypted, items: EMPLOYEES * MONTHS, seedSeconds: (Date.now() - seeded) / 1000 };
for (const groupBy of ['period', 'department']) {
  const url = `/api/v1/reports/payroll_cost?from=2025-01&to=2025-12&groupBy=${groupBy}&reveal=1`;
  const times: number[] = [];
  let last = '';
  for (let i = 0; i < RUNS; i++) {
    const s = performance.now();
    const r = await app.inject({ method: 'GET', url, headers: { host, cookie } });
    times.push(performance.now() - s);
    if (r.statusCode !== 200) throw new Error(r.body);
    last = r.body;
  }
  times.sort((a, b) => a - b);
  const totals = (JSON.parse(last) as { totals: Record<string, unknown> }).totals;
  out[groupBy] = {
    medianMs: Math.round(times[RUNS >> 1]! * 10) / 10,
    minMs: Math.round(times[0]! * 10) / 10,
    maxMs: Math.round(times[RUNS - 1]! * 10) / 10,
    gross: totals.gross,
    net: totals.net,
  };
}
process.stdout.write(`${JSON.stringify(out)}\n`);
await app.close();
await pool.end();
process.exit(0);
