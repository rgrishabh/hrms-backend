/**
 * Fills a dedicated database for the k6 scripts: migrate, one organization on the host `load.test`, the demo at LOAD_EMPLOYEES people, a login and a ready session for each
 * active employee, and those sessions in load/.sessions.json (git-ignored). Refuses anything but a database named hrms_load.
 *
 *   DATABASE_MIGRATION_URL=postgres://hrms_owner:...@127.0.0.1:55432/hrms_load LOAD_EMPLOYEES=1000 DATA_ENCRYPTION_KEY=... npx tsx load/seed.ts
 */
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { generateDemo } from '../src/db/demo.js';
import { FieldCipher, hashPassword, randomToken, sha256 } from '../src/core/crypto/index.js';
import { deriveCsrf } from '../src/core/auth/session.js';
import { FEATURES } from '../src/core/features/registry.js';

const url = process.env.DATABASE_MIGRATION_URL;
if (!url || new URL(url).pathname !== '/hrms_load') throw new Error('DATABASE_MIGRATION_URL must point at a database named hrms_load');
const headcount = Number(process.env.LOAD_EMPLOYEES ?? 1000);
const key = process.env.DATA_ENCRYPTION_KEY;
if (!key) throw new Error('DATA_ENCRYPTION_KEY is required');
const password = 'Load-Test-Password-only-1';
const host = 'load.test';
const out = (m: string) => process.stderr.write(`${m}\n`);

const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query('DROP SCHEMA IF EXISTS public CASCADE');
await c.query('CREATE SCHEMA public');
await migrate(url, () => undefined);
await c.query('BEGIN');
await c.query(`SELECT set_config('app.platform_bypass','on',true)`);
const tid = (await c.query<{ id: string }>(`INSERT INTO tenants (slug, name) VALUES ('load','Load Labs') RETURNING id`)).rows[0]!.id;
await c.query(`INSERT INTO tenant_branding (tenant_id, display_name) VALUES ($1,'Load Labs')`, [tid]);
await c.query(
  `INSERT INTO tenant_domains (tenant_id, hostname, verification_token, verification_status, verified_at, activation_status) VALUES ($1,$2,'x','verified',now(),'active')`,
  [tid, host],
);
const hash = await hashPassword(password);
const adminId = (
  await c.query<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,'Admin',$3) RETURNING id`, [tid, `admin@${host}`, hash])
).rows[0]!.id;
await c.query(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'tenant_admin')`, [adminId, tid]);
await c.query('COMMIT');

const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const features = new Set(FEATURES.filter((d) => d.availability !== 'planned').map((d) => d.key));
const started = Date.now();
await generateDemo(c, { password, today, tenantId: tid, features, mode: 'multi', cipher: new FieldCipher(key), headcount });
out(`demo at ${headcount} people: ${Date.now() - started} ms`);

await c.query('BEGIN');
await c.query(`SELECT set_config('app.platform_bypass','on',true)`);
const none = await c.query<{ id: string; first_name: string }>(`SELECT id, first_name FROM employees WHERE tenant_id=$1 AND user_id IS NULL AND status IN ('active','on_notice')`, [
  tid,
]);
for (const [i, e] of none.rows.entries()) {
  const u = (
    await c.query<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`, [
      tid,
      `person${i}@${host}`,
      e.first_name,
      hash,
    ])
  ).rows[0]!.id;
  await c.query(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'employee')`, [u, tid]);
  await c.query(`UPDATE employees SET user_id=$2 WHERE id=$1`, [e.id, u]);
}
const people = await c.query<{ user_id: string; employee_id: string; email: string; role: string }>(
  `SELECT u.id AS user_id, e.id AS employee_id, u.email, (SELECT string_agg(r.role_key, ',') FROM user_roles r WHERE r.user_id=u.id) AS role
     FROM users u JOIN employees e ON e.user_id=u.id AND e.tenant_id=u.tenant_id WHERE u.tenant_id=$1 AND u.status='active' ORDER BY u.email`,
  [tid],
);
const sessions = [];
for (const p of people.rows) {
  const token = randomToken(32);
  const csrf = deriveCsrf(token);
  await c.query(
    `INSERT INTO sessions (token_hash, csrf_hash, user_id, tenant_id, ip, user_agent, expires_at, idle_timeout_minutes) VALUES ($1,$2,$3,$4,'127.0.0.1','k6', now() + interval '48 hours', 1440)`,
    [sha256(token), sha256(csrf), p.user_id, tid],
  );
  sessions.push({ token, csrf, email: p.email, role: p.role, employeeId: p.employee_id });
}
await c.query('COMMIT');
await c.query('ANALYZE');
await c.end();
writeFileSync('load/.sessions.json', JSON.stringify({ host, password, sessions }));
out(`${sessions.length} sessions in load/.sessions.json`);
