import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture } from './helpers.js';
import { TEST_SINGLE_B_APP_URL } from './env.js';
import { loadEnv } from '../src/config/env.js';
import { Scheduler, tick } from '../src/core/jobs/scheduler.js';
import { createPool } from '../src/db/pool.js';
import { heartbeatProblem } from '../src/core/jobs/heartbeat.js';
import { getMailer, setMailer, getFrom } from '../src/core/notify/mailer.js';
import { initRuntime } from '../src/core/runtime.js';
import { getStore } from '../src/core/storage/index.js';
import { createApprovalRequest } from '../src/core/workflow/engine.js';
import { withTenant } from '../src/db/tx.js';

const log = { info: () => undefined, error: () => undefined };
const baseEnv = { NODE_ENV: 'test', DATABASE_URL: TEST_SINGLE_B_APP_URL, DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), COOKIE_SECURE: 'false', LOG_LEVEL: 'silent' };
const TSX = ['--import', 'tsx'];

describe('initRuntime', () => {
  it('sets up everything a process needs without any HTTP server', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hrms-rt-'));
    initRuntime(loadEnv({ ...baseEnv, MAIL_TRANSPORT: 'log', MAIL_FROM_ADDRESS: 'x@example.test', STORAGE_DRIVER: 'local', STORAGE_PATH: dir }), log);
    expect(getMailer()).not.toBeNull();
    expect(getFrom()).toContain('x@example.test');
    expect(getStore()?.driver).toBe('local');
    setMailer(null);
  });

  it('registers approval handlers even if no route plugin ever ran', async () => {
    initRuntime(loadEnv(baseEnv), log);
    const T: TenantFixture = await createTenant();
    const pool = createPool(baseEnv.DATABASE_URL.replace('hrms_test_single_b', 'hrms_test'), 2);
    await expect(withTenant(pool, T.id, (db) => createApprovalRequest(db, T.id, { entityType: 'travel_request', entityId: T.id, requesterId: T.users.employee!.id, summary: 's',
      steps: [{ kind: 'user', userId: T.users.manager!.id }] }))).resolves.toBeTruthy();
    await pool.end();
  });
});

describe('"Run now" is queued for the worker', () => {
  let app: FastifyInstance; let T: TenantFixture; let hr: Client;
  beforeAll(async () => { app = await makeApp(); T = await createTenant(); hr = await Client.login(app, T.host, T.users.hr!.email); });
  afterAll(async () => { await app.close(); });

  it('the API records the request and does not run it; a worker pass does', async () => {
    const r = await hr.post('/api/v1/tenant/jobs/leave.accrual/run');
    expect(r.statusCode).toBe(202);
    expect(r.json().status).toBe('queued');
    const [before] = await ownerQuery<{ status: string }>('SELECT status FROM job_runs WHERE id=$1', [r.json().runId]);
    expect(before!.status).toBe('queued');
    await tick(app.deps.pool, log);
    const [after] = await ownerQuery<{ status: string }>('SELECT status FROM job_runs WHERE id=$1', [r.json().runId]);
    expect(after!.status).toBe('succeeded');
  });
});

describe('Scheduler', () => {
  it('stop() waits for the pass that is running and starts no other', async () => {
    let release = () => undefined as void;
    const gate = new Promise<void>((res) => { release = res; });
    const events: string[] = [];
    const pool = createPool(TEST_SINGLE_B_APP_URL, 2);
    const s = new Scheduler(pool, log, 60_000, { onPassStart: () => { events.push('start'); }, onPassEnd: () => { events.push('end'); } });
    const realConnect = pool.connect.bind(pool);
    // Hold the pass inside its first database call until released.
    (pool as unknown as { connect: () => Promise<unknown> }).connect = async () => { await gate; return realConnect(); };
    const running = s.pass();
    let stopped = false;
    const stopping = s.stop().then(() => { stopped = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(stopped).toBe(false);
    expect(events).toEqual(['start']);
    release();
    await stopping;
    await running;
    expect(events).toEqual(['start', 'end']);
    await s.pass();
    expect(events).toEqual(['start', 'end']);
    await pool.end();
  });
});

describe('worker health signal', () => {
  const now = 1_000_000_000;
  it('is healthy when fresh, unhealthy when silent or stuck', () => {
    const h = { pid: 1, at: now, passStartedAt: now - 1000, passFinishedAt: now - 500 };
    expect(heartbeatProblem(h, now, 60_000)).toBeNull();
    expect(heartbeatProblem({ ...h, at: now - 120_000 }, now, 60_000)).toMatch(/no heartbeat/);
    expect(heartbeatProblem({ ...h, passStartedAt: now - 80 * 60_000, passFinishedAt: now - 90 * 60_000 }, now, 60_000)).toMatch(/running for/);
    expect(heartbeatProblem({ ...h, passStartedAt: now - 10 * 60_000, passFinishedAt: now - 9 * 60_000 }, now, 60_000)).toMatch(/no scheduler pass/);
  });
});

describe('processes', () => {
  it('the worker starts, reports healthy, and exits cleanly on SIGTERM', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hrms-worker-'));
    const env = { ...process.env, ...baseEnv, WORKER_HEARTBEAT_FILE: path.join(dir, 'beat.json') };
    const unhealthy = spawnSync(process.execPath, [...TSX, 'src/worker-health.ts'], { env, encoding: 'utf8' });
    expect(unhealthy.status).toBe(1);

    const child = spawn(process.execPath, [...TSX, 'src/worker.ts'], { env, stdio: 'ignore' });
    const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
    for (let i = 0; i < 150 && !existsSync(env.WORKER_HEARTBEAT_FILE); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(env.WORKER_HEARTBEAT_FILE)).toBe(true);
    const healthy = spawnSync(process.execPath, [...TSX, 'src/worker-health.ts'], { env, encoding: 'utf8' });
    expect(healthy.stderr).toBe('');
    expect(healthy.status).toBe(0);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  }, 40_000);

  it('the worker refuses PROCESS_ROLE=api, and the API refuses PROCESS_ROLE=worker', () => {
    const w = spawnSync(process.execPath, [...TSX, 'src/worker.ts'], { env: { ...process.env, ...baseEnv, PROCESS_ROLE: 'api' }, encoding: 'utf8' });
    expect(w.status).toBe(1);
    expect(w.stderr).toMatch(/PROCESS_ROLE/);
    const a = spawnSync(process.execPath, [...TSX, 'src/server.ts'], { env: { ...process.env, ...baseEnv, PROCESS_ROLE: 'worker' }, encoding: 'utf8' });
    expect(a.status).toBe(1);
    expect(a.stderr).toMatch(/PROCESS_ROLE/);
  }, 40_000);
});
