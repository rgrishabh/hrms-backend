import pino from 'pino';
import { loadEnv, type Env } from './config/env.js';
import { createPool } from './db/pool.js';
import { initRuntime, type Runtime } from './core/runtime.js';
import { withFeatures } from './core/features/state.js';
import { withMode } from './core/policy/mode.js';
import { loadFieldCipher } from './core/crypto/keys.js';
import { LOG_REDACT_PATHS, logSerializers } from './core/logging.js';
import { unsafeDatabaseRole } from './core/db-role.js';
import { Scheduler } from './core/jobs/scheduler.js';
import { HEARTBEAT_INTERVAL_MS, heartbeatFile, writeHeartbeat, type Heartbeat } from './core/jobs/heartbeat.js';

/**
 * The background process (PROCESS_ROLE=worker, `hrms worker`): runs scheduled and queued jobs and delivers the outbox.
 * It takes no traffic. Runs are claimed in the database, so extra replicas are safe.
 */
let env: Env;
try {
  env = loadEnv({ PROCESS_ROLE: 'worker', ...process.env });
  if (env.PROCESS_ROLE !== 'worker') throw new Error('Invalid deployment configuration:\n  - PROCESS_ROLE: this command is the worker, but PROCESS_ROLE says api');
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
}

const log = pino({ level: env.LOG_LEVEL, base: { role: 'worker' }, redact: LOG_REDACT_PATHS, serializers: logSerializers });
const pool = createPool(env.DATABASE_URL, env.DATABASE_POOL_MAX);

let runtime: Runtime;
try {
  runtime = initRuntime(env, log, { cipher: await loadFieldCipher(env) });
} catch (e) {
  log.fatal(`Startup failed: ${(e as Error).message}`);
  process.exit(1);
}
const unsafe = await unsafeDatabaseRole(pool);
if (unsafe) { log.fatal(unsafe); process.exit(1); }

const file = heartbeatFile();
const beat: Heartbeat = { pid: process.pid, at: Date.now(), passStartedAt: null, passFinishedAt: null };
let warned = false;
const writeBeat = async () => {
  beat.at = Date.now();
  try { await writeHeartbeat(file, beat); } catch (e) {
    if (!warned) { warned = true; log.warn({ file, err: (e as Error).message }, 'cannot write worker heartbeat'); }
  }
};

const scheduler = new Scheduler(pool, log, env.JOBS_INTERVAL_SECONDS * 1000, {
  initialDelayMs: 0,
  onPassStart: () => { beat.passStartedAt = Date.now(); },
  onPassEnd: () => { beat.passFinishedAt = Date.now(); },
});
await writeBeat();
const heartbeat = setInterval(() => { void writeBeat(); }, HEARTBEAT_INTERVAL_MS);
// The whole loop runs with this deployment's feature set.
withFeatures(runtime.features, () => withMode(env.ORG_MANAGEMENT_MODE, () => { scheduler.start(); }));
// Timers of the scheduler are unref'd; this one keeps the process up until a signal.
log.info({ intervalSeconds: env.JOBS_INTERVAL_SECONDS }, 'worker started');

let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ sig }, 'worker shutting down: waiting for the running job');
    try {
      await scheduler.stop();
      clearInterval(heartbeat);
      await runtime.close();
      await pool.end();
      process.exit(0);
    } catch (e) { log.error(e); process.exit(1); }
  });
}
