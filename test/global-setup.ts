import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { TEST_OWNER_URL, TEST_SINGLE_OWNER_URL, TEST_SINGLE_B_OWNER_URL } from './env.js';

/** Fresh schema for every test run: drop + migrate (exercises the migrations themselves). */
export default async function setup() {
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
}
