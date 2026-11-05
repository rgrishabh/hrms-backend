import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { problem, makeApp, createTenant, Client, ownerQuery, PASSWORD, type TenantFixture } from './helpers.js';
import { base32Decode, base32Encode, hotp, verifyTotp, timeStep } from '../src/core/auth/totp.js';
import { deliverOutbox } from '../src/core/notify/service.js';
import { setMailer, type OutgoingMail } from '../src/core/notify/mailer.js';
import { loadEnv } from '../src/config/env.js';
import { OTP_MAX_ATTEMPTS, OTP_MAX_PER_HOUR } from '../src/core/auth/email-otp.js';
import { TEST_APP_URL, TEST_BRAND } from './env.js';

const codeAt = (secret: string, ms: number) => hotp(base32Decode(secret), timeStep(ms));
const now = () => Date.now();
const ON = { MFA_AVAILABLE: 'true', MFA_METHODS: 'totp,email' };
const SILENT = { error: () => undefined };

/** Each app gets its own address, so the per-address limits of one test leave the next alone. */
// Mail queued here must not reach the mailer of the next test file.
afterAll(async () => { await ownerQuery(`DELETE FROM email_outbox WHERE status <> 'sent'`); });

const fresh = async (env: Record<string, string> = ON, opts: { mailerOverride?: boolean } = {}) => makeApp(env, opts);

describe('TOTP (RFC 6238 / 4226)', () => {
  it('matches the RFC test vectors', () => {
    const key = Buffer.from('12345678901234567890');
    expect(hotp(key, 0)).toBe('755224');          // RFC 4226 Appendix D
    expect(hotp(key, 9)).toBe('520489');
    expect(hotp(key, timeStep(59_000), 8)).toBe('94287082'); // RFC 6238 Appendix B, T=59
    expect(base32Decode(base32Encode(key)).equals(key)).toBe(true);
  });
  it('accepts ±1 step of drift and rejects malformed codes', () => {
    const s = base32Encode(Buffer.alloc(20, 3));
    const t = 1_800_000_000_000;
    expect(verifyTotp(s, codeAt(s, t - 30_000), t)).toBe(timeStep(t) - 1);
    expect(verifyTotp(s, codeAt(s, t - 90_000), t)).toBeNull();
    expect(verifyTotp(s, '12345', t)).toBeNull();
  });
});

async function enrol(c: Client) {
  const s = (await c.post('/api/v1/auth/mfa/setup')).json();
  expect(s.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
  const r = await c.post('/api/v1/auth/mfa/enable', { code: codeAt(s.secret, now()) });
  expect(r.statusCode, r.body).toBe(200);
  return { secret: s.secret as string, recovery: r.json().recoveryCodes as string[] };
}
const passTime = (userId: string) => ownerQuery(`UPDATE users SET mfa_last_step = mfa_last_step - 2 WHERE id=$1`, [userId]);

describe('MFA_AVAILABLE=false: off for everyone, whatever was enrolled', () => {
  let off: FastifyInstance; let on: FastifyInstance; let T: TenantFixture; let secret = '';
  beforeAll(async () => {
    off = await fresh({ MFA_AVAILABLE: 'false' }); on = await fresh();
    T = await createTenant();
    ({ secret } = await enrol(await Client.login(on, T.host, T.users.hr!.email)));
    // The removed setting, left behind by an older release, changes nothing.
    await ownerQuery(`INSERT INTO tenant_settings (tenant_id, setting_key, setting_value) VALUES ($1,'security.mfa_enforcement','"all"')`, [T.id]);
  });
  afterAll(async () => { await off.close(); await on.close(); });

  it.each(['methods', 'setup', 'enable', 'verify', 'disable', 'recovery-codes', 'email/setup', 'email/enable', 'email/send'])('/auth/mfa/%s does not exist', async (path) => {
    const c = await Client.login(off, T.host, T.users.employee!.email);
    expect((await c.post(`/api/v1/auth/mfa/${path}`, { code: '123456', password: PASSWORD })).statusCode).toBe(404);
    expect((await c.get(`/api/v1/auth/mfa/${path}`)).statusCode).toBe(404);
  });

  it('an enrolled user signs in with no challenge, and nothing prompts anyone', async () => {
    const hr = new Client(off, T.host);
    const r = await hr.post('/api/v1/auth/login', { email: T.users.hr!.email, password: PASSWORD });
    expect(r.json().mfaRequired).toBe(false);
    expect((await hr.get('/api/v1/employees')).statusCode).toBe(200);
    expect((await hr.get('/api/v1/auth/me')).json().mfa).toEqual({ enabled: false, pending: false, enrollmentRequired: false, method: null, suggested: false });
  });

  it('the enrolment is kept and comes back: the same account is challenged when MFA is on again', async () => {
    const [u] = await ownerQuery<{ mfa_secret_enc: string; n: number }>(`SELECT mfa_secret_enc, cardinality(mfa_recovery_hashes) AS n FROM users WHERE id=$1`, [T.users.hr!.id]);
    expect(u!.mfa_secret_enc).toMatch(/^v2\./);
    expect(u!.n).toBe(10);
    const again = await Client.login(on, T.host, T.users.hr!.email);
    expect(problem((await again.get('/api/v1/employees'))).code).toBe('mfa_required');
    await passTime(T.users.hr!.id);
    expect((await again.post('/api/v1/auth/mfa/verify', { code: codeAt(secret, now()) })).statusCode).toBe(200);
  });

  it('an administrator cannot clear what is being kept', async () => {
    const admin = await Client.login(off, T.host, T.users.admin!.email);
    expect((await admin.patch(`/api/v1/tenant/users/${T.users.hr!.id}`, { resetMfa: true })).statusCode).toBe(409);
  });

  it('a session started while off is challenged once MFA is on again', async () => {
    const started = new Client(off, T.host);
    await started.post('/api/v1/auth/login', { email: T.users.hr!.email, password: PASSWORD });
    const same = new Client(on, T.host); same.cookie = started.cookie; same.csrf = started.csrf;
    expect(problem((await same.get('/api/v1/employees'))).code).toBe('mfa_required');
  });

  it('public config says off', async () => {
    expect((await new Client(off, T.host).get('/api/v1/config/public')).json().mfa).toEqual({ available: false, enforced: false, methods: [] });
  });
});

describe('MFA_AVAILABLE=true, MFA_ENFORCED=false: optional, per user', () => {
  let app: FastifyInstance; let T: TenantFixture;
  beforeAll(async () => { app = await fresh(); T = await createTenant(); });
  afterAll(async () => { await app.close(); });

  it('nobody is forced, privileged roles included; a tenant setting left behind counts for nothing', async () => {
    await ownerQuery(`INSERT INTO tenant_settings (tenant_id, setting_key, setting_value) VALUES ($1,'security.mfa_enforcement','"all"')`, [T.id]);
    for (const key of ['admin', 'hr', 'payroll', 'it', 'employee']) {
      const c = await Client.login(app, T.host, T.users[key]!.email);
      const me = (await c.get('/api/v1/auth/me')).json();
      expect(me.mfa.enrollmentRequired, key).toBe(false);
      expect(problem((await c.get('/api/v1/org/branches'))).code, key).not.toBe('mfa_enrollment_required');
    }
  });

  it('/auth/me suggests it, gently, to people who can read L4 data, and to nobody else', async () => {
    const suggested = async (key: string) => (await (await Client.login(app, T.host, T.users[key]!.email)).get('/api/v1/auth/me')).json().mfa.suggested;
    expect(await suggested('payroll')).toBe(true);
    expect(await suggested('hr')).toBe(true);
    expect(await suggested('admin')).toBe(true);
    expect(await suggested('employee')).toBe(false);
    expect(await suggested('manager')).toBe(false);
    expect(await suggested('it')).toBe(false);
  });

  it('the suggestion blocks nothing, and goes away after enrolling', async () => {
    const c = await Client.login(app, T.host, T.users.payroll!.email);
    expect((await c.get('/api/v1/employees')).statusCode).toBe(200);
    await enrol(c);
    const me = (await c.get('/api/v1/auth/me')).json().mfa;
    expect(me).toMatchObject({ enabled: true, pending: false, method: 'totp', suggested: false });
  });

  it('anyone can turn it on and off with password and code, and a turned-off account is not challenged', async () => {
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    const { secret } = await enrol(emp);
    await passTime(T.users.employee!.id);
    expect((await emp.post('/api/v1/auth/mfa/disable', { password: 'wrong', code: codeAt(secret, now()) })).statusCode).toBe(400);
    const off = await emp.post('/api/v1/auth/mfa/disable', { password: PASSWORD, code: codeAt(secret, now()) });
    expect(off.statusCode, off.body).toBe(200);
    expect((await emp.get('/api/v1/auth/me')).json().mfa.enabled).toBe(false);
    const again = await Client.login(app, T.host, T.users.employee!.email);
    expect((await again.get('/api/v1/employees')).statusCode).toBe(200);
  });

  it('roles no longer say anything about MFA', async () => {
    const r = await (await Client.login(app, T.host, T.users.admin!.email)).get('/api/v1/tenant/roles');
    expect(r.body).not.toContain('mfaRequired');
    expect(r.body).not.toContain('privileged');
    const settings = await (await Client.login(app, T.host, T.users.admin!.email)).get('/api/v1/tenant/settings');
    expect(settings.body).not.toContain('mfa_enforcement');
  });
});

describe('MFA_ENFORCED=true', () => {
  let app: FastifyInstance; let T: TenantFixture;
  beforeAll(async () => { app = await fresh({ ...ON, MFA_ENFORCED: 'true' }); T = await createTenant(); });
  afterAll(async () => { await app.close(); });

  it('everyone must enrol at next sign-in before anything else, and cannot turn it off', async () => {
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    expect((await emp.get('/api/v1/auth/me')).json().mfa).toMatchObject({ enabled: false, enrollmentRequired: true, suggested: false });
    const blocked = await emp.get('/api/v1/employees');
    expect(blocked.statusCode).toBe(403);
    expect(problem(blocked).code).toBe('mfa_enrollment_required');
    expect((await emp.get('/api/v1/auth/mfa/methods')).statusCode).toBe(200);
    expect((await emp.post('/api/v1/auth/mfa/enable', { code: '123456' })).statusCode).toBe(400); // setup not started
    const { secret } = await enrol(emp);
    expect((await emp.get('/api/v1/employees')).statusCode).toBe(200);
    await passTime(T.users.employee!.id);
    expect(problem((await emp.post('/api/v1/auth/mfa/disable', { password: PASSWORD, code: codeAt(secret, now()) }))).code).toBe('mfa_required_by_deployment');
  });

  it('an administrator reset means enrolling again, and the person is told', async () => {
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    await enrol(hr);
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    await enrol(admin);
    expect((await admin.patch(`/api/v1/tenant/users/${T.users.hr!.id}`, { resetMfa: true })).statusCode).toBe(200);
    expect((await hr.get('/api/v1/auth/me')).statusCode).toBe(401);
    expect((await (await Client.login(app, T.host, T.users.hr!.email)).get('/api/v1/auth/me')).json().mfa.enrollmentRequired).toBe(true);
    expect((await ownerQuery(`SELECT 1 FROM notifications WHERE user_id=$1 AND kind='security.mfa_disabled'`, [T.users.hr!.id])).length).toBe(1);
    expect((await admin.patch(`/api/v1/tenant/users/${T.users.admin!.id}`, { resetMfa: true })).statusCode).toBe(409);
  });
});

describe('configuration', () => {
  const load = (o: Record<string, string>) => loadEnv({ NODE_ENV: 'test', DATABASE_URL: TEST_APP_URL, DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), COOKIE_SECURE: 'false', ...TEST_BRAND, ...o });
  it('enforcing with only email codes and no mail is refused, since nobody could enrol', () => {
    expect(() => load({ MFA_AVAILABLE: 'true', MFA_ENFORCED: 'true', MFA_METHODS: 'email' })).toThrow(/nobody could enrol/);
    expect(load({ MFA_AVAILABLE: 'true', MFA_ENFORCED: 'true', MFA_METHODS: 'totp' }).MFA_ENFORCED).toBe(true);
    expect(() => load({ MFA_AVAILABLE: 'false', MFA_ENFORCED: 'true' })).toThrow(/MFA_ENFORCED=true is invalid/);
  });
  it('MFA_METHODS decides which routes exist', async () => {
    const totp = await fresh({ MFA_AVAILABLE: 'true', MFA_METHODS: 'totp' });
    const T = await createTenant();
    const c = await Client.login(totp, T.host, T.users.employee!.email);
    expect((await c.post('/api/v1/auth/mfa/email/setup')).statusCode).toBe(404);
    expect((await c.get('/api/v1/auth/mfa/methods')).json().methods).toEqual([{ method: 'totp', usable: true }]);
    await totp.close();
    const email = await fresh({ MFA_AVAILABLE: 'true', MFA_METHODS: 'email' });
    const d = await Client.login(email, T.host, T.users.other!.email);
    expect((await d.post('/api/v1/auth/mfa/setup')).statusCode).toBe(404);
    await email.close();
  });
  it('someone enrolled in a method no longer offered is not challenged, and it comes back with the method', async () => {
    const both = await fresh();
    const T = await createTenant();
    await enrol(await Client.login(both, T.host, T.users.other!.email));
    const email = await fresh({ MFA_AVAILABLE: 'true', MFA_METHODS: 'email' });
    expect((await (await Client.login(email, T.host, T.users.other!.email)).get('/api/v1/auth/me')).json().mfa.enabled).toBe(false);
    await email.close();
    expect((await (await Client.login(both, T.host, T.users.other!.email)).get('/api/v1/auth/me')).json().mfa.pending).toBe(true);
    await both.close();
  });
});

describe('TOTP sign-in and recovery codes', () => {
  let app: FastifyInstance; let T: TenantFixture; let secret = ''; let recovery: string[] = [];
  beforeAll(async () => { app = await fresh(); T = await createTenant(); });
  afterAll(async () => { await app.close(); });

  it('stores only an encrypted secret and hashed recovery codes', async () => {
    ({ secret, recovery } = await enrol(await Client.login(app, T.host, T.users.hr!.email)));
    expect(recovery).toHaveLength(10);
    const [u] = await ownerQuery<{ mfa_secret_enc: string; mfa_recovery_hashes: string[]; mfa_method: string }>(`SELECT mfa_secret_enc, mfa_recovery_hashes, mfa_method FROM users WHERE id=$1`, [T.users.hr!.id]);
    expect(u!.mfa_method).toBe('totp');
    expect(u!.mfa_secret_enc).toMatch(/^v2\./);
    expect(u!.mfa_secret_enc).not.toContain(secret);
    expect(u!.mfa_recovery_hashes.some((h) => recovery.includes(h))).toBe(false);
  });

  it('a new sign-in needs a code; codes cannot be replayed; recovery codes work once and tell the user', async () => {
    const c = await Client.login(app, T.host, T.users.hr!.email);
    expect(c.passwordChangeRequired).toBe(false);
    expect(problem((await c.get('/api/v1/employees'))).code).toBe('mfa_required');
    expect((await c.get('/api/v1/auth/me')).json().permissions).toEqual([]); // nothing revealed before the code
    await passTime(T.users.hr!.id); // the code used at enrolment is in the same 30 s window
    const code = codeAt(secret, now());
    expect((await c.post('/api/v1/auth/mfa/verify', { code })).json()).toMatchObject({ ok: true, method: 'totp' });
    expect((await c.get('/api/v1/employees')).statusCode).toBe(200);
    const c2 = await Client.login(app, T.host, T.users.hr!.email);
    expect((await c2.post('/api/v1/auth/mfa/verify', { code })).statusCode).toBe(400); // same code again
    expect((await c2.post('/api/v1/auth/mfa/verify', { code: recovery[0] })).json().method).toBe('recovery');
    const c3 = await Client.login(app, T.host, T.users.hr!.email);
    expect((await c3.post('/api/v1/auth/mfa/verify', { code: recovery[0] })).statusCode).toBe(400);
    expect((await c2.get('/api/v1/notifications')).json().items.some((n: { kind: string }) => n.kind === 'security.recovery_code_used')).toBe(true);
  });

  it('verifying rotates the session token: the token from before the code is dead, and the CSRF token comes with the answer', async () => {
    const c = await Client.login(app, T.host, T.users.hr!.email);
    const [cookie, csrf] = [c.cookie, c.csrf];
    const r = await c.post('/api/v1/auth/mfa/verify', { code: recovery[3] });
    expect(r.statusCode).toBe(200);
    expect(r.json().csrfToken).toBeTruthy();
    expect(c.cookie).not.toBe(cookie);
    expect(c.csrf).not.toBe(csrf);
    const old = new Client(app, T.host); old.cookie = cookie;
    expect((await old.get('/api/v1/auth/me')).statusCode).toBe(401);
    expect((await c.get('/api/v1/employees')).statusCode).toBe(200);
  });
});

describe('MFA changes end other sessions', () => {
  it('turning it on and off rotates this session and ends the others', async () => {
    const app = await fresh(); const T = await createTenant();
    const a = await Client.login(app, T.host, T.users.employee!.email);
    const b = await Client.login(app, T.host, T.users.employee!.email);
    const cookie = a.cookie;
    const { secret } = await enrol(a);
    expect(a.cookie).not.toBe(cookie);
    expect((await a.get('/api/v1/auth/me')).statusCode).toBe(200);
    expect((await b.get('/api/v1/auth/me')).statusCode).toBe(401);
    const c = await Client.login(app, T.host, T.users.employee!.email);
    await passTime(T.users.employee!.id);
    expect((await a.post('/api/v1/auth/mfa/disable', { password: PASSWORD, code: codeAt(secret, now()) })).statusCode).toBe(200);
    expect((await c.get('/api/v1/auth/me')).statusCode).toBe(401);
    expect((await a.get('/api/v1/auth/me')).statusCode).toBe(200);
    await app.close();
  });
});

describe('brute force on the second factor', () => {
  it('five wrong codes end the session, and ten across sessions stop it answering, the right code included', async () => {
    const app = await fresh(); const T = await createTenant();
    const { secret } = await enrol(await Client.login(app, T.host, T.users.other!.email));
    const c = await Client.login(app, T.host, T.users.other!.email);
    for (let i = 0; i < 4; i++) expect((await c.post('/api/v1/auth/mfa/verify', { code: '000000' })).statusCode).toBe(400);
    expect((await c.post('/api/v1/auth/mfa/verify', { code: '000000' })).statusCode).toBe(401);
    expect((await c.get('/api/v1/auth/me')).statusCode).toBe(401);
    expect((await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='auth.mfa_failed'`, [T.id])).length).toBeGreaterThanOrEqual(5);
    await app.close();
    // Signing in again does not earn five more: a new app for the per-address limit, the same account.
    const again = await fresh();
    const d = await Client.login(again, T.host, T.users.other!.email);
    for (let i = 0; i < 4; i++) await d.post('/api/v1/auth/mfa/verify', { code: '000000' });
    const e = await Client.login(again, T.host, T.users.other!.email);
    expect((await e.post('/api/v1/auth/mfa/verify', { code: '000000' })).statusCode).toBe(400); // the tenth, counted across sessions
    await passTime(T.users.other!.id);
    const right = await e.post('/api/v1/auth/mfa/verify', { code: codeAt(secret, now()) });
    expect(right.statusCode).toBe(429);
    expect(problem(right).code).toBe('mfa_locked');
    // It ends: nobody is locked out for good.
    await ownerQuery(`UPDATE users SET mfa_locked_until=now() - interval '1 second' WHERE id=$1`, [T.users.other!.id]);
    expect((await e.post('/api/v1/auth/mfa/verify', { code: codeAt(secret, now()) })).statusCode).toBe(200);
    await again.close();
  });

  it('more than ten tries a minute from one address are refused before any code is checked', async () => {
    const app = await fresh(); const T = await createTenant();
    await enrol(await Client.login(app, T.host, T.users.manager!.email));
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const c = await Client.login(app, T.host, T.users.manager!.email);
      codes.push((await c.post('/api/v1/auth/mfa/verify', { code: '000000' })).statusCode);
    }
    expect(codes.slice(0, 10).every((x) => x === 400 || x === 429)).toBe(true);
    expect(codes[11]).toBe(429);
    await app.close();
  });
});

describe('email codes', () => {
  let app: FastifyInstance; let T: TenantFixture;
  const sent: OutgoingMail[] = [];
  const deliver = async () => { await deliverOutbox(app.deps.pool, SILENT); };
  /** The newest code in the mail, as the person would read it. */
  const lastCode = async () => { await deliver(); const m = sent.map((x) => /Your code is (\d{6})/.exec(x.text)).filter(Boolean).at(-1); if (!m) throw new Error('no code in the mail'); return m[1]!; };
  beforeAll(async () => {
    setMailer({ send: async (m) => { sent.push(m); } }, 'test@test');
    app = await fresh(ON, { mailerOverride: true });
    T = await createTenant();
  });
  afterAll(async () => { setMailer(null); await app.close(); });
  beforeEach(() => { sent.length = 0; });
  const allowAnother = (userId: string) => ownerQuery(`UPDATE email_otps SET created_at = created_at - interval '2 minutes' WHERE user_id=$1`, [userId]);
  const enrolEmail = async (c: Client, userId: string) => {
    expect((await c.post('/api/v1/auth/mfa/email/setup')).json()).toEqual({ sent: true });
    const r = await c.post('/api/v1/auth/mfa/email/enable', { code: await lastCode() });
    expect(r.statusCode, r.body).toBe(200);
    await allowAnother(userId);
    return r.json().recoveryCodes as string[];
  };

  it('enrols by proving the mailbox, and gives recovery codes', async () => {
    const c = await Client.login(app, T.host, T.users.employee!.email);
    expect((await c.post('/api/v1/auth/mfa/email/enable', { code: '123456' })).statusCode).toBe(400);
    const codes = await enrolEmail(c, T.users.employee!.id);
    expect(codes).toHaveLength(10);
    expect((await c.get('/api/v1/auth/me')).json().mfa).toMatchObject({ enabled: true, method: 'email' });
    expect((await c.post('/api/v1/auth/mfa/setup')).statusCode).toBe(409); // already on
  });

  it('the code is hashed at rest and never readable in the outbox, before or after sending', async () => {
    const c = await Client.login(app, T.host, T.users.other!.email);
    await c.post('/api/v1/auth/mfa/email/setup');
    const [queued] = await ownerQuery<{ text_body: string; html_body: string; secret_enc: string; kind: string }>(`SELECT text_body, html_body, secret_enc, kind FROM email_outbox WHERE tenant_id=$1 AND status='queued' ORDER BY created_at DESC LIMIT 1`, [T.id]);
    expect(queued!.kind).toBe('security.email_code');
    expect(queued!.secret_enc).toMatch(/^v2\./);
    expect(queued!.text_body).not.toMatch(/\d{6}/);
    expect(queued!.html_body).not.toMatch(/is \d{6}/);
    const code = await lastCode();
    const [otp] = await ownerQuery<{ code_hash: string }>(`SELECT code_hash FROM email_otps WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [T.users.other!.id]);
    expect(otp!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(otp!.code_hash).not.toContain(code);
    const [row] = await ownerQuery<{ secret_enc: string | null; text_body: string }>(`SELECT secret_enc, text_body FROM email_outbox WHERE tenant_id=$1 AND status='sent' ORDER BY created_at DESC LIMIT 1`, [T.id]);
    expect(row!.secret_enc).toBeNull();
    expect(row!.text_body).not.toContain(code);
    expect((await ownerQuery(`SELECT 1 FROM notifications WHERE kind='security.email_code'`)).length).toBe(0);
    await allowAnother(T.users.other!.id);
  });

  it('sign-in sends a code; it works once, and a session cannot use it twice', async () => {
    const c = new Client(app, T.host);
    const r = await c.post('/api/v1/auth/login', { email: T.users.employee!.email, password: PASSWORD });
    expect(r.json()).toMatchObject({ mfaRequired: true, mfaMethod: 'email', mfaDelivery: 'sent' });
    const code = await lastCode();
    expect((await c.post('/api/v1/auth/mfa/verify', { code })).json()).toMatchObject({ ok: true, method: 'email' });
    await allowAnother(T.users.employee!.id);
    const d = new Client(app, T.host);
    await d.post('/api/v1/auth/login', { email: T.users.employee!.email, password: PASSWORD });
    expect((await d.post('/api/v1/auth/mfa/verify', { code })).statusCode).toBe(400); // the old code, reused
    await allowAnother(T.users.employee!.id);
  });

  it('an expired code does not work', async () => {
    const c = new Client(app, T.host);
    await c.post('/api/v1/auth/login', { email: T.users.employee!.email, password: PASSWORD });
    const code = await lastCode();
    await ownerQuery(`UPDATE email_otps SET expires_at=now() - interval '1 second' WHERE user_id=$1 AND consumed_at IS NULL`, [T.users.employee!.id]);
    expect((await c.post('/api/v1/auth/mfa/verify', { code })).statusCode).toBe(400);
    await allowAnother(T.users.employee!.id);
  });

  it(`a code dies after ${OTP_MAX_ATTEMPTS} wrong guesses across sessions, even the right digits after that`, async () => {
    const X = await createTenant(); const email = X.users.employee!.email;
    const a = await fresh(ON, { mailerOverride: true });
    sent.length = 0;
    const first = await Client.login(a, X.host, email);
    await first.post('/api/v1/auth/mfa/email/setup');
    await deliverOutbox(a.deps.pool, SILENT);
    const enrolCode = sent.filter((m) => m.to === email).map((m) => /Your code is (\d{6})/.exec(m.text)).filter(Boolean).at(-1)![1]!;
    expect((await first.post('/api/v1/auth/mfa/email/enable', { code: enrolCode })).statusCode).toBe(200);
    await ownerQuery(`UPDATE email_otps SET created_at = created_at - interval '2 minutes' WHERE user_id=$1`, [X.users.employee!.id]);
    // The code from this sign-in. A second sign-in inside the minute sends none, so both sessions guess at the same one.
    const c = await Client.login(a, X.host, email);
    await deliverOutbox(a.deps.pool, SILENT);
    const code = sent.filter((m) => m.to === email).map((m) => /Your code is (\d{6})/.exec(m.text)).filter(Boolean).at(-1)![1]!;
    const wrong = code === '000000' ? '000001' : '000000';
    const d = new Client(a, X.host);
    expect((await d.post('/api/v1/auth/login', { email, password: PASSWORD })).json().mfaDelivery).toBe('wait');
    for (let i = 0; i < 3; i++) expect((await c.post('/api/v1/auth/mfa/verify', { code: wrong })).statusCode).toBe(400);
    for (let i = 3; i < OTP_MAX_ATTEMPTS; i++) expect((await d.post('/api/v1/auth/mfa/verify', { code: wrong })).statusCode).toBe(400);
    expect((await d.post('/api/v1/auth/mfa/verify', { code })).statusCode).toBe(400);
    await a.close();
  });

  it('resending waits a minute, and stops after the hourly limit', async () => {
    const X = await createTenant();
    const a = await fresh(ON, { mailerOverride: true });
    const c = await Client.login(a, X.host, X.users.employee!.email);
    expect((await c.post('/api/v1/auth/mfa/email/setup')).statusCode).toBe(200);
    const soon = await c.post('/api/v1/auth/mfa/email/setup');
    expect(soon.statusCode).toBe(429);
    expect(Number(soon.headers['retry-after'])).toBeGreaterThan(0);
    await ownerQuery(`UPDATE email_otps SET created_at = created_at - interval '2 minutes' WHERE user_id=$1`, [X.users.employee!.id]);
    for (let i = 1; i < OTP_MAX_PER_HOUR; i++) await ownerQuery(`INSERT INTO email_otps (tenant_id, user_id, purpose, code_hash, expires_at, created_at) VALUES ($1,$2,'enrol','x',now(),now() - interval '5 minutes')`, [X.id, X.users.employee!.id]);
    const [{ n }] = await ownerQuery<{ n: number }>(`SELECT count(*)::int AS n FROM email_otps WHERE user_id=$1`, [X.users.employee!.id]) as [{ n: number }];
    expect(n).toBe(OTP_MAX_PER_HOUR);
    expect((await c.post('/api/v1/auth/mfa/email/setup')).statusCode).toBe(429);
    await a.close();
  });

  it('a recovery code spends no guess on the email code, and still gets in', async () => {
    const X = await createTenant();
    const a = await fresh(ON, { mailerOverride: true });
    const c = await Client.login(a, X.host, X.users.manager!.email);
    await c.post('/api/v1/auth/mfa/email/setup');
    await deliverOutbox(a.deps.pool, SILENT);
    const code = sent.filter((m) => m.to === X.users.manager!.email).map((m) => /Your code is (\d{6})/.exec(m.text)).filter(Boolean).at(-1)![1]!;
    const recovery = (await c.post('/api/v1/auth/mfa/email/enable', { code })).json().recoveryCodes as string[];
    await ownerQuery(`UPDATE email_otps SET created_at = created_at - interval '2 minutes' WHERE user_id=$1`, [X.users.manager!.id]);
    const d = new Client(a, X.host);
    await d.post('/api/v1/auth/login', { email: X.users.manager!.email, password: PASSWORD });
    expect((await d.post('/api/v1/auth/mfa/verify', { code: recovery[0] })).json().method).toBe('recovery');
    await a.close();
  });
});

describe('email codes without a mail transport', () => {
  it('enrolment says so before anyone tries, and refuses; someone already enrolled gets in with a recovery code', async () => {
    const withMail = await (async () => { setMailer({ send: async () => undefined }, 'x@x'); return fresh(ON, { mailerOverride: true }); })();
    const T = await createTenant();
    const sent: OutgoingMail[] = [];
    setMailer({ send: async (m) => { sent.push(m); } }, 'x@x');
    const c = await Client.login(withMail, T.host, T.users.employee!.email);
    await c.post('/api/v1/auth/mfa/email/setup');
    await deliverOutbox(withMail.deps.pool, SILENT);
    const recovery = (await c.post('/api/v1/auth/mfa/email/enable', { code: sent.filter((m) => m.to === T.users.employee!.email).map((m) => /Your code is (\d{6})/.exec(m.text)).filter(Boolean).at(-1)![1]! })).json().recoveryCodes as string[];
    await withMail.close();

    setMailer(null);
    const app = await fresh(ON, { mailerOverride: true });
    const other = await Client.login(app, T.host, T.users.other!.email);
    const methods = (await other.get('/api/v1/auth/mfa/methods')).json().methods as { method: string; usable: boolean; reason?: string }[];
    expect(methods.find((m) => m.method === 'totp')!.usable).toBe(true);
    const email = methods.find((m) => m.method === 'email')!;
    expect(email.usable).toBe(false);
    expect(email.reason).toMatch(/email/i);
    const refused = await other.post('/api/v1/auth/mfa/email/setup');
    expect(refused.statusCode).toBe(409);
    expect(problem(refused).code).toBe('feature_not_configured');
    const d = new Client(app, T.host);
    const login = await d.post('/api/v1/auth/login', { email: T.users.employee!.email, password: PASSWORD });
    expect(login.json()).toMatchObject({ mfaRequired: true, mfaDelivery: 'unavailable' });
    expect((await d.post('/api/v1/auth/mfa/verify', { code: recovery[0] })).statusCode).toBe(200);
    await app.close();
  });
});
