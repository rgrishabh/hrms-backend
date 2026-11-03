import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { makeApp, Client } from './helpers.js';
import { TEST_SINGLE_APP_URL, TEST_SINGLE_OWNER_URL, TEST_SINGLE_B_APP_URL, TEST_SINGLE_B_OWNER_URL } from './env.js';
import { bootstrapInstallation, parseBootstrapArgs, type BootstrapOptions } from '../src/db/bootstrap.js';
import { loadInstallationEnv } from '../src/config/env.js';
import { migrationStatus } from '../src/db/migrate.js';

/**
 * Two independent installations (separate databases, separate configuration),
 * exactly as two customers would be deployed.
 */
const A = { host: 'hrms.acme-labs.test', owner: TEST_SINGLE_OWNER_URL, app: TEST_SINGLE_APP_URL };
const B = { host: 'hrms.beta-labs.test', owner: TEST_SINGLE_B_OWNER_URL, app: TEST_SINGLE_B_APP_URL };
const envA = { APP_URL: `http://${A.host}`, APP_EXTRA_DOMAINS: 'hr.acme-labs.test', ORGANIZATION_NAME: 'Acme Testing Laboratories', ORGANIZATION_TIMEZONE: 'Asia/Kolkata' };
const envB = { APP_URL: `http://${B.host}`, ORGANIZATION_NAME: 'Beta Environmental Services', ORGANIZATION_TIMEZONE: 'Asia/Kolkata' };

async function withOwner<T>(url: string, fn: (c: pg.Client) => Promise<T>) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
const boot = (inst: typeof A, env: Record<string, string>, o: Partial<BootstrapOptions> = {}) =>
  withOwner(inst.owner, (c) => bootstrapInstallation(c, loadInstallationEnv(env), { admin: { email: 'owner@acme-labs.test', displayName: 'Owner' }, mode: 'setup-link', ...o }));
const q = <T extends pg.QueryResultRow>(url: string, sql: string, p: unknown[] = []) => withOwner(url, async (c) => {
  await c.query('BEGIN'); await c.query(`SELECT set_config('app.platform_bypass','on',true)`);
  const r = await c.query<T>(sql, p); await c.query('COMMIT'); return r.rows;
});
const tokenOf = (url: string) => new URL(url).hash.replace('#token=', '');

let appA: FastifyInstance; let appB: FastifyInstance; let brandDir: string; let webDir: string;
beforeAll(async () => {
  brandDir = mkdtempSync(path.join(tmpdir(), 'hrms-brand-'));
  writeFileSync(path.join(brandDir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  writeFileSync(path.join(brandDir, 'notes.txt'), 'not an image');
  webDir = mkdtempSync(path.join(tmpdir(), 'hrms-web-'));
  mkdirSync(path.join(webDir, 'assets'));
  writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8" /><title>HRMS</title></head><body><div id="root"></div></body></html>');
  writeFileSync(path.join(webDir, 'assets', 'app-abc123.js'), 'console.log(1)');
  appA = await makeApp({ DATABASE_URL: A.app, ...envA, WEB_DIST_DIR: webDir, BRANDING_DIR: brandDir,
    PRODUCT_NAME: 'LabHRMS', BRAND_NAME: 'Acme Labs', BRAND_SHORT_NAME: 'Acme & Co <HR>', BRAND_PRIMARY_COLOR: '#14532D',
    BRAND_LOGO_URL: '/branding/logo.svg', BRAND_SUPPORT_EMAIL: 'hr-support@acme-labs.test', ORGANIZATION_DATE_FORMAT: 'DD-MM-YYYY' });
  appB = await makeApp({ DATABASE_URL: B.app, ...envB, PRODUCT_NAME: 'LabHRMS', BRAND_NAME: 'Beta Env', BRAND_PRIMARY_COLOR: '#7A2E0F',
    BRAND_LOGO_URL: 'https://cdn.beta-labs.test/logo.png' });
});
afterAll(async () => { await appA.close(); await appB.close(); });

describe('before bootstrap', () => {
  it('is not ready and serves no organization', async () => {
    expect((await appA.inject({ url: '/health/live' })).statusCode).toBe(200);
    expect((await appA.inject({ url: '/health/ready' })).statusCode).toBe(503);
    expect((await new Client(appA, A.host).get('/api/v1/public/config')).statusCode).toBe(404);
  });
});

describe('bootstrap: first administrator via one-time setup link', () => {
  let setupUrl = '';
  it('creates the organization, its domains and an administrator without a password', async () => {
    const r = await boot(A, envA);
    expect(r).toMatchObject({ organizationCreated: true, admin: 'created', domains: [A.host, 'hr.acme-labs.test'] });
    expect(r.setupUrl).toMatch(new RegExp(`^http://${A.host}/setup#token=[A-Za-z0-9_-]{40,}$`));
    setupUrl = r.setupUrl!;
    const [u] = await q<{ password_hash: string | null; must_change_password: boolean }>(A.owner, `SELECT password_hash, must_change_password FROM users WHERE email='owner@acme-labs.test'`);
    expect(u).toEqual({ password_hash: null, must_change_password: true });
    const tokens = await q<{ token_hash: string }>(A.owner, 'SELECT token_hash FROM admin_setup_tokens');
    expect(tokens[0]!.token_hash).not.toBe(tokenOf(setupUrl)); // stored hashed only
    expect((await appA.inject({ url: '/health/ready' })).statusCode).toBe(200);
  });

  it('the link sets a password once; weak passwords and reuse are rejected', async () => {
    const c = new Client(appA, A.host);
    expect((await c.post('/api/v1/auth/login', { email: 'owner@acme-labs.test', password: 'anything-at-all' })).statusCode).toBe(401);
    expect((await c.post('/api/v1/auth/setup', { token: tokenOf(setupUrl), newPassword: 'short' })).statusCode).toBe(400);
    expect((await c.post('/api/v1/auth/setup', { token: tokenOf(setupUrl), newPassword: 'Acme-Admin-Password-1' })).statusCode).toBe(200);
    const reuse = await c.post('/api/v1/auth/setup', { token: tokenOf(setupUrl), newPassword: 'Another-Password-22' });
    expect(reuse.json().error.code).toBe('setup_link_invalid');
    const admin = await Client.login(appA, A.host, 'owner@acme-labs.test', 'Acme-Admin-Password-1');
    expect(admin.passwordChangeRequired).toBe(false);
    const audit = await q<{ action: string }>(A.owner, `SELECT action FROM audit_logs WHERE action LIKE 'auth.setup%' ORDER BY id`);
    expect(audit.map((a) => a.action)).toEqual(['auth.setup_completed', 'auth.setup_link_rejected']);
  });

  it('is idempotent: re-running never creates another organization or administrator, nor a new link', async () => {
    const r = await boot(A, envA);
    expect(r).toMatchObject({ organizationCreated: false, admin: 'unchanged' });
    expect(r.setupUrl).toBeUndefined();
    const other = await boot(A, envA, { admin: { email: 'someone-else@acme-labs.test', displayName: 'X' } });
    expect(other.admin).toBe('unchanged');
    expect((await q(A.owner, 'SELECT 1 FROM tenants')).length).toBe(1);
    expect((await q(A.owner, `SELECT 1 FROM users`)).length).toBe(1);
  });

  it('expired links are rejected', async () => {
    const r = await boot(A, envA, { resetAdmin: true });
    await q(A.owner, `UPDATE admin_setup_tokens SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL`);
    const res = await new Client(appA, A.host).post('/api/v1/auth/setup', { token: tokenOf(r.setupUrl!), newPassword: 'Acme-Admin-Password-2' });
    expect(res.json().error.code).toBe('setup_link_invalid');
  });

  it('--reset-admin recovers access: old password and sessions stop working, a new link works', async () => {
    const r = await boot(A, envA, { resetAdmin: true });
    expect(r.admin).toBe('reset');
    expect((await new Client(appA, A.host).post('/api/v1/auth/login', { email: 'owner@acme-labs.test', password: 'Acme-Admin-Password-1' })).statusCode).toBe(401);
    await new Client(appA, A.host).post('/api/v1/auth/setup', { token: tokenOf(r.setupUrl!), newPassword: 'Acme-Admin-Password-3' });
    await Client.login(appA, A.host, 'owner@acme-labs.test', 'Acme-Admin-Password-3');
    await expect(boot(A, envA, { resetAdmin: true, admin: { email: 'ghost@acme-labs.test', displayName: 'G' } })).rejects.toThrow(/no user ghost@/);
  });

  it('refuses a database that holds more than one organization', async () => {
    await q(A.owner, `INSERT INTO tenants (slug, name) VALUES ('intruder','Intruder')`);
    await expect(boot(A, envA)).rejects.toThrow(/more than one organization/);
    await q(A.owner, `DELETE FROM tenants WHERE slug='intruder'`);
  });
});

describe('bootstrap: password mode (secret store) forces a password change', () => {
  it('blocks everything except password change until it is done', async () => {
    await boot(A, envA, { resetAdmin: true, mode: 'password', password: 'From-Secrets-Manager-1' });
    const c = await Client.login(appA, A.host, 'owner@acme-labs.test', 'From-Secrets-Manager-1');
    expect(c.passwordChangeRequired).toBe(true);
    expect((await c.get('/api/v1/auth/me')).json().passwordChangeRequired).toBe(true);
    const blocked = await c.get('/api/v1/employees');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('password_change_required');
    expect((await c.post('/api/v1/auth/password', { currentPassword: 'From-Secrets-Manager-1', newPassword: 'From-Secrets-Manager-1' })).statusCode).toBe(400);
    expect((await c.post('/api/v1/auth/password', { currentPassword: 'From-Secrets-Manager-1', newPassword: 'Admin-Chosen-Password-4' })).statusCode).toBe(200);
    expect((await c.get('/api/v1/employees')).statusCode).toBe(200);
  });

  it('CLI never accepts passwords as flags', () => {
    expect(() => parseBootstrapArgs(['--admin-email', 'a@b.in', '--password', 'x'], {})).toThrow(/BOOTSTRAP_ADMIN_PASSWORD/);
    expect(parseBootstrapArgs(['--admin-email', 'a@b.in', '--mode', 'password'], { BOOTSTRAP_ADMIN_PASSWORD: 'secret-from-env' }))
      .toMatchObject({ mode: 'password', password: 'secret-from-env', resetAdmin: false });
    expect(parseBootstrapArgs(['--reset-admin'], { BOOTSTRAP_ADMIN_EMAIL: 'a@b.in' })).toMatchObject({ mode: 'setup-link', resetAdmin: true });
    expect(() => parseBootstrapArgs([], {})).toThrow(/--admin-email/);
  });
});

describe('white-label runtime configuration', () => {
  it('serves branding and organization identity from deployment config, with nothing sensitive', async () => {
    const r = await new Client(appA, A.host).get('/api/v1/public/config');
    const cfg = r.json();
    expect(cfg).toMatchObject({ product: { name: 'LabHRMS' }, brand: { name: 'Acme Labs', primaryColor: '#14532D', logoUrl: '/branding/logo.svg', supportEmail: 'hr-support@acme-labs.test' },
      organization: { name: 'Acme Testing Laboratories', currency: 'INR', country: 'IN', dateFormat: 'DD-MM-YYYY', fiscalYearStartMonth: 4 } });
    const body = r.body.toLowerCase();
    for (const s of ['database', 'postgres', 'encryption', 'password', 'secret', Buffer.alloc(32, 7).toString('base64').toLowerCase()]) expect(body).not.toContain(s);
    expect(r.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it('works on every configured domain and nowhere else', async () => {
    expect((await new Client(appA, 'hr.acme-labs.test').get('/api/v1/public/config')).statusCode).toBe(200);
    expect((await new Client(appA, 'evil.example.com').get('/api/v1/public/config')).statusCode).toBe(404);
  });

  it('renders the page title, favicon and theme colour into index.html, escaped', async () => {
    const page = await appA.inject({ url: '/employees', headers: { host: A.host } });
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('<title>Acme &amp; Co &lt;HR&gt; · LabHRMS</title>');
    expect(page.body).toContain('<meta name="theme-color" content="#14532D" />');
    expect(page.body).not.toContain('<title>HRMS</title>');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it('serves branding images sandboxed; only image files; no traversal', async () => {
    const logo = await appA.inject({ url: '/branding/logo.svg', headers: { host: A.host } });
    expect(logo.statusCode).toBe(200);
    expect(logo.headers['content-type']).toBe('image/svg+xml');
    expect(logo.headers['content-security-policy']).toContain('sandbox');
    expect((await appA.inject({ url: '/branding/notes.txt', headers: { host: A.host } })).statusCode).toBe(404);
    expect((await appA.inject({ url: '/branding/..%2f..%2fpackage.json', headers: { host: A.host } })).statusCode).toBe(404);
  });

  it('allows an https logo host in the SPA CSP of the installation that uses one', async () => {
    const page = await appB.inject({ url: '/', headers: { host: B.host } });
    expect(page.headers['content-security-policy']).toContain("img-src 'self' data: https://cdn.beta-labs.test");
  });

  it('fails startup when a configured branding file is missing', async () => {
    await expect(makeApp({ DATABASE_URL: A.app, ...envA, BRANDING_DIR: brandDir, BRAND_LOGO_URL: '/branding/missing.png' })).rejects.toThrow(/missing.png not found/);
  });
});

describe('isolation between independent installations', () => {
  it('two installations have their own organization, branding, users and sessions', async () => {
    await boot(B, envB, { admin: { email: 'admin@beta-labs.test', displayName: 'Beta Admin' }, mode: 'password', password: 'Beta-Initial-Pass-1' });
    const cfgB = (await new Client(appB, B.host).get('/api/v1/public/config')).json();
    expect(cfgB.brand).toMatchObject({ name: 'Beta Env', primaryColor: '#7A2E0F' });
    expect(cfgB.organization.name).toBe('Beta Environmental Services');
    // A's administrator does not exist in B; A's session is meaningless to B.
    expect((await new Client(appB, B.host).post('/api/v1/auth/login', { email: 'owner@acme-labs.test', password: 'Admin-Chosen-Password-4' })).statusCode).toBe(401);
    const a = await Client.login(appA, A.host, 'owner@acme-labs.test', 'Admin-Chosen-Password-4');
    const replay = new Client(appB, B.host); replay.cookie = a.cookie; replay.csrf = a.csrf;
    expect((await replay.get('/api/v1/auth/me')).statusCode).toBe(401);
    // B does not answer for A's domain.
    expect((await new Client(appB, A.host).get('/api/v1/public/config')).statusCode).toBe(404);
  });
});

describe('migrations and readiness', () => {
  it('reports pending migrations and readiness fails until they are applied', async () => {
    const st = await withOwner(B.owner, (c) => migrationStatus(c));
    expect(st.pending).toEqual([]);
    const [last] = await q<{ name: string; checksum: string }>(B.owner, 'SELECT name, checksum FROM schema_migrations ORDER BY name DESC LIMIT 1');
    await q(B.owner, 'DELETE FROM schema_migrations WHERE name=$1', [last!.name]);
    expect((await withOwner(B.owner, (c) => migrationStatus(c))).pending).toEqual([last!.name]);
    expect((await appB.inject({ url: '/health/ready' })).statusCode).toBe(503);
    await q(B.owner, 'INSERT INTO schema_migrations (name, checksum) VALUES ($1,$2)', [last!.name, last!.checksum]);
    expect((await appB.inject({ url: '/health/ready' })).statusCode).toBe(200);
  });

  it('stays ready on a NEWER schema (rollback to the previous release); migrate leaves it alone', async () => {
    await q(B.owner, `INSERT INTO schema_migrations (name, checksum) VALUES ('999_from_a_newer_release.sql', 'x')`);
    try {
      expect((await withOwner(B.owner, (c) => migrationStatus(c))).unknown).toEqual(['999_from_a_newer_release.sql']);
      expect((await appB.inject({ url: '/ready' })).statusCode).toBe(200);
    } finally {
      await q(B.owner, `DELETE FROM schema_migrations WHERE name='999_from_a_newer_release.sql'`);
    }
  });
});
