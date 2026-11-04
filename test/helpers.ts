import pg from 'pg';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db/pool.js';
import { FieldCipher, hashPassword } from '../src/core/crypto/index.js';
import { loadEnv } from '../src/config/env.js';
import { TEST_APP_URL, TEST_OWNER_URL } from './env.js';

export const PASSWORD = 'Test-Password-123!';
let pwHash: string | null = null;

export async function makeApp(overrides: Record<string, string> = {}, opts: { mailerOverride?: boolean; storeOverride?: boolean; smsOverride?: boolean } = {}): Promise<FastifyInstance> {
  const env = loadEnv({
    NODE_ENV: 'test', DATABASE_URL: TEST_APP_URL, COOKIE_SECURE: 'false',
    ENABLED_MODULES: 'default,attendance.mobile,attendance.biometric',
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), SESSION_TTL_HOURS: '24', AUTH_RATE_LIMIT_PER_MINUTE: '10000',
    MFA_ENFORCEMENT: 'off', // the MFA suite turns enforcement on explicitly
    ...overrides,
  });
  const pool = createPool(env.DATABASE_URL, 5);
  const app = await buildApp({ env, pool, cipher: new FieldCipher(env.DATA_ENCRYPTION_KEY), mailerOverride: opts.mailerOverride, storeOverride: opts.storeOverride, smsOverride: opts.smsOverride });
  app.addHook('onClose', async () => { await pool.end(); });
  return app;
}

/** Owner connection with RLS bypass — fixtures and white-box assertions only. */
export async function ownerQuery<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: TEST_OWNER_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.platform_bypass','on',true)`);
    const r = await c.query<T>(sql, params);
    await c.query('COMMIT');
    return r.rows;
  } finally { await c.end(); }
}

export interface TenantFixture {
  id: string; host: string; legalEntityId: string; branchId: string; deptId: string; shiftId: string; nightShiftId: string;
  users: Record<string, { id: string; email: string; employeeId?: string }>;
}

/**
 * A complete tenant: verified+active domain, org, two shifts, and users:
 * admin (tenant_admin), hr (hr_admin), manager (reporting_manager, has employee),
 * employee (reports to manager), other (employee, no manager), payroll, it.
 */
export async function createTenant(): Promise<TenantFixture> {
  pwHash ??= await hashPassword(PASSWORD);
  const slug = 't' + randomBytes(5).toString('hex');
  const host = `${slug}.test`;
  const [t] = await ownerQuery<{ id: string }>(`INSERT INTO tenants (slug, name) VALUES ($1,$2) RETURNING id`, [slug, `Tenant ${slug}`]);
  const id = t!.id;
  await ownerQuery(`INSERT INTO tenant_branding (tenant_id, display_name) VALUES ($1,$2)`, [id, `Tenant ${slug}`]);
  await ownerQuery(`INSERT INTO tenant_domains (tenant_id, hostname, verification_token, verification_status, verified_at, activation_status)
    VALUES ($1,$2,'x','verified',now(),'active')`, [id, host]);
  const [le] = await ownerQuery<{ id: string }>(`INSERT INTO legal_entities (tenant_id, name) VALUES ($1,'LE') RETURNING id`, [id]);
  const [br] = await ownerQuery<{ id: string }>(`INSERT INTO branches (tenant_id, legal_entity_id, code, name, state) VALUES ($1,$2,'HQ','HQ','Maharashtra') RETURNING id`, [id, le!.id]);
  const [dp] = await ownerQuery<{ id: string }>(`INSERT INTO departments (tenant_id, code, name) VALUES ($1,'LAB','Lab') RETURNING id`, [id]);
  const [sh] = await ownerQuery<{ id: string }>(`INSERT INTO shifts (tenant_id, code, name, start_time, end_time, break_minutes, grace_minutes, early_exit_grace_minutes,
    half_day_min_minutes, full_day_min_minutes, overtime_after_minutes) VALUES ($1,'GEN','General','09:30','18:00',30,10,10,240,450,540) RETURNING id`, [id]);
  const [ns] = await ownerQuery<{ id: string }>(`INSERT INTO shifts (tenant_id, code, name, start_time, end_time, break_minutes, grace_minutes, early_exit_grace_minutes,
    half_day_min_minutes, full_day_min_minutes, overtime_after_minutes) VALUES ($1,'NIGHT','Night','22:00','06:00',30,10,10,240,420,480) RETURNING id`, [id]);

  const fx: TenantFixture = { id, host, legalEntityId: le!.id, branchId: br!.id, deptId: dp!.id, shiftId: sh!.id, nightShiftId: ns!.id, users: {} };
  let n = 0;
  const mkEmp = async (managerId: string | null) => {
    n++;
    const [e] = await ownerQuery<{ id: string }>(`INSERT INTO employees (tenant_id, employee_code, first_name, last_name, legal_entity_id, branch_id, department_id,
      reporting_manager_id, date_of_joining) VALUES ($1,$2,'Emp',$3,$4,$5,$6,$7,'2024-01-01') RETURNING id`, [id, `E${n}`, `N${n}`, le!.id, br!.id, dp!.id, managerId]);
    await ownerQuery(`INSERT INTO shift_assignments (tenant_id, employee_id, shift_id, effective_from) VALUES ($1,$2,$3,'2024-01-01')`, [id, e!.id, sh!.id]);
    return e!.id;
  };
  const mkUser = async (key: string, roles: string[], employeeId?: string) => {
    const email = `${key}@${host}`;
    const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`, [id, email, key, pwHash]);
    for (const r of roles) await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,$3)`, [u!.id, id, r]);
    if (employeeId) await ownerQuery(`UPDATE employees SET user_id=$2 WHERE id=$1`, [employeeId, u!.id]);
    fx.users[key] = { id: u!.id, email, employeeId };
  };
  const mgrEmp = await mkEmp(null);
  const empEmp = await mkEmp(mgrEmp);
  const otherEmp = await mkEmp(null);
  const hrEmp = await mkEmp(null);
  await mkUser('admin', ['tenant_admin', 'employee']);
  await mkUser('hr', ['hr_admin', 'employee'], hrEmp);
  await mkUser('manager', ['reporting_manager', 'employee'], mgrEmp);
  await mkUser('employee', ['employee'], empEmp);
  await mkUser('other', ['employee'], otherEmp);
  await mkUser('payroll', ['payroll_manager', 'employee']);
  await mkUser('it', ['it_admin']);
  return fx;
}

/** Authenticated client bound to one host. Sends cookie + CSRF automatically. */
export class Client {
  cookie = ''; csrf = ''; passwordChangeRequired = false;
  constructor(private app: FastifyInstance, public host: string) {}
  static async login(app: FastifyInstance, host: string, email: string, password = PASSWORD) {
    const c = new Client(app, host);
    const r = await c.req('POST', '/api/v1/auth/login', { email, password });
    if (r.statusCode !== 200) throw new Error(`login failed for ${email}@${host}: ${r.statusCode} ${r.body}`);
    return c;
  }
  async req(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const r = await this.app.inject({ method, url, payload: payload as never, headers: {
      host: this.host, ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}), ...headers } });
    const set = r.headers['set-cookie'];
    const sc = Array.isArray(set) ? set[0] : set;
    if (sc?.startsWith('hrms_sid=')) this.cookie = sc.split(';')[0]!;
    if (url === '/api/v1/auth/login' && r.statusCode === 200) { this.csrf = r.json().csrfToken; this.passwordChangeRequired = r.json().passwordChangeRequired; }
    return r;
  }
  get = (u: string) => this.req('GET', u);
  post = (u: string, b?: unknown) => this.req('POST', u, b ?? {});
  put = (u: string, b?: unknown) => this.req('PUT', u, b ?? {});
  patch = (u: string, b?: unknown) => this.req('PATCH', u, b ?? {});
  del = (u: string) => this.req('DELETE', u);
}

/** Build a multipart/form-data body (fields + optional single file). */
export function multipart(fields: Record<string, string>, file?: { name: string; content: Buffer; type?: string }) {
  const boundary = '----hrmstest' + randomBytes(8).toString('hex');
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`));
    parts.push(file.content, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
