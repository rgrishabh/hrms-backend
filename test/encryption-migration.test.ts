import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { migrate } from '../src/db/migrate.js';
import { CODE_MIGRATIONS } from '../src/db/code-migrations.js';
import { rotateKeys } from '../src/db/rotate-keys.js';
import { FieldCipher, keyIdOf } from '../src/core/crypto/index.js';
import { loadFieldCipher } from '../src/core/crypto/keys.js';
import { checkAdjustmentAmount, checkSalary } from '../src/modules/payroll/sealed.js';
import { TEST_SINGLE_B_OWNER_URL } from './env.js';
import { loadEnv } from '../src/config/env.js';
import { TEST_BRAND } from './env.js';

const KEY = Buffer.alloc(32, 9).toString('base64');
const cipher = new FieldCipher(KEY);
const STEP = '043_encrypt_l4_data.code';
const URL_ = TEST_SINGLE_B_OWNER_URL;

async function client() { const c = new pg.Client({ connectionString: URL_ }); await c.connect(); return c; }
async function reset() { const c = await client(); await c.query('DROP SCHEMA IF EXISTS public CASCADE'); await c.query('CREATE SCHEMA public'); await c.end(); }

/** Plaintext rows as the previous release wrote them, including a finalized run, whose guard must not stop the move. */
async function seed(c: pg.Client, n: number) {
  const t = (await c.query<{ id: string }>(`INSERT INTO tenants (slug, name) VALUES ('seeded','S') RETURNING id`)).rows[0]!.id;
  const le = (await c.query<{ id: string }>(`INSERT INTO legal_entities (tenant_id, name) VALUES ($1,'LE') RETURNING id`, [t])).rows[0]!.id;
  const br = (await c.query<{ id: string }>(`INSERT INTO branches (tenant_id, legal_entity_id, code, name, state) VALUES ($1,$2,'HQ','HQ','MH') RETURNING id`, [t, le])).rows[0]!.id;
  const u = (await c.query<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name) VALUES ($1,'a@s.test','A') RETURNING id`, [t])).rows[0]!.id;
  const run = (await c.query<{ id: string }>(`INSERT INTO payroll_runs (tenant_id, legal_entity_id, period, created_by, totals) VALUES ($1,$2,'2026-01',$3,'{"gross":1,"net":1}') RETURNING id`, [t, le, u])).rows[0]!.id;
  for (let i = 0; i < n; i++) {
    const e = (await c.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_code, first_name, legal_entity_id, branch_id, date_of_joining) VALUES ($1,$2,'E',$3,$4,'2024-01-01') RETURNING id`, [t, `E${i}`, le, br])).rows[0]!.id;
    await c.query(`INSERT INTO employee_salaries (tenant_id, employee_id, effective_from, amounts, annual_ctc, reason, status, created_by) VALUES ($1,$2,'2025-01-01',$3,$4,'r','active',$5)`, [t, e, JSON.stringify({ BASIC: 10000 + i }), 120000 + i, u]);
    await c.query(`INSERT INTO payroll_items (tenant_id, run_id, employee_id, days_in_period, employed_days, paid_days, lines, gross, deductions, net, employer_cost, warnings, calc_version) VALUES ($1,$2,$3,31,31,31,$4,$5,0,$5,$5,$6,6)`,
      [t, run, e, JSON.stringify([{ code: 'BASIC', amount: 10000 + i }]), 10000 + i, JSON.stringify(['short by ₹5'])]);
    await c.query(`INSERT INTO payroll_adjustments (tenant_id, run_id, employee_id, kind, label, amount, note, created_by) VALUES ($1,$2,$3,'earning','Arrears',$4,'note',$5)`, [t, run, e, 50 + i, u]);
  }
  await c.query(`UPDATE payroll_runs SET status='finalized' WHERE id=$1`, [run]);
  await c.query(`INSERT INTO accounting_exports (tenant_id, source_type, source_id, format, voucher_date, total, exported_by) VALUES ($1,'payroll_run',$2,'csv','2026-01-31',500,$3)`, [t, run, u]);
  await c.query(`INSERT INTO report_snapshots (tenant_id, owner_id, report_key, name, params, scope, columns, rows, totals, row_count, recipient_ids, expires_at) VALUES ($1,$3,'payroll_cost','x','{}','all','[]','[{"net":999}]','{"net":999}',1,$2, now()+interval '1 day'), ($1,$3,'leave_taken','y','{}','all','[]','[{"days":2}]',NULL,1,$2, now()+interval '1 day')`, [t, [u], u]);
  await c.query(`INSERT INTO audit_logs (tenant_id, action, change_metadata) VALUES ($1,'payroll.run_computed','{"gross":1234567,"warnings":2}')`, [t]);
  await c.query(`INSERT INTO notifications (tenant_id, user_id, kind, title, body) VALUES ($1,$2,'loans.disbursed','Loan paid: ₹60,000','From March')`, [t, u]);
  return t;
}

const stage = (until: string, cipherOverride = cipher) => migrate(URL_, () => undefined, { until, cipher: cipherOverride });

describe('code migration: encrypting pay', () => {
  afterAll(async () => { await reset(); await migrate(URL_, () => undefined); });

  it('runs through the runner on a seeded database, resumes after an interruption, then the plaintext goes', async () => {
    await reset();
    await stage('042_data_policy_expand.sql');
    const c = await client();
    await seed(c, 700);
    // Interrupted partway: the second batch of items fails on a key that cannot be used.
    const flaky = Object.create(cipher) as FieldCipher;
    let calls = 0;
    flaky.encrypt = (p: string) => { if (++calls > 1000) throw new Error('interrupted'); return cipher.encrypt(p); };
    await expect(migrate(URL_, () => undefined, { until: STEP, cipher: flaky })).rejects.toThrow(/interrupted/);
    const applied = await c.query(`SELECT 1 FROM schema_migrations WHERE name=$1`, [STEP]);
    expect(applied.rowCount).toBe(0);
    const sealed = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM employee_salaries WHERE amounts_enc IS NOT NULL`)).rows[0]!.n);
    expect(sealed).toBeGreaterThan(0);
    // A finalized run's guard is back on after the failure.
    await expect(c.query(`UPDATE payroll_items SET hold=true`)).rejects.toThrow(/finalized/);

    await stage(STEP);
    expect((await c.query(`SELECT 1 FROM schema_migrations WHERE name=$1`, [STEP])).rowCount).toBe(1);
    const i = (await c.query<{ data_enc: string; gross: string }>(`SELECT data_enc, gross FROM payroll_items ORDER BY gross LIMIT 1`)).rows[0]!;
    expect(JSON.parse(cipher.decrypt(i.data_enc))).toMatchObject({ gross: 10000, net: 10000, warnings: ['short by ₹5'] });
    expect((await c.query(`SELECT 1 FROM report_snapshots WHERE report_key='payroll_cost'`)).rowCount).toBe(0);
    const meta = (await c.query<{ change_metadata: object }>(`SELECT change_metadata FROM audit_logs WHERE action='payroll.run_computed'`)).rows[0]!.change_metadata;
    expect(JSON.stringify(meta)).not.toContain('1234567');
    expect((await c.query<{ title: string }>(`SELECT title FROM notifications`)).rows[0]!.title).not.toContain('60,000');

    // The decrypt path, for batch E's rollback.
    const down = CODE_MIGRATIONS.find((m) => m.name === STEP)!;
    await c.query(`UPDATE payroll_items SET gross=0, net=0`).catch(() => undefined);
    await down.down({ client: c, log: () => undefined, cipher: async () => cipher });
    const back = (await c.query<{ gross: string; net: string; data_enc: string | null; warnings: string[] }>(`SELECT gross, net, data_enc, warnings FROM payroll_items ORDER BY gross LIMIT 1`)).rows[0]!;
    expect(back).toMatchObject({ gross: '10000.00', net: '10000.00', data_enc: null, warnings: ['short by ₹5'] });
    const sal = (await c.query<{ amounts: object; annual_ctc: string; amounts_enc: string | null }>(`SELECT amounts, annual_ctc, amounts_enc FROM employee_salaries ORDER BY annual_ctc LIMIT 1`)).rows[0]!;
    expect(sal).toMatchObject({ amounts: { BASIC: 10000 }, annual_ctc: '120000.00', amounts_enc: null });
    // And up again: nothing is lost going round.
    await down.up({ client: c, log: () => undefined, cipher: async () => cipher });

    await migrate(URL_, () => undefined, { cipher });
    const cols = await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name='payroll_items' AND column_name='net'`);
    expect(cols.rowCount).toBe(0);
    const chain = (await c.query<{ ok: boolean; checked: string }>(`SELECT * FROM audit_chain_verify((SELECT id FROM tenants LIMIT 1))`)).rows[0]!;
    expect(chain.ok).toBe(true);
    expect(Number(chain.checked)).toBeGreaterThan(0);
    await c.end();
  }, 120000);

  it('a database with nothing to seal needs no key', async () => {
    await reset();
    await expect(migrate(URL_, () => undefined)).resolves.toBeUndefined();
  }, 60000);

  it('rotation rewrites everything with the new key, old values stay readable meanwhile, and a second run finds nothing', async () => {
    const c = await client();
    const t = (await c.query<{ id: string }>(`INSERT INTO tenants (slug, name) VALUES ('rotated','R') RETURNING id`)).rows[0]!.id;
    const le = (await c.query<{ id: string }>(`INSERT INTO legal_entities (tenant_id, name) VALUES ($1,'LE') RETURNING id`, [t])).rows[0]!.id;
    const br = (await c.query<{ id: string }>(`INSERT INTO branches (tenant_id, legal_entity_id, code, name, state) VALUES ($1,$2,'HQ','HQ','MH') RETURNING id`, [t, le])).rows[0]!.id;
    const u = (await c.query<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name) VALUES ($1,'a@r.test','A') RETURNING id`, [t])).rows[0]!.id;
    const e = (await c.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_code, first_name, legal_entity_id, branch_id, date_of_joining) VALUES ($1,'E','E',$2,$3,'2024-01-01') RETURNING id`, [t, le, br])).rows[0]!.id;
    const run = (await c.query<{ id: string }>(`INSERT INTO payroll_runs (tenant_id, legal_entity_id, period, created_by) VALUES ($1,$2,'2026-01',$3) RETURNING id`, [t, le, u])).rows[0]!.id;
    const old = new FieldCipher(KEY);
    await c.query(`INSERT INTO payroll_items (tenant_id, run_id, employee_id, days_in_period, employed_days, paid_days, data_enc, calc_version) VALUES ($1,$2,$3,31,31,31,$4,6)`, [t, run, e, old.encrypt('{"net":1}')]);
    await c.query(`UPDATE payroll_runs SET status='paid' WHERE id=$1`, [run]);
    // A value from before key ids existed.
    const iv = randomBytes(12);
    const nodeCrypto = await import('node:crypto');
    const k = Buffer.from(KEY, 'base64');
    const enc = nodeCrypto.createCipheriv('aes-256-gcm', k, iv);
    const data = Buffer.concat([enc.update('123456789012', 'utf8'), enc.final()]);
    const v1 = ['v1', iv.toString('base64'), enc.getAuthTag().toString('base64'), data.toString('base64')].join('.');
    await c.query(`INSERT INTO employee_bank_accounts (employee_id, tenant_id, account_holder, account_number_enc, account_last4, ifsc) VALUES ($1,$2,'H',$3,'9012','HDFC0001234')`, [e, t, v1]);

    const NEW = Buffer.alloc(32, 11).toString('base64');
    const next = new FieldCipher(NEW, [KEY]);
    expect(next.activeKeyId).toBe(keyIdOf(Buffer.from(NEW, 'base64')));
    expect(next.decrypt(v1)).toBe('123456789012');
    const first = await rotateKeys(URL_, next);
    expect(first['payroll_items.data_enc']).toBe(1);
    expect(first['employee_bank_accounts.account_number_enc']).toBe(1);
    const row = (await c.query<{ data_enc: string }>(`SELECT data_enc FROM payroll_items`)).rows[0]!;
    expect(row.data_enc.startsWith(`v2.${next.activeKeyId}.`)).toBe(true);
    expect(new FieldCipher(NEW).decrypt(row.data_enc)).toBe('{"net":1}');
    expect(() => new FieldCipher(KEY).decrypt(row.data_enc)).toThrow(/not loaded/);
    const again = await rotateKeys(URL_, next);
    expect(Object.values(again).every((n) => n === 0)).toBe(true);
    await expect(c.query(`UPDATE payroll_items SET hold=true`)).rejects.toThrow(/cannot be changed/);
    await c.end();
  }, 60000);
});

describe('key provider', () => {
  const key = Buffer.alloc(32, 3).toString('base64');
  it('KMS takes priority, unwraps once at startup, and the cipher is synchronous afterwards', async () => {
    let unwraps = 0;
    const c = await loadFieldCipher({ KMS_KEY_ID: 'k', DATA_KEY_CIPHERTEXT: 'wrapped', DATA_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64') }, async (ct, id) => { unwraps++; expect([ct, id]).toEqual(['wrapped', 'k']); return key; });
    const t = c.encrypt('x');
    expect(c.decrypt(t)).toBe('x');
    expect(t.startsWith(`v2.${keyIdOf(Buffer.from(key, 'base64'))}.`)).toBe(true);
    expect(unwraps).toBe(1);
  });
  it('dev uses DATA_ENCRYPTION_KEY, and no key at all is an error', async () => {
    expect((await loadFieldCipher({ DATA_ENCRYPTION_KEY: key })).activeKeyId).toBe(keyIdOf(Buffer.from(key, 'base64')));
    await expect(loadFieldCipher({})).rejects.toThrow(/No data key/);
  });
  it('configuration wants one key source, and both parts of the KMS one', () => {
    const base = { NODE_ENV: 'test', DATABASE_URL: 'postgres://x', ...TEST_BRAND };
    expect(() => loadEnv(base)).toThrow(/DATA_ENCRYPTION_KEY/);
    expect(() => loadEnv({ ...base, KMS_KEY_ID: 'k' })).toThrow(/DATA_KEY_CIPHERTEXT/);
    expect(loadEnv({ ...base, KMS_KEY_ID: 'k', DATA_KEY_CIPHERTEXT: 'c' }).KMS_KEY_ID).toBe('k');
  });
});

describe('rules that were check constraints on the plaintext columns', () => {
  it('payroll_adjustments.amount <> 0', () => {
    expect(() => checkAdjustmentAmount('earning', 0)).toThrow();
    expect(() => checkAdjustmentAmount('lop_days', 0)).toThrow();
    expect(() => checkAdjustmentAmount('earning', -5)).toThrow();
    expect(() => checkAdjustmentAmount('earning', Number.NaN)).toThrow();
    expect(() => checkAdjustmentAmount('lop_days', -1)).not.toThrow();
    expect(() => checkAdjustmentAmount('deduction', 5)).not.toThrow();
  });
  it('employee_salaries.amounts NOT NULL and annual_ctc numeric', () => {
    expect(() => checkSalary({}, null)).toThrow();
    expect(() => checkSalary({ BASIC: -1 }, null)).toThrow();
    expect(() => checkSalary({ BASIC: 1 }, 0)).toThrow();
    expect(() => checkSalary({ BASIC: 1 }, 1e11)).toThrow();
    expect(() => checkSalary({ BASIC: 1 }, 100)).not.toThrow();
  });
});
