import { randomUUID } from 'node:crypto';
import type { Pool } from '../../db/pool.js';
import { withPlatformBypass, withTenant } from '../../db/tx.js';
import { getSettingValue } from '../settings/service.js';
import { evaluateFeatures } from '../features/state.js';
import { JOBS, JOB_MAP, duePeriod, jobActive, type JobDefinition } from './registry.js';
import { deliverOutbox, deliverSmsOutbox } from '../notify/service.js';

/**
 * Database-backed scheduler. Every `intervalMs` each app instance:
 *  1. marks runs stuck in 'running' longer than the timeout as failed (crashed process);
 *  2. claims due scheduled runs by INSERTing (tenant, job, period) — the unique key means
 *     exactly one instance wins, the others skip;
 *  3. claims failed runs due for retry (attempts < MAX_ATTEMPTS, backoff 5 min × attempts).
 * Claims are committed before the job runs, in its own organization-scoped transaction.
 */
export const MAX_ATTEMPTS = 3;
const RUNNING_TIMEOUT_MIN = 60;

type Log = { info: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

export function localNow(tz: string, now: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

async function execute(pool: Pool, log: Log, tenantId: string, runId: string, job: JobDefinition, period: string, localDate: string, actorId: string | null) {
  const started = Date.now();
  try {
    const result = await withTenant(pool, tenantId, (db) => job.run(db, tenantId, { period, localDate, actorId }));
    await withTenant(pool, tenantId, (db) => db.query(`UPDATE job_runs SET status='succeeded', finished_at=now(), result=$3, error=NULL, next_retry_at=NULL
      WHERE tenant_id=$1 AND id=$2`, [tenantId, runId, JSON.stringify({ ...result, durationMs: Date.now() - started })]));
    log.info({ job: job.key, period, ms: Date.now() - started }, 'job succeeded');
    return { status: 'succeeded' as const, result };
  } catch (e) {
    const msg = ((e as Error).message ?? String(e)).slice(0, 1000);
    await withTenant(pool, tenantId, (db) => db.query(`UPDATE job_runs SET status='failed', finished_at=now(), error=$3,
      next_retry_at = CASE WHEN attempts < ${MAX_ATTEMPTS} THEN now() + make_interval(mins => 5 * attempts) END WHERE tenant_id=$1 AND id=$2`, [tenantId, runId, msg]));
    log.error({ job: job.key, period, err: msg }, 'job failed');
    return { status: 'failed' as const, error: msg };
  }
}

/** One scheduling pass. Exported for tests and the CLI. `now` is injectable for deterministic tests. */
export async function tick(pool: Pool, log: Log, now = new Date()) {
  const tenants = await withPlatformBypass(pool, (db) => db.query<{ id: string }>(`SELECT id FROM tenants WHERE status='active'`));
  const ran: { tenantId: string; job: string; period: string; status: string }[] = [];
  for (const { id: tenantId } of tenants.rows) {
    const { tz, usable } = await withTenant(pool, tenantId, async (db) => ({
      tz: await getSettingValue<string>(db, tenantId, 'general.timezone'),
      usable: new Map([...(await evaluateFeatures(db, tenantId)).values()].map((f) => [f.key, f.usable])),
    }));
    const { date, time } = localNow(tz, now);
    const due: { runId: string; job: JobDefinition; period: string }[] = [];
    await withTenant(pool, tenantId, async (db) => {
      await db.query(`UPDATE job_runs SET status='failed', finished_at=now(), error='Timed out (process stopped or job exceeded ${RUNNING_TIMEOUT_MIN} min)',
          next_retry_at = CASE WHEN attempts < ${MAX_ATTEMPTS} THEN now() END
        WHERE tenant_id=$1 AND status='running' AND started_at < now() - make_interval(mins => ${RUNNING_TIMEOUT_MIN})`, [tenantId]);
      for (const job of JOBS) {
        if (!jobActive(job, (k) => !!usable.get(k))) continue;
        const period = duePeriod(job.schedule, date, time);
        if (!period) continue;
        const claimed = await db.query<{ id: string }>(`INSERT INTO job_runs (tenant_id, job_key, period_key, trigger, status)
          VALUES ($1,$2,$3,'schedule','running') ON CONFLICT (tenant_id, job_key, period_key) DO NOTHING RETURNING id`, [tenantId, job.key, period]);
        if (claimed.rows[0]) due.push({ runId: claimed.rows[0].id, job, period });
      }
      const retries = await db.query<{ id: string; job_key: string; period_key: string }>(`UPDATE job_runs SET status='running', attempts=attempts+1, started_at=now(),
          finished_at=NULL, next_retry_at=NULL
        WHERE tenant_id=$1 AND status='failed' AND attempts < ${MAX_ATTEMPTS} AND next_retry_at <= now() AND trigger='schedule'
        RETURNING id, job_key, period_key`, [tenantId]);
      for (const r of retries.rows) {
        const job = JOB_MAP.get(r.job_key);
        if (job && jobActive(job, (k) => !!usable.get(k))) due.push({ runId: r.id, job, period: r.period_key });
      }
    });
    for (const d of due) {
      const r = await execute(pool, log, tenantId, d.runId, d.job, d.period, date, null);
      ran.push({ tenantId, job: d.job.key, period: d.period, status: r.status });
    }
  }
  return ran;
}

/** Manual run ("Run now"): always a new run, executed synchronously. Caller checks permission and feature. */
export async function runNow(pool: Pool, log: Log, tenantId: string, jobKey: string, actorId: string | null) {
  const job = JOB_MAP.get(jobKey);
  if (!job) throw new Error(`Unknown job ${jobKey}`);
  const tz = await withTenant(pool, tenantId, (db) => getSettingValue<string>(db, tenantId, 'general.timezone'));
  const { date } = localNow(tz, new Date());
  const runId = await withTenant(pool, tenantId, async (db) => (await db.query<{ id: string }>(`INSERT INTO job_runs (tenant_id, job_key, period_key, trigger, status, triggered_by)
    VALUES ($1,$2,$3,'manual','running',$4) RETURNING id`, [tenantId, jobKey, `manual:${randomUUID()}`, actorId])).rows[0]!.id);
  const r = await execute(pool, log, tenantId, runId, job, date, date, actorId);
  return { runId, ...r };
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private pool: Pool, private log: Log, private intervalMs = 60_000) {}
  start() {
    const loop = async () => {
      if (this.busy) return;
      this.busy = true;
      try { await tick(this.pool, this.log); } catch (e) { this.log.error({ err: (e as Error).message }, 'scheduler tick failed'); }
      try { await deliverOutbox(this.pool, this.log); } catch (e) { this.log.error({ err: (e as Error).message }, 'email delivery pass failed'); }
      try { await deliverSmsOutbox(this.pool, this.log); } catch (e) { this.log.error({ err: (e as Error).message }, 'sms delivery pass failed'); } finally { this.busy = false; }
    };
    setTimeout(loop, 10_000).unref();
    this.timer = setInterval(loop, this.intervalMs);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
