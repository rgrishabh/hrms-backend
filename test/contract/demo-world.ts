import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { generateDemo } from '../../src/db/demo.js';
import { localDate, addDays } from '../../src/modules/attendance/time.js';
import { TEST_OWNER_URL } from '../env.js';
import { Client, makeApp, ownerQuery } from '../helpers.js';
import { ALL_ON } from '../security/wire.js';

export const DEMO_PASSWORD = 'Demo-Test-Password-1';

/** The demo organization with every module on, plus a computed payroll run the generator leaves out. A world for tests that walk the whole API. */
export async function demoWorld(overrides: Record<string, string> = {}) {
  const app: FastifyInstance = await makeApp({ ...ALL_ON, ...overrides });
  const slug = 'w' + randomBytes(5).toString('hex');
  const host = `${slug}.test`;
  const [t] = await ownerQuery<{ id: string }>(`INSERT INTO tenants (slug, name) VALUES ($1,'Demo Labs') RETURNING id`, [slug]);
  const tid = t!.id;
  await ownerQuery(`INSERT INTO tenant_branding (tenant_id, display_name) VALUES ($1,'Demo Labs')`, [tid]);
  await ownerQuery(
    `INSERT INTO tenant_domains (tenant_id, hostname, verification_token, verification_status, verified_at, activation_status) VALUES ($1,$2,'x','verified',now(),'active')`,
    [tid, host],
  );
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,'Admin','x') RETURNING id`, [tid, `admin@${host}`]);
  await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'tenant_admin')`, [u!.id, tid]);
  const c = new pg.Client({ connectionString: TEST_OWNER_URL });
  await c.connect();
  const today = localDate(new Date(), 'Asia/Kolkata');
  const demo = (await generateDemo(c, { password: DEMO_PASSWORD, today, tenantId: tid, features: app.deps.env.enabledFeatures }))!;
  await c.end();
  const logins = demo.logins.map((l) => l.login);
  const [hash] = await ownerQuery<{ password_hash: string }>(`SELECT password_hash FROM users WHERE tenant_id=$1 AND email=$2`, [tid, logins[0]]);
  await ownerQuery(`UPDATE users SET password_hash=$2 WHERE id=$1`, [u!.id, hash!.password_hash]);
  logins.push(`admin@${host}`);

  // A payroll run, with one item, a held item, an adjustment and a loan: the masked and revealed shapes of a real run.
  const pay = await Client.login(
    app,
    host,
    logins.find((l) => l.startsWith('payroll@'))!,
    DEMO_PASSWORD,
  );
  const [le] = await ownerQuery<{ id: string }>(`SELECT id FROM legal_entities WHERE tenant_id=$1 LIMIT 1`, [tid]);
  const period = addDays(today, -40).slice(0, 7);
  const run = await pay.post('/api/v1/payroll/runs', { period, legalEntityId: le!.id });
  if (run.statusCode === 201) await pay.post(`/api/v1/payroll/runs/${run.json().id}/compute`);
  const [emp] = await ownerQuery<{ id: string }>(`SELECT id FROM employees WHERE tenant_id=$1 AND user_id IS NULL AND status='active' LIMIT 1`, [tid]);
  await ownerQuery(
    `INSERT INTO employee_loans (tenant_id, employee_id, kind, amount, installments, installment_amount, first_period, purpose, status, created_by) VALUES ($1,$2,'loan',10000,5,2000,'2030-01','Fixture','approved',$3)`,
    [tid, emp!.id, u!.id],
  );
  return { app, tid, host, logins, today };
}

const TABLE: Record<string, string> = {
  'data-rights/employees': 'employees',
  'data-rights/candidates': 'candidates',
  'erasure-requests': 'erasure_requests',
  employees: 'employees',
  'profile-changes': 'employee_profile_changes',
  approvals: 'approval_requests',
  saved: 'saved_reports',
  snapshots: 'report_snapshots',
  selfies: 'attendance_selfies',
  documents: 'documents',
  claims: 'expense_claims',
  items: 'expense_items',
  batches: 'reimbursement_batches',
  'reimbursement-batches': 'reimbursement_batches',
  authorizations: 'lab_authorizations',
  policies: 'policies',
  versions: 'policy_versions',
  requisitions: 'job_requisitions',
  candidates: 'candidates',
  applications: 'job_applications',
  checklists: 'checklists',
  separations: 'separations',
  runs: 'payroll_runs',
  'payroll-runs': 'payroll_runs',
  payslips: 'payroll_items',
  cases: 'cases',
  cycles: 'review_cycles',
  goals: 'employees',
  reviews: 'performance_reviews',
  assets: 'assets',
  requests: '',
  'fnf-suggestions': 'employees',
};
const byModule: Record<string, string> = { 'field-duty': 'field_duty_requests', travel: 'travel_requests', loans: 'employee_loans' };

/** The table an id in this path comes from, or null when the path takes no id (`/reports/:key`). */
export function tableFor(url: string, param: string): string | null {
  const parts = url.replace('/api/v1/', '').split('/');
  const at = parts.indexOf(`:${param}`);
  const before = parts[at - 1] ?? parts[0]!;
  if (url.includes('overtime/claims')) return 'overtime_claims';
  if (url.includes('data-rights/candidates')) return 'candidates';
  if (param === 'employeeId') return 'employees';
  if (before === 'requests') return byModule[parts[0]!] ?? null;
  return TABLE[before] || null;
}

/** Up to `n` ids for a table in this organization, spread out. */
export async function idsOf(table: string, tid: string, n: number): Promise<string[]> {
  return (await ownerQuery<{ id: string }>(`SELECT id FROM ${table} WHERE tenant_id=$1 ORDER BY md5(id::text) LIMIT ${n}`, [tid])).map((r) => r.id);
}
