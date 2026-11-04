import { randomUUID } from 'node:crypto';
import type { Pool } from '../../db/pool.js';
import { withPlatformBypass, withTenant } from '../../db/tx.js';
import { getSettingValue } from '../settings/service.js';
import { evaluateFeatures } from '../features/state.js';
import { JOBS, JOB_MAP, duePeriod, jobActive, type JobDefinition } from './registry.js';
import { deliverOutbox, deliverPushOutbox } from '../notify/service.js';

/**
 * Database-backed scheduler, run by the worker. Every `intervalMs` each worker instance:
 *  1. marks runs stuck in 'running' longer than the timeout as failed (crashed process);
 *  2. claims due scheduled runs by INSERTing (tenant, job, period) — the unique key means
 *     exactly one instance wins, the others skip;
 *  3. claims failed runs due for retry (attempts < MAX_ATTEMPTS, backoff 5 min × attempts);
 *  4. claims runs queued by "Run now" in the API.
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
    ran.push(...await runQueued(pool, log, tenantId, now));
  }
  return ran;
}

/** Runs queued by "Run now" in the API, claimed so that only one worker takes each. */
export async function runQueued(pool: Pool, log: Log, tenantId: string, now: Date) {
  const { tz, claimed } = await withTenant(pool, tenantId, async (db) => ({
    tz: await getSettingValue<string>(db, tenantId, 'general.timezone'),
    claimed: (await db.query<{ id: string; job_key: string; triggered_by: string | null }>(
      `UPDATE job_runs SET status='running', started_at=now() WHERE id IN (
         SELECT id FROM job_runs WHERE tenant_id=$1 AND status='queued' ORDER BY started_at LIMIT 20 FOR UPDATE SKIP LOCKED)
       RETURNING id, job_key, triggered_by`, [tenantId])).rows,
  }));
  const { date } = localNow(tz, now);
  const ran: { tenantId: string; job: string; period: string; status: string }[] = [];
  for (const q of claimed) {
    const job = JOB_MAP.get(q.job_key);
    if (!job) continue;
    const r = await execute(pool, log, tenantId, q.id, job, date, date, q.triggered_by);
    ran.push({ tenantId, job: job.key, period: date, status: r.status });
  }
  return ran;
}

/**
 * "Run now" from the API: writes the request down and returns. The worker picks it up on its next pass, because only
 * the worker runs jobs. Caller checks permission and feature.
 */
export async function enqueueRun(pool: Pool, tenantId: string, jobKey: string, actorId: string | null) {
  if (!JOB_MAP.has(jobKey)) throw new Error(`Unknown job ${jobKey}`);
  const runId = await withTenant(pool, tenantId, async (db) => (await db.query<{ id: string }>(`INSERT INTO job_runs (tenant_id, job_key, period_key, trigger, status, triggered_by)
    VALUES ($1,$2,$3,'manual','queued',$4) RETURNING id`, [tenantId, jobKey, `manual:${randomUUID()}`, actorId])).rows[0]!.id);
  return { runId, status: 'queued' as const };
}

/** Operator CLI: run a job in this process, now. Always a new run. */
export async function runNow(pool: Pool, log: Log, tenantId: string, jobKey: string, actorId: string | null) {
  const job = JOB_MAP.get(jobKey);
  if (!job) throw new Error(`Unknown job ${jobKey}`);
  const tz = await withTenant(pool, tenantId, (db) => getSettingValue<string>(db, tenantId, 'general.timezone'));
  const { date } = localNow(tz, new Date());
  const { runId } = await enqueueRun(pool, tenantId, jobKey, actorId);
  await withTenant(pool, tenantId, (db) => db.query(`UPDATE job_runs SET status='running', started_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, runId]));
  const r = await execute(pool, log, tenantId, runId, job, date, date, actorId);
  return { runId, ...r };
}

export interface SchedulerHooks {
  /** Delay before the first pass. The API used to wait for its own startup; the worker has nothing to wait for. */
  initialDelayMs?: number;
  onPassStart?: () => void;
  onPassEnd?: () => void;
}

/** Runs only in the worker. Each pass: due and queued jobs, then outbox delivery, serially. */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;
  constructor(private pool: Pool, private log: Log, private intervalMs = 60_000, private hooks: SchedulerHooks = {}) {}

  /** One pass, unless one is already running or the scheduler is stopping. */
  pass(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.running ??= (async () => {
      this.hooks.onPassStart?.();
      try { await tick(this.pool, this.log); } catch (e) { this.log.error({ err: (e as Error).message }, 'scheduler tick failed'); }
      try { await deliverOutbox(this.pool, this.log); } catch (e) { this.log.error({ err: (e as Error).message }, 'email delivery pass failed'); }
      try { await deliverPushOutbox(this.pool, this.log); } catch (e) { this.log.error({ err: (e as Error).message }, 'push delivery pass failed'); }
      this.hooks.onPassEnd?.();
    })().finally(() => { this.running = null; });
    return this.running;
  }

  start() {
    this.first = setTimeout(() => { void this.pass(); }, this.hooks.initialDelayMs ?? 10_000);
    this.first.unref();
    this.timer = setInterval(() => { void this.pass(); }, this.intervalMs);
    this.timer.unref();
  }

  /** No new pass starts; resolves when the running one, if any, has finished. */
  async stop() {
    this.stopping = true;
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null; this.timer = null;
    await this.running;
  }
}
