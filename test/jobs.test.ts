import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture } from './helpers.js';
import { tick } from '../src/core/jobs/scheduler.js';
import { JOB_MAP, duePeriod, nextRun } from '../src/core/jobs/registry.js';
import { addDays, localDate } from '../src/modules/attendance/time.js';

const quiet = { info: () => undefined, error: () => undefined };
const today = localDate(new Date(), 'Asia/Kolkata');
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`);
const runsOf = (tenantId: string) => ownerQuery<{ job_key: string; period_key: string; status: string; attempts: number; error: string | null; result: any }>(
  `SELECT job_key, period_key, status, attempts, error, result FROM job_runs WHERE tenant_id=$1 ORDER BY job_key, started_at`, [tenantId]);

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });

describe('schedules', () => {
  it('computes the due period in the organization timezone', () => {
    expect(duePeriod({ kind: 'daily', at: '01:30' }, '2026-11-03', '01:29')).toBeNull();
    expect(duePeriod({ kind: 'daily', at: '01:30' }, '2026-11-03', '01:30')).toBe('2026-11-03');
    expect(duePeriod({ kind: 'monthly', day: 1, at: '02:00' }, '2026-11-01', '01:59')).toBeNull();
    expect(duePeriod({ kind: 'monthly', day: 1, at: '02:00' }, '2026-11-01', '02:00')).toBe('2026-11');
    expect(duePeriod({ kind: 'monthly', day: 1, at: '02:00' }, '2026-11-17', '00:10')).toBe('2026-11'); // catch-up later in the month
    expect(nextRun({ kind: 'daily', at: '01:30' }, '2026-12-31', '05:00')).toBe('2027-01-01 01:30');
    expect(nextRun({ kind: 'monthly', day: 1, at: '02:00' }, '2026-12-15', '05:00')).toBe('2027-01-01 02:00');
  });
});

describe('scheduler', () => {
  let T: TenantFixture;
  beforeAll(async () => { T = await createTenant(); });

  it('runs each due job once per period and does the work', async () => {
    await ownerQuery(`INSERT INTO leave_types (tenant_id, code, name, accrual_method, annual_entitlement) VALUES ($1,'CL','Casual',$2,12)`, [T.id, 'annual']);
    await ownerQuery(`INSERT INTO sessions (token_hash, csrf_hash, user_id, tenant_id, expires_at) VALUES ('old-'||gen_random_uuid(),'x',$1,$2, now() - interval '30 days')`, [T.users.employee!.id, T.id]);
    await tick(app.deps.pool, quiet, at(today, '23:00'));
    const runs = await runsOf(T.id);
    expect(runs.map((r) => `${r.job_key}:${r.status}`)).toEqual(['approvals.escalation:succeeded', 'approvals.reminder:succeeded', 'attendance.close_day:succeeded', 'leave.accrual:succeeded', 'sessions.cleanup:succeeded']);
    const close = runs.find((r) => r.job_key === 'attendance.close_day')!;
    expect(close).toMatchObject({ period_key: today, result: { date: addDays(today, -1) } });
    const days = await ownerQuery(`SELECT 1 FROM attendance_daily WHERE tenant_id=$1 AND work_date=$2`, [T.id, addDays(today, -1)]);
    expect(days.length).toBe(4); // every fixture employee has a calculated day
    expect(runs.find((r) => r.job_key === 'leave.accrual')!.result.credited).toBe(4);
    expect(runs.find((r) => r.job_key === 'sessions.cleanup')!.result.deleted).toBeGreaterThanOrEqual(1);
    await tick(app.deps.pool, quiet, at(today, '23:30'));
    expect((await runsOf(T.id)).length).toBe(5); // nothing re-runs within the same period
  });

  it('two instances ticking at the same moment still run each job exactly once', async () => {
    const U = await createTenant();
    const [a, b] = await Promise.all([tick(app.deps.pool, quiet, at(today, '23:00')), tick(app.deps.pool, quiet, at(today, '23:00'))]);
    const mine = [...a, ...b].filter((r) => r.tenantId === U.id);
    expect(mine.map((r) => r.job).sort()).toEqual(['approvals.escalation', 'approvals.reminder', 'attendance.close_day', 'leave.accrual', 'sessions.cleanup']);
    expect((await runsOf(U.id)).length).toBe(5);
  });

  it('does not run before the scheduled time', async () => {
    const V = await createTenant();
    await tick(app.deps.pool, quiet, at(today, '00:10'));
    const runs = (await runsOf(V.id)).map((r) => r.job_key);
    expect(runs).not.toContain('attendance.close_day'); // 01:30
    expect(runs).not.toContain('sessions.cleanup');     // 03:00
  });

  it('retries a failed run with backoff and records the error', async () => {
    const W = await createTenant();
    const job = JOB_MAP.get('sessions.cleanup')!;
    const original = job.run;
    (job as { run: typeof job.run }).run = async () => { throw new Error('simulated outage'); };
    try {
      await tick(app.deps.pool, quiet, at(today, '23:00'));
      const [failed] = (await runsOf(W.id)).filter((r) => r.job_key === 'sessions.cleanup');
      expect(failed).toMatchObject({ status: 'failed', attempts: 1, error: 'simulated outage' });
      await tick(app.deps.pool, quiet, at(today, '23:01'));
      expect((await runsOf(W.id)).find((r) => r.job_key === 'sessions.cleanup')!.attempts).toBe(1); // backoff not elapsed
    } finally {
      (job as { run: typeof job.run }).run = original;
    }
    await ownerQuery(`UPDATE job_runs SET next_retry_at = now() - interval '1 second' WHERE tenant_id=$1 AND job_key='sessions.cleanup'`, [W.id]);
    await tick(app.deps.pool, quiet, at(today, '23:10'));
    expect((await runsOf(W.id)).find((r) => r.job_key === 'sessions.cleanup')).toMatchObject({ status: 'succeeded', attempts: 2, error: null });
  });

  it('recovers a run left "running" by a crashed process', async () => {
    const X = await createTenant();
    await ownerQuery(`INSERT INTO job_runs (tenant_id, job_key, period_key, trigger, status, started_at) VALUES ($1,'sessions.cleanup',$2,'schedule','running', now() - interval '2 hours')`, [X.id, today]);
    await tick(app.deps.pool, quiet, at(today, '23:00'));
    expect((await runsOf(X.id)).find((r) => r.job_key === 'sessions.cleanup')).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('skips jobs whose module is disabled', async () => {
    const off = await makeApp({ ENABLED_MODULES: 'attendance,attendance.web,attendance.regularization,shifts,holidays' });
    const Y = await createTenant();
    await tick(off.deps.pool, quiet, at(today, '23:00'));
    expect((await runsOf(Y.id)).map((r) => r.job_key)).not.toContain('leave.accrual');
    await off.close();
    await makeApp().then((x) => x.close()); // restore default modules for this process
  });
});

describe('admin API', () => {
  it('lists jobs with next run and history; "Run now" needs the job permission and is audited', async () => {
    const Z = await createTenant();
    const hr = await Client.login(app, Z.host, Z.users.hr!.email);
    const emp = await Client.login(app, Z.host, Z.users.employee!.email);
    expect((await emp.post('/api/v1/tenant/jobs/leave.accrual/run')).statusCode).toBe(403);
    const r = await hr.post('/api/v1/tenant/jobs/leave.accrual/run');
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('succeeded');
    const list = (await hr.get('/api/v1/tenant/jobs')).json();
    const leave = list.items.find((j: { key: string }) => j.key === 'leave.accrual');
    expect(leave).toMatchObject({ active: true, canRun: true });
    expect(leave.recentRuns[0]).toMatchObject({ trigger: 'manual', status: 'succeeded', triggered_by_name: 'hr' });
    expect(list.items.find((j: { key: string }) => j.key === 'sessions.cleanup').canRun).toBe(false); // HR lacks security.manage
    expect((await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='job.run_requested'`, [Z.id])).length).toBe(1);
    expect((await hr.post('/api/v1/tenant/jobs/nope/run')).statusCode).toBe(404);
  });
});
