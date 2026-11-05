import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrate } from '../src/db/migrate.js';
import { runMigrationCycle } from './migration-cycle.js';
import { TEST_OWNER_URL, TEST_SINGLE_OWNER_URL, TEST_SINGLE_B_OWNER_URL } from './env.js';

declare module 'vitest' {
  export interface ProvidedContext { migrationCycleFile: string }
}

/** Fresh schema for every test run: drop + migrate (exercises the migrations themselves). */
export default async function setup(project: TestProject) {
  // The rollback cycle needs a database to itself and none can be created (see migration-cycle.ts), so it goes first, on one the reset below then cleans.
  const dir = await mkdtemp(path.join(tmpdir(), 'hrms-migration-cycle-'));
  const file = path.join(dir, 'cycle.json');
  await runMigrationCycle(TEST_SINGLE_B_OWNER_URL, file);
  project.provide('migrationCycleFile', file);

  // hrms_test: isolation defence-in-depth suites (several organizations in one DB, test-only).
  // hrms_test_single(_b): two independent single-organization installations.
  for (const url of [TEST_OWNER_URL, TEST_SINGLE_OWNER_URL, TEST_SINGLE_B_OWNER_URL]) {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query('DROP SCHEMA IF EXISTS public CASCADE');
    await c.query('CREATE SCHEMA public');
    await c.end();
    await migrate(url, () => undefined);
  }
  return () => rm(dir, { recursive: true, force: true });
}
