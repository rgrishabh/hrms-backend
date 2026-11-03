import { loadEnv, type Env } from './config/env.js';
import { createPool } from './db/pool.js';
import { withPlatformBypass } from './db/tx.js';
import { FieldCipher } from './core/crypto/index.js';
import { buildApp } from './app.js';
import { reconcileInstallation } from './config/installation.js';
import { Scheduler } from './core/jobs/scheduler.js';

let env: Env;
try {
  env = loadEnv();
} catch (e) {
  // Configuration errors are listed field by field; secrets are never echoed.
  console.error((e as Error).message);
  process.exit(1);
}

const pool = createPool(env.DATABASE_URL, env.DATABASE_POOL_MAX);
let app: Awaited<ReturnType<typeof buildApp>>;
try {
  app = await buildApp({ env, pool, cipher: new FieldCipher(env.DATA_ENCRYPTION_KEY) });
} catch (e) {
  console.error(`Startup failed: ${(e as Error).message}`);
  process.exit(1);
}

// Refuse to serve if the runtime role could bypass RLS (defence in depth below the app's own checks).
const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
  'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
const r = role.rows[0];
if (r && (r.rolsuper || r.rolbypassrls)) {
  app.log.fatal(`Database role ${r.rolname} is superuser or BYPASSRLS. Use the restricted runtime role hrms_app (see DEPLOYMENT.md).`);
  process.exit(1);
}

// Align the organization name and domains with deployment configuration (idempotent).
try {
  const rec = await withPlatformBypass(pool, (db) => reconcileInstallation(db, env));
  if (!rec) app.log.warn('Installation not bootstrapped yet: run the bootstrap command (see DEPLOYMENT.md). Readiness will report unavailable until then.');
  else app.log.info({ domains: rec.domains }, 'installation configuration applied');
} catch (e) {
  app.log.fatal(`Cannot apply installation configuration: ${(e as Error).message}`);
  process.exit(1);
}

const scheduler = new Scheduler(pool, app.log, env.JOBS_INTERVAL_SECONDS * 1000);
if (env.JOBS_ENABLED) { scheduler.start(); app.log.info({ intervalSeconds: env.JOBS_INTERVAL_SECONDS }, 'background job scheduler started'); }

let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ sig }, 'shutting down gracefully');
    try { scheduler.stop(); await app.close(); await pool.end(); process.exit(0); } catch (e) { app.log.error(e); process.exit(1); }
  });
}

await app.listen({ port: env.PORT, host: env.HOST });
