import type pg from 'pg';
import type { FieldCipher } from '../core/crypto/index.js';
import { redact } from '../core/audit/audit.js';
import { scrubAmounts } from '../core/policy/text.js';

export interface CodeMigrationContext {
  /** The schema owner's connection. Migrations run with the advisory lock held; each step manages its own transactions. */
  client: pg.Client;
  log: (m: string) => void;
  /** The data key. Loaded only if asked for, so a database with nothing to encrypt needs no key. */
  cipher: () => Promise<FieldCipher>;
}

/**
 * A migration SQL cannot express, because it needs the application's key. `up` must be safe to run again after being
 * interrupted at any point. `down` undoes it: batch E's rollback calls it after re-adding what the later SQL dropped.
 */
export interface CodeMigration {
  name: string;
  /** Recorded like a file's checksum; change it only together with `name`. */
  checksum: string;
  up: (ctx: CodeMigrationContext) => Promise<void>;
  down: (ctx: CodeMigrationContext) => Promise<void>;
}

const BATCH = 500;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** One batch per transaction, so an interrupted run keeps what it committed; the guard on finalized runs stays off only inside it. */
async function batches(ctx: CodeMigrationContext, guard: { table: string; trigger: string } | null, batch: (c: pg.Client) => Promise<number>) {
  const { client } = ctx;
  for (;;) {
    await client.query('BEGIN');
    try {
      if (guard) await client.query(`ALTER TABLE ${guard.table} DISABLE TRIGGER ${guard.trigger}`);
      const n = await batch(client);
      if (guard) await client.query(`ALTER TABLE ${guard.table} ENABLE TRIGGER ${guard.trigger}`);
      await client.query('COMMIT');
      if (n < BATCH) return;
    } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; }
  }
}

const ITEM_GUARD = { table: 'payroll_items', trigger: 'payroll_items_guard' };
const ADJ_GUARD = { table: 'payroll_adjustments', trigger: 'payroll_adjustments_guard' };

/** Reports whose rows carry pay. Their old snapshots were made at their owner's level, so they cannot be kept for anyone. */
const L4_REPORTS = ['payroll_cost', 'department_overview'];

async function encryptUp(ctx: CodeMigrationContext) {
  const { client } = ctx;
  const count = async (sql: string) => Number((await client.query<{ n: string }>(sql)).rows[0]!.n);
  const pending = await count(`SELECT (SELECT count(*) FROM employee_salaries WHERE amounts_enc IS NULL) + (SELECT count(*) FROM payroll_items WHERE data_enc IS NULL)
    + (SELECT count(*) FROM payroll_runs WHERE totals IS NOT NULL AND totals_enc IS NULL) + (SELECT count(*) FROM payroll_adjustments WHERE data_enc IS NULL)
    + (SELECT count(*) FROM accounting_exports WHERE total_enc IS NULL) + (SELECT count(*) FROM report_snapshots WHERE data_enc IS NULL AND NOT (report_key = ANY('{${L4_REPORTS.join(',')}}'))) AS n`);
  // Nothing to seal means no key is needed: a new database, or the owner running migrations without the key.
  const c = pending ? await ctx.cipher() : null;
  const seal = (v: unknown) => c!.encrypt(typeof v === 'string' ? v : JSON.stringify(v));

  await batches(ctx, null, async (db) => {
    const r = await db.query<{ id: string; amounts: unknown; annual_ctc: string | null }>(`SELECT id, amounts, annual_ctc FROM employee_salaries WHERE amounts_enc IS NULL LIMIT ${BATCH} FOR UPDATE`);
    for (const x of r.rows) await db.query('UPDATE employee_salaries SET amounts_enc=$2, annual_ctc_enc=$3 WHERE id=$1', [x.id, seal(x.amounts), x.annual_ctc === null ? null : seal(x.annual_ctc)]);
    return r.rowCount ?? 0;
  });
  await batches(ctx, ITEM_GUARD, async (db) => {
    const r = await db.query<{ id: string; lines: unknown; gross: string; deductions: string; net: string; employer_cost: string; warnings: unknown }>(
      `SELECT id, lines, gross, deductions, net, employer_cost, warnings FROM payroll_items WHERE data_enc IS NULL LIMIT ${BATCH} FOR UPDATE`);
    for (const x of r.rows) await db.query('UPDATE payroll_items SET data_enc=$2 WHERE id=$1', [x.id, seal({ lines: x.lines, gross: num(x.gross), deductions: num(x.deductions), net: num(x.net), employerCost: num(x.employer_cost), warnings: x.warnings })]);
    return r.rowCount ?? 0;
  });
  await batches(ctx, null, async (db) => {
    const r = await db.query<{ id: string; totals: unknown }>(`SELECT id, totals FROM payroll_runs WHERE totals IS NOT NULL AND totals_enc IS NULL LIMIT ${BATCH} FOR UPDATE`);
    for (const x of r.rows) await db.query('UPDATE payroll_runs SET totals_enc=$2 WHERE id=$1', [x.id, seal(x.totals)]);
    return r.rowCount ?? 0;
  });
  await batches(ctx, ADJ_GUARD, async (db) => {
    const r = await db.query<{ id: string; amount: string; note: string | null }>(`SELECT id, amount, note FROM payroll_adjustments WHERE data_enc IS NULL LIMIT ${BATCH} FOR UPDATE`);
    for (const x of r.rows) await db.query('UPDATE payroll_adjustments SET data_enc=$2 WHERE id=$1', [x.id, seal({ amount: num(x.amount), note: x.note })]);
    return r.rowCount ?? 0;
  });
  await batches(ctx, null, async (db) => {
    const r = await db.query<{ id: string; total: string }>(`SELECT id, total FROM accounting_exports WHERE total_enc IS NULL LIMIT ${BATCH} FOR UPDATE`);
    for (const x of r.rows) await db.query('UPDATE accounting_exports SET total_enc=$2 WHERE id=$1', [x.id, seal(x.total)]);
    return r.rowCount ?? 0;
  });
  await client.query(`DELETE FROM report_snapshots WHERE report_key = ANY($1)`, [L4_REPORTS]);
  await batches(ctx, null, async (db) => {
    const r = await db.query<{ id: string; rows: unknown; totals: unknown }>(`SELECT id, rows, totals FROM report_snapshots WHERE data_enc IS NULL LIMIT ${BATCH} FOR UPDATE`);
    for (const x of r.rows) await db.query('UPDATE report_snapshots SET data_enc=$2 WHERE id=$1', [x.id, seal({ rows: x.rows, totals: x.totals })]);
    return r.rowCount ?? 0;
  });

  // Plaintext copies. The audit chain does not exist yet, so its hashes cover the cleaned rows.
  let after = '0';
  for (;;) {
    const r = await client.query<{ id: string; change_metadata: unknown }>(`SELECT id, change_metadata FROM audit_logs WHERE id > $1 ORDER BY id LIMIT ${BATCH}`, [after]);
    if (!r.rowCount) break;
    await client.query('BEGIN');
    for (const x of r.rows) {
      const clean = JSON.stringify(redact(x.change_metadata));
      if (clean !== JSON.stringify(x.change_metadata)) await client.query('UPDATE audit_logs SET change_metadata=$2 WHERE id=$1', [x.id, clean]);
    }
    await client.query('COMMIT');
    after = r.rows[r.rows.length - 1]!.id;
  }
  const money = String.raw`(₹|Rs\.?\s?[0-9]|INR\s?[0-9]|US\$|\$|€|£|¥)`;
  for (const [table, cols] of [['notifications', ['title', 'body']], ['email_outbox', ['subject', 'text_body', 'html_body']], ['approval_requests', ['summary']], ['separations', ['fnf_note']]] as const) {
    const where = cols.map((col) => `${col} ~ '${money}'`).join(' OR ');
    for (;;) {
      const r = await client.query<Record<string, string | null>>(`SELECT id, ${cols.join(', ')} FROM ${table} WHERE ${where} LIMIT ${BATCH}`);
      if (!r.rowCount) break;
      await client.query('BEGIN');
      let changed = 0;
      for (const x of r.rows) {
        const next = cols.map((col) => (x[col] === null ? null : scrubAmounts(x[col]!).replace(/₹|US\$|\$|€|£|¥/g, '')));
        await client.query(`UPDATE ${table} SET ${cols.map((col, i) => `${col}=$${i + 2}`).join(', ')} WHERE id=$1`, [x.id, ...next]);
        changed++;
      }
      await client.query('COMMIT');
      if (changed < BATCH) break;
    }
  }
}

/** Puts the sealed values back in the plaintext columns. Text and audit metadata that were cleaned stay clean, and old pay-report snapshots stay gone. */
async function encryptDown(ctx: CodeMigrationContext) {
  const c = await ctx.cipher();
  const open = <T>(v: string) => JSON.parse(c.decrypt(v)) as T;
  await batches(ctx, null, async (db) => {
    const r = await db.query<{ id: string; amounts_enc: string; annual_ctc_enc: string | null }>(`SELECT id, amounts_enc, annual_ctc_enc FROM employee_salaries WHERE amounts_enc IS NOT NULL LIMIT ${BATCH} FOR UPDATE`);
    for (const x of r.rows) await db.query('UPDATE employee_salaries SET amounts=$2, annual_ctc=$3, amounts_enc=NULL, annual_ctc_enc=NULL WHERE id=$1', [x.id, c.decrypt(x.amounts_enc), x.annual_ctc_enc ? c.decrypt(x.annual_ctc_enc) : null]);
    return r.rowCount ?? 0;
  });
  await batches(ctx, ITEM_GUARD, async (db) => {
    const r = await db.query<{ id: string; data_enc: string }>(`SELECT id, data_enc FROM payroll_items WHERE data_enc IS NOT NULL LIMIT ${BATCH} FOR UPDATE`);
    for (const x of r.rows) {
      const d = open<{ lines: unknown; gross: number; deductions: number; net: number; employerCost: number; warnings: unknown }>(x.data_enc);
      await db.query('UPDATE payroll_items SET lines=$2, gross=$3, deductions=$4, net=$5, employer_cost=$6, warnings=$7, data_enc=NULL WHERE id=$1', [x.id, JSON.stringify(d.lines), d.gross, d.deductions, d.net, d.employerCost, JSON.stringify(d.warnings)]);
    }
    return r.rowCount ?? 0;
  });
  await batches(ctx, null, async (db) => {
    const r = await db.query<{ id: string; totals_enc: string }>(`SELECT id, totals_enc FROM payroll_runs WHERE totals_enc IS NOT NULL LIMIT ${BATCH} FOR UPDATE`);
    for (const x of r.rows) await db.query('UPDATE payroll_runs SET totals=$2, totals_enc=NULL WHERE id=$1', [x.id, c.decrypt(x.totals_enc)]);
    return r.rowCount ?? 0;
  });
  await batches(ctx, ADJ_GUARD, async (db) => {
    const r = await db.query<{ id: string; data_enc: string }>(`SELECT id, data_enc FROM payroll_adjustments WHERE data_enc IS NOT NULL LIMIT ${BATCH} FOR UPDATE`);
    for (const x of r.rows) { const d = open<{ amount: number; note: string | null }>(x.data_enc); await db.query('UPDATE payroll_adjustments SET amount=$2, note=$3, data_enc=NULL WHERE id=$1', [x.id, d.amount, d.note]); }
    return r.rowCount ?? 0;
  });
  await batches(ctx, null, async (db) => {
    const r = await db.query<{ id: string; total_enc: string }>(`SELECT id, total_enc FROM accounting_exports WHERE total_enc IS NOT NULL LIMIT ${BATCH} FOR UPDATE`);
    for (const x of r.rows) await db.query('UPDATE accounting_exports SET total=$2, total_enc=NULL WHERE id=$1', [x.id, c.decrypt(x.total_enc)]);
    return r.rowCount ?? 0;
  });
  await batches(ctx, null, async (db) => {
    const r = await db.query<{ id: string; data_enc: string }>(`SELECT id, data_enc FROM report_snapshots WHERE data_enc IS NOT NULL LIMIT ${BATCH} FOR UPDATE`);
    for (const x of r.rows) { const d = open<{ rows: unknown; totals: unknown }>(x.data_enc); await db.query('UPDATE report_snapshots SET rows=$2, totals=$3, data_enc=NULL WHERE id=$1', [x.id, JSON.stringify(d.rows), d.totals === null ? null : JSON.stringify(d.totals)]); }
    return r.rowCount ?? 0;
  });
}

export const CODE_MIGRATIONS: readonly CodeMigration[] = [
  { name: '043_encrypt_l4_data.code', checksum: 'code:043:v1', up: encryptUp, down: encryptDown },
];
