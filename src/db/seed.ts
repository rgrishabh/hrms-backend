import { contentHash } from '../modules/policies/routes.js';
import pg from 'pg';
import { resolveFeatures } from '../core/features/registry.js';
import { hashPassword } from '../core/crypto/index.js';
import { appUrl, loadInstallationEnv } from '../config/env.js';
import { bootstrapInstallation } from './bootstrap.js';
import { migrate } from './migrate.js';

/**
 * Local development seed — SYNTHETIC data for ONE installation, configured
 * from .env like a real deployment (BRAND_DOMAIN, BRAND_NAME, ...).
 * Refuses to run in production or against a non-local database.
 *
 *   npm run seed              add demo data to a bootstrapped or empty dev database
 *   npm run seed -- --reset   DROP the local dev schema first, then migrate + seed
 */
const DEV_PASSWORD = 'Dev-Password-123!';

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production');
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL is required');
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error(`Refusing to seed a non-local database (${host})`);
  const env = loadInstallationEnv();

  if (process.argv.includes('--reset')) {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query('DROP SCHEMA IF EXISTS public CASCADE');
    await c.query('CREATE SCHEMA public');
    await c.end();
    console.log('local dev schema dropped');
  }
  await migrate(url, () => undefined);

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const adminEmail = `admin@${env.BRAND_DOMAIN === 'localhost' ? 'example.test' : env.BRAND_DOMAIN}`;
    const boot = await bootstrapInstallation(c, env, { admin: { email: adminEmail, displayName: 'Demo Administrator' }, mode: 'password', password: DEV_PASSWORD });
    const tid = boot.tenantId;
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.platform_bypass', 'on', true)`);
    // Local convenience only: no forced password change for the demo admin.
    await c.query(`UPDATE users SET must_change_password=false WHERE tenant_id=$1 AND email=$2`, [tid, adminEmail]);
    if ((await c.query('SELECT 1 FROM legal_entities WHERE tenant_id=$1', [tid])).rowCount) {
      await seedModules(c, tid, adminEmail.split('@')[1]!);
      await c.query('COMMIT');
      console.log('Demo data already present (leave, expense, competency and policy demo data ensured).');
      return;
    }
    const pw = await hashPassword(DEV_PASSWORD);
    const domain = adminEmail.split('@')[1]!;
    const le = (await c.query<{ id: string }>(`INSERT INTO legal_entities (tenant_id, name, state_code) VALUES ($1,$2,'27') RETURNING id`, [tid, env.BRAND_NAME])).rows[0]!.id;
    const branchIds: string[] = [];
    for (const b of [{ code: 'MUM', name: 'Mumbai Central Lab', state: 'Maharashtra', city: 'Mumbai' }, { code: 'PUN', name: 'Pune Field Station', state: 'Maharashtra', city: 'Pune' }]) {
      branchIds.push((await c.query<{ id: string }>(`INSERT INTO branches (tenant_id, legal_entity_id, code, name, state, city) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [tid, le, b.code, b.name, b.state, b.city])).rows[0]!.id);
    }
    const depts: Record<string, string> = {};
    for (const [code, name] of [['WATER', 'Water & Wastewater Testing'], ['AIR', 'Ambient Air & Stack Monitoring'], ['SOIL', 'Soil & Solid Waste'], ['QA', 'Quality Assurance'], ['HR', 'Human Resources']]) {
      depts[code!] = (await c.query<{ id: string }>(`INSERT INTO departments (tenant_id, code, name) VALUES ($1,$2,$3) RETURNING id`, [tid, code, name])).rows[0]!.id;
    }
    const general = (await c.query<{ id: string }>(`INSERT INTO shifts (tenant_id, code, name, start_time, end_time, break_minutes, grace_minutes, early_exit_grace_minutes,
      half_day_min_minutes, full_day_min_minutes, overtime_after_minutes) VALUES ($1,'GEN','General 09:30–18:00','09:30','18:00',30,10,10,240,450,540) RETURNING id`, [tid])).rows[0]!.id;
    const night = (await c.query<{ id: string }>(`INSERT INTO shifts (tenant_id, code, name, start_time, end_time, break_minutes, grace_minutes, early_exit_grace_minutes,
      half_day_min_minutes, full_day_min_minutes, overtime_after_minutes) VALUES ($1,'NIGHT','Night 22:00–06:00','22:00','06:00',30,10,10,240,420,480) RETURNING id`, [tid])).rows[0]!.id;
    const year = new Date().getFullYear();
    for (const [d, name] of [[`${year}-01-26`, 'Republic Day'], [`${year}-08-15`, 'Independence Day'], [`${year}-10-02`, 'Gandhi Jayanti']]) {
      await c.query(`INSERT INTO holidays (tenant_id, holiday_date, name) VALUES ($1,$2,$3)`, [tid, d, name]);
    }
    const mkEmp = async (i: number, first: string, last: string, dept: string, designation: string, managerId: string | null) => {
      const r = await c.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_code, first_name, last_name, work_email, legal_entity_id, branch_id,
        department_id, designation, employment_type, reporting_manager_id, date_of_joining) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'permanent',$10,$11) RETURNING id`,
        [tid, `EMP${String(i).padStart(4, '0')}`, first, last, `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`, le, branchIds[i % 2], depts[dept], designation, managerId, `${year - 2}-04-01`]);
      await c.query(`INSERT INTO shift_assignments (tenant_id, employee_id, shift_id, effective_from) VALUES ($1,$2,$3,$4)`, [tid, r.rows[0]!.id, i % 7 === 6 ? night : general, `${year - 2}-04-01`]);
      return r.rows[0]!.id;
    };
    const mkUser = async (key: string, name: string, roles: string[], employeeId?: string) => {
      const u = (await c.query<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`, [tid, `${key}@${domain}`, name, pw])).rows[0]!.id;
      for (const r of roles) await c.query(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,$3)`, [u, tid, r]);
      if (employeeId) await c.query(`UPDATE employees SET user_id=$3 WHERE tenant_id=$1 AND id=$2`, [tid, employeeId, u]);
    };
    const hrHead = await mkEmp(1, 'Demo', 'HRAdmin', 'HR', 'HR Manager', null);
    const labMgr = await mkEmp(2, 'Demo', 'LabManager', 'WATER', 'Laboratory Manager', null);
    const analyst = await mkEmp(3, 'Demo', 'Analyst', 'WATER', 'Chemist', labMgr);
    await mkUser('hr', 'Demo HRAdmin', ['hr_admin', 'employee'], hrHead);
    await mkUser('manager', 'Demo LabManager', ['laboratory_manager', 'reporting_manager', 'employee'], labMgr);
    await mkUser('employee', 'Demo Analyst', ['employee'], analyst);
    await mkUser('payroll', 'Demo Payroll', ['payroll_manager', 'employee']);
    await mkUser('auditor', 'Demo Auditor', ['auditor']);
    const designations = ['Chemist', 'Senior Chemist', 'Microbiologist', 'Field Sampler', 'Lab Technician', 'Instrument Engineer'];
    for (let i = 4; i <= 40; i++) await mkEmp(i, 'Synthetic', `Employee${String(i).padStart(3, '0')}`, ['WATER', 'AIR', 'SOIL', 'QA'][i % 4]!, designations[i % 6]!, i % 3 === 0 ? labMgr : null);
    await seedModules(c, tid, domain);
    await c.query('COMMIT');
    console.log(`Seeded ${env.BRAND_NAME} (40 synthetic employees) at ${appUrl(env)}`);
    console.log(`Users: admin@, hr@, manager@, employee@, payroll@, finance@, quality@, auditor@${domain}`);
    console.log(`Development password for all seeded users: ${DEV_PASSWORD}`);
  } finally {
    await c.end();
  }
}

/** DEMO leave policies (illustrative numbers, not legal advice) + accruals for the current leave year. Idempotent. */
/** Finance and quality demo users (added after the first seed version, so ensured on re-runs too). */
/** A module that is off gets no seed data. */
async function seedModules(c: pg.Client, tid: string, domain: string) {
  const { features, problems } = resolveFeatures(process.env);
  if (problems.length) throw new Error(problems.join('; '));
  if (features.has('leave')) await seedLeave(c, tid);
  if (features.has('expenses')) await seedExpenses(c, tid);
  await seedExtraUsers(c, tid, domain, await hashPassword(DEV_PASSWORD));
  if (features.has('training')) await seedCompetency(c, tid);
  if (features.has('core.policies')) await seedPolicies(c, tid);
}

async function seedExtraUsers(c: pg.Client, tid: string, domain: string, pw: string) {
  for (const [key, name, role] of [['finance', 'Demo Finance', 'finance_manager'], ['quality', 'Demo Quality', 'quality_manager']] as const) {
    if ((await c.query('SELECT 1 FROM users WHERE tenant_id=$1 AND email=$2', [tid, `${key}@${domain}`])).rowCount) continue;
    const u = (await c.query<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`, [tid, `${key}@${domain}`, name, pw])).rows[0]!.id;
    await c.query(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,$3)`, [u, tid, role]);
  }
}

/** Demo courses and methods (illustrative names; each laboratory defines its own scope and requirements). */
async function seedCompetency(c: pg.Client, tid: string) {
  if ((await c.query('SELECT 1 FROM training_courses WHERE tenant_id=$1', [tid])).rowCount) return;
  const ids: Record<string, string> = {};
  for (const [code, name, kind, months] of [['INDUCTION', 'Laboratory induction', 'induction', null], ['CHEM-SAFETY', 'Chemical safety & spill response', 'safety', 12],
    ['QMS', 'Quality system awareness', 'quality', 24], ['PH-METER', 'pH meter operation & calibration', 'instrument', null], ['AAS', 'AAS operation', 'instrument', null],
    ['STACK-SAMPLING', 'Stack sampling safety (work at height)', 'safety', 12]] as const)
    ids[code] = (await c.query<{ id: string }>('INSERT INTO training_courses (tenant_id, code, name, kind, validity_months) VALUES ($1,$2,$3,$4,$5) RETURNING id', [tid, code, name, kind, months])).rows[0]!.id;
  for (const [code, name, discipline, matrix, req] of [
    ['WAT-PH', 'pH — electrometric', 'Chemical', 'Water', ['INDUCTION', 'CHEM-SAFETY', 'PH-METER']],
    ['WAT-METALS-AAS', 'Heavy metals by AAS', 'Chemical', 'Water', ['INDUCTION', 'CHEM-SAFETY', 'AAS']],
    ['AIR-STACK-PM', 'Particulate matter — stack emission', 'Chemical', 'Stack emission', ['INDUCTION', 'STACK-SAMPLING']]] as const) {
    const m = (await c.query<{ id: string }>('INSERT INTO lab_methods (tenant_id, code, name, discipline, matrix) VALUES ($1,$2,$3,$4,$5) RETURNING id', [tid, code, name, discipline, matrix])).rows[0]!.id;
    for (const r of req) await c.query('INSERT INTO lab_method_requirements (tenant_id, method_id, course_id) VALUES ($1,$2,$3)', [tid, m, ids[r]]);
  }
}

/** One published demo policy (drafted by HR, published by the admin — maker-checker) and one draft. */
async function seedPolicies(c: pg.Client, tid: string) {
  if ((await c.query('SELECT 1 FROM policies WHERE tenant_id=$1', [tid])).rowCount) return;
  const uid = async (prefix: string) => (await c.query<{ id: string }>(`SELECT id FROM users WHERE tenant_id=$1 AND email LIKE $2 LIMIT 1`, [tid, `${prefix}@%`])).rows[0]?.id;
  const hr = await uid('hr'); const admin = await uid('admin');
  if (!hr || !admin) return;
  const demo = [
    ['COC', 'Code of conduct (demo)', 'code_of_conduct', 'Demo text only — replace with your organization\'s approved policy.\n\n1. Act with integrity.\n2. Report conflicts of interest.\n3. Protect client data and test results.', true],
    ['LAB-SAFETY', 'Laboratory safety rules (demo)', 'safety', 'Demo text only.\n\nWear PPE in the laboratory. Know the location of eyewash stations and spill kits.', false],
  ] as const;
  for (const [code, title, category, body, publish] of demo) {
    const pid = (await c.query<{ id: string }>(`INSERT INTO policies (tenant_id, code, title, category, owner, created_by) VALUES ($1,$2,$3,$4,'HR',$5) RETURNING id`, [tid, code, title, category, hr])).rows[0]!.id;
    await c.query(`INSERT INTO policy_versions (tenant_id, policy_id, version_no, status, change_summary, body, content_sha256, effective_from, created_by, published_by, published_at)
      VALUES ($1,$2,1,$3,'Initial issue',$4,$5,current_date,$6,$7,$8)`, [tid, pid, publish ? 'published' : 'draft', body, contentHash(body, null), hr, publish ? admin : null, publish ? new Date() : null]);
  }
}

async function seedExpenses(c: pg.Client, tid: string) {
  if ((await c.query('SELECT 1 FROM expense_categories WHERE tenant_id=$1', [tid])).rowCount) return;
  // Demo categories only; limits are placeholders for the organization's own policy.
  const cats: [string, string, boolean, number | null, boolean][] = [
    ['LOCAL_TRAVEL', 'Local travel', false, 2000, false], ['ACCOMMODATION', 'Accommodation', true, null, true],
    ['MEALS', 'Meals', true, 1500, true], ['SAMPLING_TRAVEL', 'Sample collection travel', true, null, true], ['PPE', 'PPE & consumables', true, 5000, true]];
  for (const [code, name, receipt, max, gst] of cats)
    await c.query('INSERT INTO expense_categories (tenant_id, code, name, requires_receipt, max_amount, gst_applicable) VALUES ($1,$2,$3,$4,$5,$6)', [tid, code, name, receipt, max, gst]);
}

async function seedLeave(c: pg.Client, tid: string) {
  if ((await c.query('SELECT 1 FROM leave_types WHERE tenant_id=$1', [tid])).rowCount) return;
  const demo = [
    ['CL', 'Casual Leave (demo policy)', true, true, true, 'annual', 12, 0, false, 0],
    ['SL', 'Sick Leave (demo policy)', true, true, true, 'annual', 12, 0, false, 0],
    ['EL', 'Earned Leave (demo policy)', true, false, true, 'monthly', 18, 30, false, 7],
    ['LWP', 'Leave Without Pay', false, true, false, 'none', 0, 0, false, 0],
  ] as const;
  for (const [code, name, paid, half, bal, accrual, ent, carry, sandwich, notice] of demo) {
    await c.query(`INSERT INTO leave_types (tenant_id, code, name, paid, allow_half_day, requires_balance, accrual_method, annual_entitlement,
      carry_forward_max, count_non_working_days, min_notice_days) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [tid, code, name, paid, half, bal, accrual, ent, carry, sandwich, notice]);
  }
  const { runAccruals } = await import('../modules/leave/jobs.js');
  const year = new Date().getFullYear(); // leave year default starts in January
  const r = await runAccruals(c as never, tid, year, new Date().getMonth() + 1, null);
  console.log(`Leave demo policies created; accruals credited: ${r.credited}`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
