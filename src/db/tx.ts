import type { Pool, Client } from './pool.js';

export type Db = Client;

/**
 * Run `fn` in a transaction scoped to one tenant. Sets transaction-local
 * `app.tenant_id`, which Postgres RLS policies enforce as a second layer
 * beneath the application's own tenant filters.
 */
export async function withTenant<T>(pool: Pool, tenantId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  return runTx(pool, async (db) => {
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    return fn(db);
  });
}

/**
 * A read that may run on a replica. RLS applies as on the primary, and READ ONLY means a stray write fails here too, on any host.
 * A replica that cannot be reached is not an outage: the primary answers.
 */
export async function withTenantRead<T>(read: Pool, primary: Pool, tenantId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  let pool = read;
  if (read !== primary) {
    try {
      (await read.connect()).release();
    } catch {
      pool = primary;
    }
  }
  return runTx(pool, async (db) => {
    await db.query('SET TRANSACTION READ ONLY');
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    return fn(db);
  });
}

/**
 * Explicit cross-tenant access, used ONLY for: domain->tenant resolution, login
 * lookup, device key lookup, and platform-admin operations. Every call site is
 * reviewed; grep for `withPlatformBypass` when auditing.
 */
export async function withPlatformBypass<T>(pool: Pool, fn: (db: Db) => Promise<T>): Promise<T> {
  return runTx(pool, async (db) => {
    await db.query(`SELECT set_config('app.platform_bypass', 'on', true)`);
    return fn(db);
  });
}

interface TxHooks {
  committed: (() => Promise<void>)[];
  ended: (() => void)[];
}
const hooks = new WeakMap<object, TxHooks>();

/**
 * Run `fn` once this connection's transaction has committed, and `end` when it is over either way. Outside
 * `withTenant`/`withPlatformBypass` (a task's own connection), `fn` runs at once: there is no commit to wait for here.
 */
export function afterCommit(db: Db, fn: () => Promise<void>, end?: () => void) {
  const h = hooks.get(db);
  if (!h) {
    void fn();
    end?.();
    return;
  }
  h.committed.push(fn);
  if (end) h.ended.push(end);
}

async function runTx<T>(pool: Pool, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const h: TxHooks = { committed: [], ended: [] };
  hooks.set(client, h);
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    for (const run of h.committed) await run();
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    hooks.delete(client);
    for (const end of h.ended) end();
    client.release();
  }
}
