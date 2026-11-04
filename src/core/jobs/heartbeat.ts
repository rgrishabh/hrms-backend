import { readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Health signal of a process with no HTTP port: the worker writes this file on a timer, and `hrms worker-health` reads it.
 * `at` shows that the process is alive. `passStartedAt` and `passFinishedAt` show that the loop is not stuck.
 */
export interface Heartbeat { pid: number; at: number; passStartedAt: number | null; passFinishedAt: number | null }

export const HEARTBEAT_INTERVAL_MS = 15_000;
/** Longer than a job may run before the scheduler itself declares it dead. */
const MAX_PASS_MS = 75 * 60_000;

export const heartbeatFile = (source: NodeJS.ProcessEnv = process.env) => source.WORKER_HEARTBEAT_FILE ?? path.join(os.tmpdir(), 'hrms-worker-heartbeat.json');

export async function writeHeartbeat(file: string, h: Heartbeat) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(h), { mode: 0o600 });
  await rename(tmp, file);
}

/** Why the worker should be considered unhealthy, or null when it is fine. */
export function heartbeatProblem(h: Heartbeat, now: number, intervalMs: number): string | null {
  if (now - h.at > HEARTBEAT_INTERVAL_MS * 4) return `no heartbeat for ${Math.round((now - h.at) / 1000)}s`;
  const running = h.passStartedAt !== null && (h.passFinishedAt === null || h.passFinishedAt < h.passStartedAt);
  if (running && now - h.passStartedAt! > MAX_PASS_MS) return `a scheduler pass has been running for ${Math.round((now - h.passStartedAt!) / 60_000)} min`;
  if (!running && h.passFinishedAt !== null && now - h.passFinishedAt > intervalMs * 3 + 60_000) return `no scheduler pass for ${Math.round((now - h.passFinishedAt) / 1000)}s`;
  return null;
}

export async function readHeartbeat(file: string): Promise<Heartbeat> {
  return JSON.parse(await readFile(file, 'utf8')) as Heartbeat;
}
