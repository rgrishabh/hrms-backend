import pg from 'pg';
import { say, complain } from './cli-output.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pgSsl } from './ssl.js';

/**
 * Database provisioning for a fresh deployment (run as a one-off task with the
 * RDS master credentials, before migrations). Idempotent; also rotates the role
 * passwords to the values currently held in Secrets Manager.
 *
 *  hrms_owner — owns the schema, runs migrations/bootstrap/backups
 *  hrms_app   — runtime role: NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
 *
 * Env: DB_HOST, DB_PORT (5432), DB_NAME (hrms), DB_ADMIN_USER, DB_ADMIN_PASSWORD,
 *      DB_OWNER_PASSWORD, DB_APP_PASSWORD, DATABASE_SSL, DATABASE_CA_FILE
 */
const ROLES = ['hrms_owner', 'hrms_app'] as const;

export async function provisionDatabase(env: NodeJS.ProcessEnv = process.env, log: (m: string) => void = say) {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  const host = need('DB_HOST');
  const port = Number(env.DB_PORT ?? 5432);
  const dbName = env.DB_NAME ?? 'hrms';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(dbName)) throw new Error('DB_NAME must be a simple lowercase identifier');
  const passwords: Record<(typeof ROLES)[number], string> = { hrms_owner: need('DB_OWNER_PASSWORD'), hrms_app: need('DB_APP_PASSWORD') };
  for (const [r, p] of Object.entries(passwords)) if (p.length < 20) throw new Error(`password for ${r} must be at least 20 characters`);

  const admin = new pg.Client({ host, port, database: 'postgres', user: need('DB_ADMIN_USER'), password: need('DB_ADMIN_PASSWORD'), ssl: pgSsl(env) });
  await admin.connect();
  try {
    for (const role of ROLES) {
      const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount;
      const verb = exists ? 'ALTER' : 'CREATE';
      const sql = (
        await admin.query<{ s: string }>(`SELECT format('${verb} ROLE %I WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text, $2::text) AS s`, [
          role,
          passwords[role],
        ])
      ).rows[0]!.s;
      await admin.query(sql);
      log(`${exists ? 'updated' : 'created'} role ${role}`);
    }
    // Needed (PG16+) so the admin may create a database owned by hrms_owner.
    await admin.query(`GRANT hrms_owner TO CURRENT_USER`).catch(() => undefined);
    const db = (await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName])).rowCount;
    if (!db) {
      await admin.query(`CREATE DATABASE ${dbName} OWNER hrms_owner`);
      log(`created database ${dbName}`);
    }
    await admin.query(`REVOKE ALL ON DATABASE ${dbName} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${dbName} TO hrms_app`);
    await admin.query(`GRANT ALL ON DATABASE ${dbName} TO hrms_owner`);
    // Verify the runtime role cannot bypass RLS (e.g. if someone altered it manually).
    const r = (await admin.query<{ rolsuper: boolean; rolbypassrls: boolean }>(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='hrms_app'`)).rows[0]!;
    if (r.rolsuper || r.rolbypassrls) throw new Error('hrms_app must not be superuser or BYPASSRLS');
  } finally {
    await admin.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  provisionDatabase()
    .then(() => say('provisioning complete'))
    .catch((e) => {
      complain(`provisioning failed: ${(e as Error).message}`);
      process.exit(1);
    });
}
