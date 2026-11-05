import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, randomToken, sha256 } from '../core/crypto/index.js';
import { pgSsl } from './ssl.js';
import { appUrl, loadInstallationEnv, organizationName, type InstallationEnv } from '../config/env.js';
import { reconcileInstallation, SINGLE_ORG_SLUG } from '../config/installation.js';

/**
 * Installation bootstrap — run once after the first migration, and safely on
 * every deploy afterwards (idempotent). Runs as the schema owner. There is no
 * HTTP endpoint for any of this.
 *
 *  1. Creates THE organization if the database has none (never a second one),
 *     then reconciles its name and domains from deployment configuration.
 *  2. Creates the FIRST administrator only. If any administrator already
 *     exists, it does nothing for admins unless --reset-admin is given.
 *     Credentials, by mode:
 *       setup-link (default): a one-time link (expires, single use, stored hashed)
 *                             printed to the operator's terminal. The token is in
 *                             the URL fragment so it never reaches server logs.
 *       password:             BOOTSTRAP_ADMIN_PASSWORD from a secret store; the
 *                             administrator must change it at first sign-in.
 *  3. --reset-admin <email>: recovery. Invalidates the current password and
 *     sessions of that administrator, unlocks the account, restores the
 *     administrator role, and issues new credentials (as per mode). They also
 *     become an owner when no other active owner exists, or with --make-owner,
 *     which is how ownership is handed over: nobody in the app is above an owner.
 *  4. --issue-link <email>: a one-time link for an existing user, nothing else. For an
 *     installation without email, where an invitation cannot reach them.
 */
export interface BootstrapOptions {
  admin: { email: string; displayName: string };
  mode: 'setup-link' | 'password';
  password?: string;
  resetAdmin?: boolean;
  /** With resetAdmin: this person also becomes an owner. The only way to appoint one, since nobody in the app is above an owner. */
  makeOwner?: boolean;
  /** Prints an invitation link for an existing user, changing nothing else. For an installation without email, where nothing else can reach them. */
  issueLink?: boolean;
  linkHours?: number;
}

export interface BootstrapResult {
  tenantId: string;
  organizationCreated: boolean;
  domains: string[];
  admin: 'created' | 'reset' | 'unchanged';
  setupUrl?: string;
  setupExpiresAt?: string;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function bootstrapInstallation(client: pg.Client | pg.PoolClient, env: InstallationEnv, o: BootstrapOptions): Promise<BootstrapResult> {
  const email = o.admin.email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error('admin email is invalid');
  if (o.mode === 'password' && (!o.password || o.password.length < 12)) throw new Error('password mode needs BOOTSTRAP_ADMIN_PASSWORD (min 12 characters)');
  const linkHours = o.linkHours ?? 24;
  if (linkHours < 1 || linkHours > 168) throw new Error('link validity must be 1–168 hours');

  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.platform_bypass', 'on', true)`);
    await client.query('SELECT pg_advisory_xact_lock(727275)');

    const existing = await client.query<{ id: string }>('SELECT id FROM tenants');
    if (existing.rowCount! > 1) throw new Error('this database contains more than one organization; refusing to continue');
    const organizationCreated = existing.rowCount === 0;
    if (organizationCreated) {
      await client.query(`INSERT INTO tenants (slug, name, timezone) VALUES ($1,$2,$3)`, [SINGLE_ORG_SLUG, organizationName(env), env.BRAND_TIMEZONE]);
    }
    const rec = (await reconcileInstallation(client, env))!;
    const tenantId = rec.tenantId;

    const user = (await client.query<{ id: string; is_admin: boolean }>(`SELECT u.id,
        EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role_key='tenant_admin') AS is_admin
      FROM users u WHERE u.tenant_id=$1 AND u.email=$2`, [tenantId, email])).rows[0];
    const admins = Number((await client.query<{ n: string }>(`SELECT count(DISTINCT r.user_id) AS n FROM user_roles r JOIN users u ON u.id=r.user_id
      WHERE r.tenant_id=$1 AND r.role_key='tenant_admin' AND u.status='active'`, [tenantId])).rows[0]!.n);

    let admin: BootstrapResult['admin'] = 'unchanged';
    let userId: string | null = null;
    if (!user) {
      if (admins > 0 && !o.resetAdmin) {
        // An administrator exists: bootstrap never adds more. Normal user management happens in the app.
      } else if (admins > 0 && o.resetAdmin) {
        throw new Error(`no user ${email} in this installation; --reset-admin works on an existing account`);
      } else {
        userId = (await client.query<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash, must_change_password)
          VALUES ($1,$2,$3,NULL,true) RETURNING id`, [tenantId, email, o.admin.displayName.trim() || 'Administrator'])).rows[0]!.id;
        await client.query(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'tenant_admin'), ($1,$2,'employee')`, [userId, tenantId]);
        // The first administrator is the Owner in every mode: someone has to sit above everyone, or nobody could ever produce a whole bank file.
        await client.query(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'owner')`, [userId, tenantId]);
        admin = 'created';
      }
    } else if (o.resetAdmin) {
      userId = user.id;
      await client.query(`UPDATE users SET password_hash=NULL, must_change_password=true, status='active', failed_logins=0, locked_until=NULL,
        mfa_secret_enc=NULL, mfa_pending_secret_enc=NULL, mfa_enabled_at=NULL, mfa_method=NULL, mfa_recovery_hashes='{}', mfa_last_step=NULL, mfa_failures=0, mfa_locked_until=NULL, updated_at=now() WHERE id=$1`, [userId]);
      await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
      await client.query(`UPDATE admin_setup_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL`, [userId]);
      if (!user.is_admin) await client.query(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'tenant_admin')`, [userId, tenantId]);
      // Recovery leaves someone at the top: the hierarchy has nobody else to appoint an owner.
      const ownerElsewhere = await client.query(`SELECT 1 FROM user_roles r JOIN users u ON u.id=r.user_id WHERE r.tenant_id=$1 AND r.role_key='owner' AND u.status='active' AND r.user_id <> $2 LIMIT 1`, [tenantId, userId]);
      if (o.makeOwner || !ownerElsewhere.rowCount) {
        await client.query(`INSERT INTO user_roles (user_id, tenant_id, role_key) SELECT $1,$2,'owner' WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id=$1 AND role_key='owner')`, [userId, tenantId]);
      }
      admin = 'reset';
    }

    let setupUrl: string | undefined; let setupExpiresAt: string | undefined;
    if (o.issueLink && !o.resetAdmin) {
      if (!user) throw new Error(`no user ${email} in this installation; create them in the app first`);
      await client.query(`UPDATE admin_setup_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL`, [user.id]);
      const token = randomToken(32);
      const exp = await client.query<{ expires_at: Date }>(`INSERT INTO admin_setup_tokens (tenant_id, user_id, token_hash, expires_at, purpose)
        VALUES ($1,$2,$3, now() + make_interval(hours => $4), 'invite') RETURNING expires_at`, [tenantId, user.id, sha256(token), linkHours]);
      setupUrl = `${appUrl(env)}/setup#token=${token}`;
      setupExpiresAt = exp.rows[0]!.expires_at.toISOString();
    }
    if (userId) {
      if (o.mode === 'password') {
        await client.query('UPDATE users SET password_hash=$2, must_change_password=true WHERE id=$1', [userId, await hashPassword(o.password!)]);
      } else {
        const token = randomToken(32);
        const exp = await client.query<{ expires_at: Date }>(`INSERT INTO admin_setup_tokens (tenant_id, user_id, token_hash, expires_at)
          VALUES ($1,$2,$3, now() + make_interval(hours => $4)) RETURNING expires_at`, [tenantId, userId, sha256(token), linkHours]);
        setupUrl = `${appUrl(env)}/setup#token=${token}`;
        setupExpiresAt = exp.rows[0]!.expires_at.toISOString();
      }
    }

    await client.query(`INSERT INTO audit_logs (tenant_id, actor_type, action, category, target_type, target_id, change_metadata)
      VALUES ($1,'system','installation.bootstrap','security','tenant',$2,$3)`,
      [tenantId, tenantId, JSON.stringify({ organizationCreated, domains: rec.domains, admin, adminEmail: email, mode: o.mode })]);
    await client.query('COMMIT');
    return { tenantId, organizationCreated, domains: rec.domains, admin, setupUrl, setupExpiresAt };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

/** CLI: flags or BOOTSTRAP_* env. The password is accepted ONLY from the environment. */
export function parseBootstrapArgs(argv: string[], env: NodeJS.ProcessEnv): BootstrapOptions {
  const flags = new Map<string, string>(); const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (key === 'admin-password' || key === 'password') throw new Error('passwords are not accepted as flags; set BOOTSTRAP_ADMIN_PASSWORD from a secret store, or use the default setup-link mode');
    if (key === 'reset-admin' || key === 'make-owner' || key === 'issue-link') { bools.add(key); continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`missing value for ${a}`);
    flags.set(key, v);
  }
  const get = (k: string) => flags.get(k) ?? env[`BOOTSTRAP_${k.toUpperCase().replace(/-/g, '_')}`];
  const email = get('admin-email');
  if (!email) throw new Error('--admin-email (or BOOTSTRAP_ADMIN_EMAIL) is required');
  const mode = (get('mode') ?? 'setup-link') as BootstrapOptions['mode'];
  if (!['setup-link', 'password'].includes(mode)) throw new Error("--mode must be 'setup-link' or 'password'");
  return {
    admin: { email, displayName: get('admin-name') ?? 'Administrator' }, mode,
    password: env.BOOTSTRAP_ADMIN_PASSWORD, resetAdmin: bools.has('reset-admin') || env.BOOTSTRAP_RESET_ADMIN === 'true', makeOwner: bools.has('make-owner') || env.BOOTSTRAP_MAKE_OWNER === 'true', issueLink: bools.has('issue-link'),
    linkHours: get('link-hours') ? Number(get('link-hours')) : undefined,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  (async () => {
    const url = process.env.DATABASE_MIGRATION_URL;
    if (!url) throw new Error('DATABASE_MIGRATION_URL is required');
    const env = loadInstallationEnv();
    const opts = parseBootstrapArgs(process.argv.slice(2), process.env);
    const c = new pg.Client({ connectionString: url, ssl: pgSsl() });
    await c.connect();
    try {
      const { setupUrl, ...r } = await bootstrapInstallation(c, env, opts);
      console.log(JSON.stringify({ ok: true, ...r }));
      if (setupUrl) {
        // Printed for the operator only (single use, expires). Do not paste it into tickets or chat.
        process.stdout.write(`\nOne-time setup link (valid until ${r.setupExpiresAt}):\n${setupUrl}\n\n`);
      }
    } finally { await c.end(); }
  })().catch((e) => { console.error(JSON.stringify({ ok: false, error: (e as Error).message })); process.exit(1); });
}
