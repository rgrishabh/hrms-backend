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

async function runTx<T>(pool: Pool, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
