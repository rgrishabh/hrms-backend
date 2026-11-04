import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { loadEnv } from '../../config/env.js';
import { createPool } from '../../db/pool.js';
import { withPlatformBypass } from '../../db/tx.js';
import { initRuntime } from '../runtime.js';
import { withFeatures } from '../features/state.js';
import { tick, runNow } from './scheduler.js';
import { JOB_MAP } from './registry.js';

/**
 * Operator CLI (same configuration as the worker, DATABASE_URL is the runtime role):
 *   node dist/src/core/jobs/cli.js tick          run one scheduling pass (due and queued jobs)
 *   node dist/src/core/jobs/cli.js run <job>     run a job now (e.g. leave.accrual)
 */
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [cmd, job] = process.argv.slice(2);
  const env = loadEnv({ ...process.env, PROCESS_ROLE: 'worker' });
  const log = pino({ level: env.LOG_LEVEL, base: { role: 'cli' } });
  const { features, close } = initRuntime(env, log);
  const pool = createPool(env.DATABASE_URL, 2);
  withFeatures(features, async () => {
    if (cmd === 'tick') log.info({ ran: await tick(pool, log) }, 'tick finished');
    else if (cmd === 'run' && job && JOB_MAP.has(job)) {
      const tenants = await withPlatformBypass(pool, (db) => db.query<{ id: string }>(`SELECT id FROM tenants WHERE status='active'`));
      for (const t of tenants.rows) log.info(await runNow(pool, log, t.id, job, null), 'job finished');
    } else { log.error(`usage: cli.js tick | run <${[...JOB_MAP.keys()].join('|')}>`); process.exitCode = 2; }
  }).catch((e: Error) => { log.error(e.message); process.exitCode = 1; }).finally(async () => { await close(); await pool.end(); });
}
