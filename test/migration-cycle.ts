import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate, rollback, type RollbackOptions } from '../src/db/migrate.js';
import { CODE_MIGRATIONS } from '../src/db/code-migrations.js';
import { FieldCipher, randomToken } from '../src/core/crypto/index.js';
import { schemaCatalogue, type Catalogue } from './schema-catalogue.js';

/**
 * The up, down, up cycle behind test/migrations-reversible.test.ts. It destroys a database's schema again and again, and no database can be set aside for it: the suite
 * shares three, and hrms_owner has no CREATEDB in the official environment, so a fourth cannot be created (and the CI workflow lives in the deployment repository). So
 * test/global-setup.ts runs this once, on hrms_test_single_b, before any test file starts and before the normal reset of that database. It records what happened in a JSON
 * file, and the test file asserts on the file. A failure in here does not stop the suite: it is recorded, and the test file fails on it.
 */

export const SEED_AT = '047_auth.sql';
export const EXPAND = '042_data_policy_expand.sql';
export const CONTRACT = '044_data_policy_contract.sql';
export const CODE_STEP = '043_encrypt_l4_data.code';
const KEY = Buffer.alloc(32, 21).toString('base64');
const cipher = new FieldCipher(KEY);

export const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface Refusal {
  name: string;
  error: string | null;
  appliedBefore: number;
  appliedAfter: number;
}
export interface CycleResult {
  /** Set if the cycle stopped early. */
  failure: string | null;
  order: string[];
  /** Schema after each migration going up, with '' for the state before the first. */
  up: Record<string, Catalogue>;
  /** Schema after rolling back each migration, one step at a time, on seeded rows. */
  down: Record<string, Catalogue>;
  /** What a query returned right after rolling back a migration: the data side of the down files. */
  probes: Record<string, unknown[]>;
  emptied: { catalogue: Catalogue; applied: number } | null;
  /** Schema after going all the way up again. */
  reup: Catalogue | null;
  refusals: Refusal[];
  /** Rolling back to 042 and up again on sealed rows, as one operation. */
  pair: { lastApplied: string; plaintext: Record<string, unknown[]>; resealed: Record<string, unknown>; chain: unknown; catalogue: Catalogue } | null;
  runner: Record<string, unknown>;
}

/** Real rows in core tables, in the shapes the application writes, including every row a down file has to treat specially. */
export const SEALED = {
  amounts: { BASIC: 41000 },
  annualCtc: 492000,
  item: { lines: [{ code: 'BASIC', name: 'Basic', kind: 'earning', amount: 41000 }], gross: 41000, deductions: 1000, net: 40000, employerCost: 42000, warnings: ['short by ₹5'] },
  totals: { employees: 1, gross: 41000, deductions: 1000, net: 40000, employerCost: 42000, held: 0 },
  adjustment: { amount: 750, note: 'Arrears for March' },
  exportTotal: 40000.5,
  snapshot: { rows: [{ days: 2 }], totals: { days: 2 }, subjects: [] },
};
const seal = (v: unknown) => cipher.encrypt(JSON.stringify(v));

async function seed(c: pg.Client): Promise<void> {
  const one = async (sql: string, params: unknown[] = []) => (await c.query<{ id: string }>(sql, params)).rows[0]!.id;
  const t = await one(`INSERT INTO tenants (slug, name) VALUES ('rollback-seed','Seed') RETURNING id`);
  const le = await one(`INSERT INTO legal_entities (tenant_id, name) VALUES ($1,'LE') RETURNING id`, [t]);
  const br = await one(`INSERT INTO branches (tenant_id, legal_entity_id, code, name, state) VALUES ($1,$2,'HQ','HQ','MH') RETURNING id`, [t, le]);
  await c.query(`INSERT INTO departments (tenant_id, code, name) VALUES ($1,'LAB','Lab')`, [t]);
  const user = (email: string, extra = '', vals = '') => one(`INSERT INTO users (tenant_id, email, display_name${extra}) VALUES ($1,$2,'U'${vals}) RETURNING id`, [t, email]);
  const admin = await user('admin@seed.test');
  const soleOwner = await user('owner@seed.test');
  await user('emailmfa@seed.test', ', mfa_method, mfa_enabled_at, mfa_recovery_hashes', `, 'email', now(), '{h}'`);
  await user('totp@seed.test', ', mfa_method, mfa_enabled_at, mfa_secret_enc', `, 'totp', now(), 'sealed'`);
  await c.query(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$3,'tenant_admin'), ($1,$3,'owner'), ($2,$3,'owner')`, [admin, soleOwner, t]);
  await c.query(`INSERT INTO sessions (token_hash, csrf_hash, user_id, tenant_id, expires_at) VALUES ($1,'c',$2,$3, now() + interval '1 day')`, [randomToken(), admin, t]);
  await c.query(`INSERT INTO tenant_settings (tenant_id, setting_key, setting_value) VALUES ($1,'security.max_failed_logins','5')`, [t]);
  const emp = await one(
    `INSERT INTO employees (tenant_id, employee_code, first_name, legal_entity_id, branch_id, date_of_joining, user_id) VALUES ($1,'E1','E',$2,$3,'2024-01-01',$4) RETURNING id`,
    [t, le, br, admin],
  );
  // Ledger and attendance rows that the old check constraints refuse.
  const lt = await one(`INSERT INTO leave_types (tenant_id, code, name) VALUES ($1,'CL','Casual') RETURNING id`, [t]);
  await c.query(
    `INSERT INTO leave_ledger (tenant_id, employee_id, leave_type_id, leave_year, entry_type, days, reference) VALUES ($1,$2,$3,2026,'opening',5,'o1'), ($1,$2,$3,2026,'carry_out',-2,'yearend:x')`,
    [t, emp, lt],
  );
  await c.query(
    `INSERT INTO attendance_daily (tenant_id, employee_id, work_date, day_type, status, calc_version) VALUES ($1,$2,'2026-03-02','working','present',1), ($1,$2,'2026-03-03','working','on_leave',1), ($1,$2,'2026-03-04','working','on_duty',1)`,
    [t, emp],
  );
  await c.query(`INSERT INTO job_runs (tenant_id, job_key, period_key, trigger, status) VALUES ($1,'x','manual:1','manual','queued'), ($1,'x','2026-01','schedule','succeeded')`, [
    t,
  ]);
  await c.query(
    `INSERT INTO email_outbox (tenant_id, to_email, subject, text_body, html_body, kind, secret_enc, expires_at) VALUES ($1,'a@seed.test','Code','{{secret}}','{{secret}}','auth.code','sealed', now() + interval '1 hour'), ($1,'b@seed.test','Hello','Hi','Hi','plain',NULL,NULL)`,
    [t],
  );
  await c.query(
    `INSERT INTO admin_setup_tokens (tenant_id, user_id, token_hash, expires_at, purpose) VALUES ($1,$2,'r1', now() + interval '1 hour','reset'), ($1,$2,'s1', now() + interval '1 hour','setup')`,
    [t, admin],
  );
  await c.query(`INSERT INTO notifications (tenant_id, user_id, kind, title, feature) VALUES ($1,$2,'loans.disbursed','Paid','loans')`, [t, admin]);
  // Approval labels 040 moved.
  const loan = await one(
    `INSERT INTO employee_loans (tenant_id, employee_id, kind, amount, installments, installment_amount, first_period, purpose, created_by) VALUES ($1,$2,'salary_advance',1000,1,1000,'2026-04','Need it',$3) RETURNING id`,
    [t, emp, admin],
  );
  await c.query(`INSERT INTO approval_requests (tenant_id, entity_type, entity_id, requester_id, summary) VALUES ($1,'salary_advance',$2,$3,'Advance')`, [t, loan, admin]);
  // Sealed pay, under a finalized run whose guard must not get in the way.
  await c.query(
    `INSERT INTO employee_salaries (tenant_id, employee_id, effective_from, amounts_enc, annual_ctc_enc, reason, status, created_by) VALUES ($1,$2,'2025-01-01',$3,$4,'r','active',$5)`,
    [t, emp, seal(SEALED.amounts), seal(SEALED.annualCtc), admin],
  );
  const run = await one(`INSERT INTO payroll_runs (tenant_id, legal_entity_id, period, created_by, totals_enc) VALUES ($1,$2,'2026-03',$3,$4) RETURNING id`, [
    t,
    le,
    admin,
    seal(SEALED.totals),
  ]);
  await c.query(`INSERT INTO payroll_runs (tenant_id, legal_entity_id, period, created_by) VALUES ($1,$2,'2026-04',$3)`, [t, le, admin]);
  await c.query(`INSERT INTO payroll_items (tenant_id, run_id, employee_id, days_in_period, employed_days, paid_days, data_enc, calc_version) VALUES ($1,$2,$3,31,31,31,$4,6)`, [
    t,
    run,
    emp,
    seal(SEALED.item),
  ]);
  await c.query(`INSERT INTO payroll_adjustments (tenant_id, run_id, employee_id, kind, label, data_enc, created_by) VALUES ($1,$2,$3,'earning','Arrears',$4,$5)`, [
    t,
    run,
    emp,
    seal(SEALED.adjustment),
    admin,
  ]);
  await c.query(`UPDATE payroll_runs SET status='finalized' WHERE id=$1`, [run]);
  await c.query(
    `INSERT INTO accounting_exports (tenant_id, source_type, source_id, format, voucher_date, total_enc, exported_by) VALUES ($1,'payroll_run',$2,'csv','2026-03-31',$3,$4)`,
    [t, run, seal(SEALED.exportTotal), admin],
  );
  await c.query(
    `INSERT INTO report_snapshots (tenant_id, owner_id, report_key, name, params, scope, columns, data_enc, row_count, recipient_ids, expires_at) VALUES ($1,$2,'leave_taken','Leave','{}','all','[]',$3,1,$4, now() + interval '1 day')`,
    [t, admin, seal(SEALED.snapshot), [admin]],
  );
  // Audit rows, chained at commit. They make a chain the downs must clear, past triggers that refuse any update.
  await c.query(`INSERT INTO audit_logs (tenant_id, action) VALUES ($1,'seed.one'), ($1,'seed.two')`, [t]);
}

const PLAINTEXT_QUERIES: Record<string, string> = {
  salary: `SELECT amounts, annual_ctc, amounts_enc FROM employee_salaries`,
  item: `SELECT lines, gross, deductions, net, employer_cost, warnings, data_enc FROM payroll_items`,
  runs: `SELECT period, totals, totals_enc FROM payroll_runs ORDER BY period`,
  adjustment: `SELECT amount, note, data_enc FROM payroll_adjustments`,
  export: `SELECT total, total_enc FROM accounting_exports`,
  snapshot: `SELECT rows, totals, data_enc FROM report_snapshots`,
  chain: `SELECT chain_seq, prev_hash, row_hash FROM audit_logs ORDER BY id`,
  roles: `SELECT u.email, r.role_key FROM user_roles r JOIN users u ON u.id = r.user_id ORDER BY 1, 2`,
};

/** What each down file is expected to have done to the seeded rows, read right after it ran. */
const PROBES: Record<string, string> = {
  '047_auth.sql': `SELECT (SELECT json_agg(json_build_object('to', to_email, 'status', status) ORDER BY to_email) FROM email_outbox) AS mail,
    (SELECT json_agg(json_build_object('hash', token_hash, 'used', used_at IS NOT NULL) ORDER BY token_hash) FROM admin_setup_tokens) AS links,
    (SELECT json_agg(json_build_object('email', email, 'on', mfa_enabled_at IS NOT NULL) ORDER BY email) FROM users WHERE email IN ('emailmfa@seed.test','totp@seed.test')) AS mfa`,
  [CONTRACT]: `SELECT (SELECT count(*)::int FROM user_roles WHERE role_key='owner') AS owners,
    (SELECT json_agg(json_build_object('email', u.email, 'role', r.role_key) ORDER BY u.email, r.role_key) FROM user_roles r JOIN users u ON u.id=r.user_id) AS roles,
    (SELECT count(*)::int FROM audit_logs WHERE chain_seq IS NULL) AS unchained, (SELECT count(*)::int FROM audit_logs) AS audit_rows,
    (SELECT count(*)::int FROM payroll_items WHERE data_enc IS NOT NULL) AS still_sealed`,
  [CODE_STEP]: `SELECT (SELECT net FROM payroll_items) AS net, (SELECT note FROM payroll_adjustments) AS note, (SELECT annual_ctc FROM employee_salaries) AS ctc,
    (SELECT count(*)::int FROM payroll_items WHERE data_enc IS NOT NULL) AS still_sealed`,
  '040_feature_splits.sql': `SELECT entity_type FROM approval_requests`,
  '038_job_runs_queued.sql': `SELECT period_key, status, error FROM job_runs ORDER BY period_key`,
  '032_leave_year_close.sql': `SELECT entry_type, days, note FROM leave_ledger ORDER BY reference`,
  '021_field_duty.sql': `SELECT work_date::text, status FROM attendance_daily ORDER BY work_date`,
  '006_leave_management.sql': `SELECT work_date::text, status FROM attendance_daily ORDER BY work_date`,
  '002_core_hr_attendance.sql': `SELECT count(*)::int AS tenants FROM tenants`,
};

export async function runMigrationCycle(url: string, file: string): Promise<void> {
  const quiet = () => undefined;
  const result: CycleResult = { failure: null, order: [], up: {}, down: {}, probes: {}, emptied: null, reup: null, refusals: [], pair: null, runner: {} };
  const up = (until?: string, dir?: string) => migrate(url, quiet, { until, cipher, dir });
  const back = (o: RollbackOptions) => rollback(url, quiet, { cipher, ...o });
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const reset = async () => {
    await c.query('DROP SCHEMA IF EXISTS public CASCADE');
    await c.query('CREATE SCHEMA public');
  };
  const applied = async () => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM schema_migrations')).rows[0]!.n);
  const refuse = async (name: string, o: RollbackOptions) => {
    const appliedBefore = await applied();
    let error: string | null = null;
    try {
      await back(o);
    } catch (e) {
      error = (e as Error).message;
    }
    result.refusals.push({ name, error, appliedBefore, appliedAfter: await applied() });
  };
  try {
    const sql = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql'));
    result.order = [...sql, ...CODE_MIGRATIONS.map((m) => m.name)].sort();

    // Up one at a time on an empty schema, seeding where the shape of the rows is known. A later migration then runs over real rows too.
    await reset();
    await up('000');
    result.up[''] = await schemaCatalogue(c);
    for (const name of result.order) {
      await up(name);
      result.up[name] = await schemaCatalogue(c);
      if (name === SEED_AT) await seed(c);
    }

    // Down one at a time, comparing each state later. Allowed to stop inside the pair, or the state between its steps could not be compared.
    for (const name of [...result.order].reverse()) {
      const done = await back({ steps: 1, allowUnsafeStop: true });
      if (done.length !== 1 || done[0] !== name) throw new Error(`Rolled back ${done.join(', ')} when ${name} was expected`);
      result.down[name] = await schemaCatalogue(c);
      if (PROBES[name]) result.probes[name] = (await c.query(PROBES[name]!)).rows;
    }
    result.emptied = { catalogue: await schemaCatalogue(c), applied: await applied() };

    // Up again, with rows again, for what follows.
    await up(SEED_AT);
    await seed(c);
    await up();
    result.reup = await schemaCatalogue(c);

    // Everything that must refuse, and leave the database as it was.
    const last = result.order[result.order.length - 1]!;
    await refuse('no target', {});
    await refuse('two targets', { steps: 1, all: true });
    await refuse('zero steps', { steps: 0 });
    await refuse('too many steps', { steps: 9999 });
    await refuse('unknown name', { to: 'nope.sql' });
    await refuse('stop inside the pair', { to: CODE_STEP });
    await refuse('wrong key', { to: EXPAND, cipher: new FieldCipher(Buffer.alloc(32, 22).toString('base64')) });
    const partial = await mkdtemp(path.join(tmpdir(), 'hrms-migrations-'));
    await cp(MIGRATIONS, partial, { recursive: true });
    await rm(path.join(partial, 'down', last));
    await refuse('missing down', { steps: 1, dir: partial });
    await rm(partial, { recursive: true, force: true });

    // The pair as one operation, with a real key: the values come back, then go round.
    const all = await schemaCatalogue(c);
    await back({ to: EXPAND });
    const lastApplied = (await c.query<{ name: string }>('SELECT max(name) AS name FROM schema_migrations')).rows[0]!.name;
    const plaintext: Record<string, unknown[]> = {};
    for (const [k, q] of Object.entries(PLAINTEXT_QUERIES)) plaintext[k] = (await c.query(q)).rows;
    await up();
    const open = async (q: string) => {
      const v = (await c.query<{ v: string | null }>(q)).rows[0]!.v;
      return v === null ? null : cipher.decrypt(v);
    };
    const resealed: Record<string, unknown> = {
      amounts: await open(`SELECT amounts_enc AS v FROM employee_salaries`),
      annualCtc: await open(`SELECT annual_ctc_enc AS v FROM employee_salaries`),
      item: await open(`SELECT data_enc AS v FROM payroll_items`),
      totals: await open(`SELECT totals_enc AS v FROM payroll_runs WHERE period='2026-03'`),
      adjustment: await open(`SELECT data_enc AS v FROM payroll_adjustments`),
      exportTotal: await open(`SELECT total_enc AS v FROM accounting_exports`),
      snapshot: await open(`SELECT data_enc AS v FROM report_snapshots`),
    };
    const chain = (await c.query(`SELECT ok, checked::int, broken_seq, reason FROM audit_chain_verify((SELECT id FROM tenants WHERE slug='rollback-seed'))`)).rows[0];
    result.pair = { lastApplied, plaintext, resealed, chain, catalogue: await schemaCatalogue(c) };
    result.runner.allBeforePair = all;

    await runnerChecks(c, reset, url, result);
  } catch (e) {
    result.failure = (e as Error).stack ?? String(e);
  } finally {
    await c.end();
    await writeFile(file, JSON.stringify(result));
  }
}

/** The no-transaction marker, against a real server, in a small directory of its own. */
async function runnerChecks(c: pg.Client, reset: () => Promise<void>, url: string, result: CycleResult): Promise<void> {
  const quiet = () => undefined;
  const dir = await mkdtemp(path.join(tmpdir(), 'hrms-no-tx-'));
  try {
    await mkdir(path.join(dir, 'down'));
    await reset();
    await writeFile(path.join(dir, '001_table.sql'), `CREATE TABLE probe (id integer, note text);\nINSERT INTO probe VALUES (1, 'a;b'), (1, 'c');\n`);
    await writeFile(
      path.join(dir, '002_index.sql'),
      `-- hrms:no-transaction\n-- a comment; with a semicolon\nCREATE INDEX CONCURRENTLY IF NOT EXISTS probe_note ON probe (note);\nCREATE INDEX CONCURRENTLY IF NOT EXISTS probe_id ON probe (id);\nDO $$ BEGIN PERFORM ';'; END $$;\n`,
    );
    await writeFile(path.join(dir, 'down', '001_table.sql'), `DROP TABLE probe;\n`);
    await writeFile(
      path.join(dir, 'down', '002_index.sql'),
      `-- hrms:no-transaction\nDROP INDEX CONCURRENTLY IF EXISTS probe_id;\nDROP INDEX CONCURRENTLY IF EXISTS probe_note;\n`,
    );
    await migrate(url, quiet, { dir, until: '002_index.sql' });
    const indexes = async () => (await c.query<{ n: string }>(`SELECT indexname AS n FROM pg_indexes WHERE tablename='probe' ORDER BY 1`)).rows.map((r) => r.n);
    const recorded = async () => (await c.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY 1`)).rows.map((r) => r.name);
    result.runner.afterUp = { indexes: await indexes(), recorded: await recorded() };

    // Without the marker the same statement cannot run: this is what the marker is for.
    await writeFile(path.join(dir, '003_no_marker.sql'), `CREATE INDEX CONCURRENTLY IF NOT EXISTS probe_x ON probe (id);\n`);
    result.runner.withoutMarker = await migrate(url, quiet, { dir, until: '003_no_marker.sql' }).then(
      () => null,
      (e: Error) => e.message,
    );
    await rm(path.join(dir, '003_no_marker.sql'));

    // Fails part way: what ran stays, it is not recorded. Going again finds the invalid index IF NOT EXISTS would hide, and says so. Dropped, and with the rows fixed, it goes through.
    await writeFile(
      path.join(dir, '003_unique.sql'),
      `-- hrms:no-transaction\nCREATE TABLE IF NOT EXISTS probe2 (id integer);\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS probe_uq ON probe (id);\n`,
    );
    await writeFile(path.join(dir, 'down', '003_unique.sql'), `-- hrms:no-transaction\nDROP INDEX CONCURRENTLY IF EXISTS probe_uq;\nDROP TABLE IF EXISTS probe2;\n`);
    const firstTry = await migrate(url, quiet, { dir, until: '003_unique.sql' }).then(
      () => null,
      (e: Error) => e.message,
    );
    const earlierStatementKept = Boolean((await c.query<{ t: string | null }>(`SELECT to_regclass('public.probe2') AS t`)).rows[0]!.t);
    const recordedAfterFailure = await recorded();
    const secondTry = await migrate(url, quiet, { dir, until: '003_unique.sql' }).then(
      () => null,
      (e: Error) => e.message,
    );
    await c.query(`DROP INDEX probe_uq`);
    await c.query(`DELETE FROM probe WHERE note='c'`);
    await migrate(url, quiet, { dir, until: '003_unique.sql' });
    result.runner.partWay = { firstTry, earlierStatementKept, recordedAfterFailure, secondTry, recordedAtLast: await recorded() };

    const rolled = await rollback(url, quiet, { dir, steps: 2 });
    result.runner.afterDown = { rolled, indexes: await indexes(), recorded: await recorded() };
    await rollback(url, quiet, { dir, all: true });
    result.runner.empty = await recorded();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
