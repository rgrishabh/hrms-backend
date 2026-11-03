import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';

/**
 * TLS for PostgreSQL connections, shared by the server, migrations, bootstrap
 * and provisioning. Configure with env, never with `sslmode` in the URL:
 *   DATABASE_SSL=verify-full  DATABASE_CA_FILE=/app/certs/rds-global-bundle.pem
 * 'verify-full' checks the certificate chain and hostname (required in production).
 */
export function pgSsl(env: NodeJS.ProcessEnv = process.env): ConnectionOptions | undefined {
  const mode = env.DATABASE_SSL ?? 'disable';
  if (mode === 'disable') return undefined;
  if (mode !== 'verify-full') throw new Error(`DATABASE_SSL must be 'disable' or 'verify-full', got '${mode}'`);
  return { rejectUnauthorized: true, ca: env.DATABASE_CA_FILE ? readFileSync(env.DATABASE_CA_FILE, 'utf8') : undefined };
}
