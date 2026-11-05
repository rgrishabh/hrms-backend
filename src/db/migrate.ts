import { readdir, readFile } from 'node:fs/promises';
import { say, complain } from './cli-output.js';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { syncFeatureDefinitions } from '../core/features/sync.js';
import { pgSsl } from './ssl.js';
import { CODE_MIGRATIONS, type CodeMigrationContext } from './code-migrations.js';
import type { FieldCipher } from '../core/crypto/index.js';
import { loadFieldCipherFromProcess } from '../core/crypto/keys.js';

/** apps/api/migrations, whether running from src/db (tsx) or dist/src/db (compiled). */
function findMigrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return path.resolve(process.env.MIGRATIONS_DIR);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'migrations');
    if (existsSync(candidate) && existsSync(path.join(dir, 'package.json'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('migrations directory not found; set MIGRATIONS_DIR');
}
const MIGRATIONS_DIR = findMigrationsDir();

let shippedCache: string[] | null = null;
async function shippedMigrations(): Promise<string[]> {
  shippedCache ??= [...(await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')), ...CODE_MIGRATIONS.map((m) => m.name)].sort();
  return shippedCache;
}

/**
 * Compare applied migrations with those shipped in this build.
 * pending: shipped but not applied (run migrate). unknown: applied but not shipped
 * (the database is newer than this build — e.g. after a rollback; investigate).
 */
export async function migrationStatus(db: { query: pg.Pool['query'] } | pg.Client) {
  const shipped = await shippedMigrations();
  const exists = await (db as pg.Client).query<{ t: string | null }>(`SELECT to_regclass('public.schema_migrations') AS t`);
  const applied = exists.rows[0]!.t ? (await (db as pg.Client).query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name) : [];
  const set = new Set(applied);
  return { applied: applied.length, pending: shipped.filter((f) => !set.has(f)), unknown: applied.filter((a) => !shipped.includes(a)).sort() };
}

export interface MigrateOptions {
  /** The key for code migrations. Default: from the process's variables, and only if a step needs it. */
  cipher?: FieldCipher;
  /** Stop after this migration (tests, and a staged rollout of the expand step). */
  until?: string;
  /** Read migrations from here instead of the located directory (runner tests). */
  dir?: string;
}

/** Say how far. There is no default: nothing here rolls back everything by omission. */
export interface RollbackOptions {
  /** Undo this many of the most recently applied migrations. */
  steps?: number;
  /** Undo everything after this applied migration, which stays applied. */
  to?: string;
  /** Undo every applied migration. */
  all?: boolean;
  cipher?: FieldCipher;
  dir?: string;
  /** Stop inside a pair `rollsBackWith` says must go together. For the schema comparison test only; the CLI cannot set it. */
  allowUnsafeStop?: boolean;
}

const NO_TRANSACTION_MARKER = '-- hrms:no-transaction';

/** A file asking to run outside a transaction says so on its first line, for `CREATE INDEX CONCURRENTLY`. */
export function isNoTransaction(sql: string): boolean {
  return (sql.split('\n', 1)[0] ?? '').trim() === NO_TRANSACTION_MARKER;
}

/**
 * Split on top-level semicolons, for a no-transaction file: several statements sent as one simple query are one implicit
 * transaction, which CONCURRENTLY refuses. Knows comments, quoted strings and identifiers, E'' strings and dollar quoting.
 * Pieces holding only comments are dropped.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let hasCode = false;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
    } else if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; } else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; } else i++;
      }
    } else if (ch === "'" || ch === '"') {
      const escapes = ch === "'" && /[eE]/.test(sql[i - 1] ?? '') && !/[\w$]/.test(sql[i - 2] ?? '');
      hasCode = true;
      i++;
      while (i < sql.length) {
        if (escapes && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) { i += 2; continue; }
          break;
        }
        i++;
      }
      i++;
    } else if (ch === '$' && !/[\w$]/.test(sql[i - 1] ?? '')) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i))?.[0];
      hasCode = true;
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? sql.length : end + tag.length;
      } else i++;
    } else if (ch === ';') {
      if (hasCode) out.push(sql.slice(start, i).trim());
      start = i + 1;
      hasCode = false;
      i++;
    } else {
      if (!/\s/.test(ch)) hasCode = true;
      i++;
    }
  }
  if (hasCode) out.push(sql.slice(start).trim());
  return out;
}

/**
 * Runs one file and records the result. Normally all of it in one transaction. A no-transaction file runs statement by statement
 * and is recorded only after the last, so a failure part way leaves it unrecorded and the next run starts it again: that is why
 * such a file must be idempotent (IF NOT EXISTS, IF EXISTS).
 */
async function runFile(client: pg.Client, sql: string, record: () => Promise<unknown>): Promise<void> {
  if (isNoTransaction(sql)) {
    for (const statement of splitStatements(sql)) await client.query(statement);
    // A failed CREATE INDEX CONCURRENTLY leaves an invalid index behind, and IF NOT EXISTS is then satisfied by it.
    const invalid = await client.query<{ name: string }>(`SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT i.indisvalid ORDER BY 1`);
    if (invalid.rowCount) throw new Error(`invalid index left by an earlier attempt: ${invalid.rows.map((r) => r.name).join(', ')}. Drop it (DROP INDEX CONCURRENTLY) and run again`);
    await record();
    return;
  }
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await record();
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/**
 * Migrations in name order: SQL files, each in its own transaction (or statement by statement, if its first line says
 * `-- hrms:no-transaction`) and recorded with a checksum (an edited, already-applied file aborts the run), and typed code steps
 * (code-migrations.ts) for what SQL cannot do. A code step commits its own batches and is only recorded when it finishes, so an
 * interrupted one resumes on the next run. `rollback` below goes the other way.
 */
export async function migrate(connectionString: string, log: (m: string) => void = say, opts: MigrateOptions = {}): Promise<void> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const client = new pg.Client({ connectionString, ssl: pgSsl() });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    // Serialize concurrent deploys.
    await client.query(`SELECT pg_advisory_lock(727274)`);
    const applied = new Map((await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]));
    const code = new Map(CODE_MIGRATIONS.map((m) => [m.name, m]));
    const files = [...(await readdir(dir)).filter((f) => f.endsWith('.sql')), ...code.keys()].sort();
    let cipher = opts.cipher;
    const ctx: CodeMigrationContext = { client, log, cipher: async () => (cipher ??= await loadFieldCipherFromProcess()) };
    for (const file of files) {
      if (opts.until && file > opts.until) break;
      const step = code.get(file);
      if (step) {
        const prev = applied.get(file);
        if (prev && prev !== step.checksum) throw new Error(`Migration ${file} was modified after being applied`);
        if (prev) continue;
        log(`applying ${file}`);
        try {
          await step.up(ctx);
          await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, step.checksum]);
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
        }
        continue;
      }
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prev = applied.get(file);
      if (prev) {
        if (prev !== checksum) throw new Error(`Migration ${file} was modified after being applied`);
        continue;
      }
      log(`applying ${file}`);
      try {
        await runFile(client, sql, () => client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]));
      } catch (err) {
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    // Absent only when stopped before 001 (`until`), which has nothing to sync into.
    if ((await client.query<{ t: string | null }>(`SELECT to_regclass('public.feature_definitions') AS t`)).rows[0]!.t) await syncFeatureDefinitions(client);
    await client.query(`SELECT pg_advisory_unlock(727274)`);
  } finally {
    await client.end();
  }
}

function rollbackPlan(applied: string[], opts: RollbackOptions): string[] {
  const chosen = [opts.steps !== undefined, opts.to !== undefined, opts.all === true].filter(Boolean).length;
  if (chosen !== 1) throw new Error('Rollback needs exactly one of: steps, to, all');
  if (opts.all) return applied;
  if (opts.to !== undefined) {
    const at = applied.indexOf(opts.to);
    if (at < 0) throw new Error(`Cannot roll back to ${opts.to}: it is not an applied migration`);
    return applied.slice(0, at);
  }
  const steps = opts.steps!;
  if (!Number.isInteger(steps) || steps < 1) throw new Error('Rollback steps must be a whole number of at least 1');
  if (steps > applied.length) throw new Error(`Cannot roll back ${steps} steps: ${applied.length} applied`);
  return applied.slice(0, steps);
}

/**
 * Undoes applied migrations, newest first, under the same advisory lock. Each down file (migrations/down/<name>.sql) runs in its own
 * transaction, or statement by statement with the same first-line marker as a forward file, and its schema_migrations row goes with
 * it. Everything that could refuse is checked before the first change: a missing down, an edited forward file, stopping inside a
 * pair that must go together, and a key that cannot open what a code step has to open. Returns the names rolled back.
 * An interrupted rollback is resumed by asking again: what finished is no longer applied, and a code step skips what it already did.
 */
export async function rollback(connectionString: string, log: (m: string) => void = say, opts: RollbackOptions = {}): Promise<string[]> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const client = new pg.Client({ connectionString, ssl: pgSsl() });
  await client.connect();
  try {
    if (!(await client.query<{ t: string | null }>(`SELECT to_regclass('public.schema_migrations') AS t`)).rows[0]!.t) throw new Error('Nothing to roll back: no schema_migrations table');
    await client.query(`SELECT pg_advisory_lock(727274)`);
    const rows = (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows;
    const checksums = new Map(rows.map((r) => [r.name, r.checksum]));
    const plan = rollbackPlan(rows.map((r) => r.name).sort().reverse(), opts);
    const code = new Map(CODE_MIGRATIONS.map((m) => [m.name, m]));

    const downs = new Map<string, string>();
    const missing: string[] = [];
    for (const name of plan) {
      if (code.has(name)) continue;
      const file = path.join(dir, 'down', name);
      if (existsSync(file)) downs.set(name, await readFile(file, 'utf8'));
      else missing.push(name);
      const up = path.join(dir, name);
      if (existsSync(up) && createHash('sha256').update(await readFile(up, 'utf8')).digest('hex') !== checksums.get(name)) {
        throw new Error(`Migration ${name} was modified after being applied; its down file may not fit what the database holds`);
      }
    }
    if (missing.length) throw new Error(`Cannot roll back: no down file for ${missing.join(', ')} (expected in ${path.join(dir, 'down')}). Nothing was changed`);

    if (!opts.allowUnsafeStop) {
      for (const step of CODE_MIGRATIONS) {
        if (step.rollsBackWith && plan.includes(step.rollsBackWith) && !plan.includes(step.name)) {
          throw new Error(`Cannot stop at ${step.name}: rolling back ${step.rollsBackWith} leaves placeholder values that only rolling back ${step.name} replaces. Roll back further. Nothing was changed`);
        }
      }
    }

    let cipher = opts.cipher;
    const ctx: CodeMigrationContext = { client, log, cipher: async () => (cipher ??= await loadFieldCipherFromProcess()) };
    for (const name of plan) {
      try {
        await code.get(name)?.checkDown?.(ctx);
      } catch (err) {
        throw new Error(`Cannot roll back ${name}: ${(err as Error).message}. Nothing was changed`);
      }
    }

    for (const name of plan) {
      log(`rolling back ${name}`);
      const forget = () => client.query('DELETE FROM schema_migrations WHERE name=$1', [name]);
      try {
        const step = code.get(name);
        if (step) {
          await step.down(ctx);
          await forget();
        } else {
          await runFile(client, downs.get(name)!, forget);
        }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Rollback of ${name} failed: ${(err as Error).message}`);
      }
    }
    await client.query(`SELECT pg_advisory_unlock(727274)`);
    return plan;
  } finally {
    await client.end();
  }
}

/** The command line's `--rollback` arguments. Refuses a run that does not say how far. */
export function parseRollbackArgs(argv: readonly string[]): RollbackOptions {
  const usage = 'Say how far: --rollback --steps <n>, --rollback --to <migration name> (it stays applied), or --rollback --all';
  const value = (flag: string) => {
    const at = argv.indexOf(flag);
    if (at < 0) return undefined;
    const v = argv[at + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value. ${usage}`);
    return v;
  };
  const steps = value('--steps');
  const to = value('--to');
  const all = argv.includes('--all');
  if ([steps !== undefined, to !== undefined, all].filter(Boolean).length !== 1) throw new Error(usage);
  if (all) return { all: true };
  if (to !== undefined) return { to };
  if (!/^[1-9][0-9]*$/.test(steps!)) throw new Error(`--steps needs a whole number of at least 1. ${usage}`);
  return { steps: Number(steps) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) { complain('DATABASE_MIGRATION_URL is required'); process.exit(1); }
  if (process.argv.includes('--status')) {
    // Exit 0 when up to date, 2 when migrations are pending, 3 when the database is ahead of this build.
    const c = new pg.Client({ connectionString: url, ssl: pgSsl() });
    c.connect().then(() => migrationStatus(c)).then((st) => {
      say(JSON.stringify(st));
      process.exitCode = st.unknown.length ? 3 : st.pending.length ? 2 : 0;
    }).catch((e) => { complain(e.message); process.exitCode = 1; }).finally(() => c.end());
  } else if (process.argv.includes('--rollback')) {
    Promise.resolve().then(() => rollback(url, say, parseRollbackArgs(process.argv.slice(2))))
      .then((done) => say(`rolled back ${done.length} migration(s)`)).catch((e) => { complain(e.message); process.exit(1); });
  } else {
    migrate(url).then(() => say('migrations complete')).catch((e) => { complain(e.message); process.exit(1); });
  }
}
