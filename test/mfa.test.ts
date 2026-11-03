import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture } from './helpers.js';
import { base32Decode, base32Encode, hotp, verifyTotp, timeStep } from '../src/core/auth/totp.js';

const codeAt = (secret: string, ms: number) => hotp(base32Decode(secret), timeStep(ms));
const now = () => Date.now();

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

let app: FastifyInstance; let T: TenantFixture;
beforeAll(async () => { app = await makeApp({ MFA_ENFORCEMENT: 'privileged' }); T = await createTenant(); });
afterAll(async () => { await app.close(); });

async function enrol(c: Client) {
  const s = (await c.post('/api/v1/auth/mfa/setup')).json();
  expect(s.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
  const r = await c.post('/api/v1/auth/mfa/enable', { code: codeAt(s.secret, now()) });
  expect(r.statusCode, r.body).toBe(200);
  return { secret: s.secret as string, recovery: r.json().recoveryCodes as string[] };
}

describe('enforcement and enrolment', () => {
  let secret = ''; let recovery: string[] = [];
  it('privileged users must enrol before anything else; employees are not forced', async () => {
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    expect((await hr.get('/api/v1/auth/me')).json().mfa).toEqual({ enabled: false, pending: false, enrollmentRequired: true });
    const blocked = await hr.get('/api/v1/employees');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('mfa_enrollment_required');
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    expect((await emp.get('/api/v1/employees')).statusCode).toBe(200);
    expect((await hr.post('/api/v1/auth/mfa/enable', { code: '123456' })).statusCode).toBe(400); // setup not started
    ({ secret, recovery } = await enrol(hr));
    expect(recovery).toHaveLength(10);
    expect((await hr.get('/api/v1/employees')).statusCode).toBe(200); // this session is verified
    const [u] = await ownerQuery<{ mfa_secret_enc: string; mfa_recovery_hashes: string[] }>(`SELECT mfa_secret_enc, mfa_recovery_hashes FROM users WHERE id=$1`, [T.users.hr!.id]);
    expect(u!.mfa_secret_enc).toMatch(/^v1\./);
    expect(u!.mfa_secret_enc).not.toContain(secret);
    expect(u!.mfa_recovery_hashes.some((h) => recovery.includes(h))).toBe(false); // hashes only
  });

  it('a new sign-in needs a code; codes cannot be replayed; recovery codes work once', async () => {
    const c = await Client.login(app, T.host, T.users.hr!.email);
    expect(c.passwordChangeRequired).toBe(false);
    const blocked = await c.get('/api/v1/employees');
    expect(blocked.json().error.code).toBe('mfa_required');
    expect((await c.get('/api/v1/auth/me')).json().permissions).toEqual([]); // nothing revealed before the code
    // The code used at enrolment is in the same 30 s window → replay rejected; wait for the next step.
    await ownerQuery(`UPDATE users SET mfa_last_step = mfa_last_step - 2 WHERE id=$1`, [T.users.hr!.id]); // simulate time passing
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

  it('five wrong codes end the session', async () => {
    const c = await Client.login(app, T.host, T.users.hr!.email);
    for (let i = 0; i < 4; i++) expect((await c.post('/api/v1/auth/mfa/verify', { code: '000000' })).statusCode).toBe(400);
    expect((await c.post('/api/v1/auth/mfa/verify', { code: '000000' })).statusCode).toBe(401);
    expect((await c.get('/api/v1/auth/me')).statusCode).toBe(401);
    expect((await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='auth.mfa_failed'`, [T.id])).length).toBeGreaterThanOrEqual(5);
  });

  it('privileged users cannot turn MFA off; an administrator can reset it (sessions revoked)', async () => {
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    await hr.post('/api/v1/auth/mfa/verify', { code: recovery[1] });
    expect((await hr.post('/api/v1/auth/mfa/disable', { password: 'Test-Password-123!', code: recovery[2] })).statusCode).toBe(403);
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    await enrol(admin);
    expect((await admin.patch(`/api/v1/tenant/users/${T.users.hr!.id}`, { resetMfa: true })).statusCode).toBe(200);
    expect((await hr.get('/api/v1/auth/me')).statusCode).toBe(401);
    const again = await Client.login(app, T.host, T.users.hr!.email);
    expect((await again.get('/api/v1/auth/me')).json().mfa.enrollmentRequired).toBe(true);
    expect((await admin.patch(`/api/v1/tenant/users/${T.users.admin!.id}`, { resetMfa: true })).statusCode).toBe(409);
  });
});

describe('optional MFA for non-privileged users', () => {
  it('an employee can enable and disable it (password + code)', async () => {
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    const { secret } = await enrol(emp);
    await ownerQuery(`UPDATE users SET mfa_last_step = mfa_last_step - 2 WHERE id=$1`, [T.users.employee!.id]);
    expect((await emp.post('/api/v1/auth/mfa/disable', { password: 'wrong', code: codeAt(secret, now()) })).statusCode).toBe(400);
    expect((await emp.post('/api/v1/auth/mfa/disable', { password: 'Test-Password-123!', code: codeAt(secret, now()) })).statusCode).toBe(200);
    expect((await emp.get('/api/v1/auth/me')).json().mfa.enabled).toBe(false);
  });

  it('organizations can make enforcement stricter but never weaker than the installation minimum', async () => {
    const U = await createTenant();
    await ownerQuery(`INSERT INTO tenant_settings (tenant_id, setting_key, setting_value) VALUES ($1,'security.mfa_enforcement','"all"')`, [U.id]);
    const emp = await Client.login(app, U.host, U.users.employee!.email);
    expect((await emp.get('/api/v1/auth/me')).json().mfa.enrollmentRequired).toBe(true);
    const V = await createTenant();
    await ownerQuery(`INSERT INTO tenant_settings (tenant_id, setting_key, setting_value) VALUES ($1,'security.mfa_enforcement','"off"')`, [V.id]);
    const hr = await Client.login(app, V.host, V.users.hr!.email);
    expect((await hr.get('/api/v1/auth/me')).json().mfa.enrollmentRequired).toBe(true); // floor = privileged
  });
});
