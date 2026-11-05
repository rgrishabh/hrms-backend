import pg from 'pg';
import { pgSsl } from './ssl.js';

// Return DATE columns as 'YYYY-MM-DD' strings; never shift them through JS Date/timezones.
pg.types.setTypeParser(1082, (v) => v);
// NUMERIC stays a string to avoid float rounding; money code uses decimal.js.
pg.types.setTypeParser(1700, (v) => v);

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

/** DATABASE_URL pointed at the replica: host, or host:port. */
export function readUrl(databaseUrl: string, readHost: string) {
  const u = new URL(databaseUrl);
  const [host, port] = readHost.split(':');
  u.hostname = host!;
  if (port) u.port = port;
  return u.toString();
}

export function createPool(connectionString: string, max = 20): pg.Pool {
  const pool = new pg.Pool({ connectionString, ssl: pgSsl(), max, idleTimeoutMillis: 30_000, statement_timeout: 30_000 });
  pool.on('error', (err) => {
    // Idle client errors must not crash the process; logged by caller's logger in server.ts.
    process.emitWarning(`pg pool error: ${err.message}`);
  });
  return pool;
}
