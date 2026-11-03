import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '../../db/pool.js';
import { withPlatformBypass } from '../../db/tx.js';
import { tick, runNow } from './scheduler.js';
import { JOB_MAP } from './registry.js';

/**
 * Operator CLI (uses DATABASE_URL, the runtime role):
 *   node dist/src/core/jobs/cli.js tick          run one scheduling pass (due jobs only)
 *   node dist/src/core/jobs/cli.js run <job>     run a job now (e.g. leave.accrual)
 */
const log = { info: (o: object, m?: string) => console.log(JSON.stringify({ level: 'info', msg: m, ...o })), error: (o: object, m?: string) => console.error(JSON.stringify({ level: 'error', msg: m, ...o })) };

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [cmd, job] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }
  const pool = createPool(url, 2);
  (async () => {
    if (cmd === 'tick') console.log(JSON.stringify(await tick(pool, log)));
    else if (cmd === 'run' && job && JOB_MAP.has(job)) {
      const tenants = await withPlatformBypass(pool, (db) => db.query<{ id: string }>(`SELECT id FROM tenants WHERE status='active'`));
      for (const t of tenants.rows) console.log(JSON.stringify(await runNow(pool, log, t.id, job, null)));
    } else { console.error(`usage: cli.js tick | run <${[...JOB_MAP.keys()].join('|')}>`); process.exitCode = 2; }
  })().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
}
