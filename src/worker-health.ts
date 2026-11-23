import { HEARTBEAT_INTERVAL_MS, heartbeatFile, heartbeatProblem, readHeartbeat } from './core/jobs/heartbeat.js';

/** `hrms worker-health`: exit 0 when the worker's heartbeat is fresh and its loop is moving. For container probes. */
const intervalMs = Number(process.env.JOBS_INTERVAL_SECONDS ?? 60) * 1000;
try {
  const problem = heartbeatProblem(await readHeartbeat(heartbeatFile()), Date.now(), intervalMs || HEARTBEAT_INTERVAL_MS);
  if (problem) {
    process.stderr.write(`worker unhealthy: ${problem}\n`);
    process.exit(1);
  }
} catch (e) {
  process.stderr.write(`worker unhealthy: no heartbeat file (${(e as Error).message})\n`);
  process.exit(1);
}
