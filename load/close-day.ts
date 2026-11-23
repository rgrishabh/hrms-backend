/**
 * What `attendance.close_day` costs at the seeded head count: the job's own loop, through the same `withTenant` transaction the scheduler uses, counting statements.
 * Run after load/seed.ts, with DATABASE_URL, DATA_ENCRYPTION_KEY and every FEATURE_ variable as the server has them. Prints JSON.
 */
import { createPool } from '../src/db/pool.js';
import { withPlatformBypass, withTenant, type Db } from '../src/db/tx.js';
import { withMemo } from '../src/core/memo.js';
import { withFeatures } from '../src/core/features/state.js';
import { withMode } from '../src/core/policy/mode.js';
import { FEATURES } from '../src/core/features/registry.js';
import { recalculateRange } from '../src/modules/attendance/service.js';
import { addDays, localDate } from '../src/modules/attendance/time.js';

const pool = createPool(process.env.DATABASE_URL!, 2);
const features = new Set(FEATURES.filter((d) => d.availability !== 'planned').map((d) => d.key));
const tid = await withPlatformBypass(
  pool,
  async (db) => (await db.query<{ tenant_id: string }>(`SELECT tenant_id FROM tenant_domains WHERE hostname='load.test'`)).rows[0]?.tenant_id,
);
if (!tid) throw new Error('Seed first: no organization on load.test');
const day = addDays(localDate(new Date(), 'Asia/Kolkata'), -Number(process.env.DAYS_BACK ?? 1));

const result = await withMemo(new Map(), () =>
  withFeatures(features, () =>
    withMode('multi', () =>
      withTenant(pool, tid, async (db) => {
        let statements = 0;
        const counted = Object.create(db) as Db;
        counted.query = ((...args: Parameters<Db['query']>) => {
          statements++;
          return db.query(...args);
        }) as Db['query'];
        const emps = await db.query<{ id: string }>(
          `SELECT id FROM employees WHERE tenant_id=$1 AND date_of_joining <= $2 AND (exit_date IS NULL OR exit_date >= $2) AND status IN ('active','on_notice','exited')`,
          [tid, day],
        );
        const started = performance.now();
        const lap: number[] = [];
        for (const e of emps.rows) {
          const t = performance.now();
          await recalculateRange(counted, tid, e.id, day, day);
          lap.push(performance.now() - t);
        }
        const totalMs = performance.now() - started;
        lap.sort((a, b) => a - b);
        return {
          day,
          employees: emps.rows.length,
          statements,
          statementsPerEmployee: +(statements / emps.rows.length).toFixed(1),
          totalMs: Math.round(totalMs),
          p50Ms: +lap[lap.length >> 1]!.toFixed(1),
          p95Ms: +lap[Math.floor(lap.length * 0.95)]!.toFixed(1),
        };
      }),
    ),
  ),
);
process.stdout.write(`${JSON.stringify(result)}\n`);
await pool.end();
