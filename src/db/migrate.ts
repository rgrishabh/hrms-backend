import { readdir, readFile } from 'node:fs/promises';
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
}

/**
 * Forward-only migrations in name order: SQL files, each in its own transaction and recorded with a checksum (an edited,
 * already-applied file aborts the run), and typed code steps (code-migrations.ts) for what SQL cannot do. A code step commits
 * its own batches and is only recorded when it finishes, so an interrupted one resumes on the next run.
 */
export async function migrate(connectionString: string, log: (m: string) => void = console.log, opts: MigrateOptions = {}): Promise<void> {
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
    const files = [...(await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')), ...code.keys()].sort();
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
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prev = applied.get(file);
      if (prev) {
        if (prev !== checksum) throw new Error(`Migration ${file} was modified after being applied`);
        continue;
      }
      log(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    await syncFeatureDefinitions(client);
    await client.query(`SELECT pg_advisory_unlock(727274)`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) { console.error('DATABASE_MIGRATION_URL is required'); process.exit(1); }
  if (process.argv.includes('--status')) {
    // Exit 0 when up to date, 2 when migrations are pending, 3 when the database is ahead of this build.
    const c = new pg.Client({ connectionString: url, ssl: pgSsl() });
    c.connect().then(() => migrationStatus(c)).then((st) => {
      console.log(JSON.stringify(st));
      process.exitCode = st.unknown.length ? 3 : st.pending.length ? 2 : 0;
    }).catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => c.end());
  } else {
    migrate(url).then(() => console.log('migrations complete')).catch((e) => { console.error(e.message); process.exit(1); });
  }
}
