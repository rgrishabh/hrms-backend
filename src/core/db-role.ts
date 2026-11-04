import type { Pool } from '../db/pool.js';

/** Refuse to run if the runtime role could bypass RLS (defence in depth below the app's own checks). Returns the problem. */
export async function unsafeDatabaseRole(pool: Pool): Promise<string | null> {
  const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
    'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  const r = role.rows[0];
  return r && (r.rolsuper || r.rolbypassrls) ? `Database role ${r.rolname} is superuser or BYPASSRLS. Use the restricted runtime role hrms_app (see DEPLOYMENT.md).` : null;
}
