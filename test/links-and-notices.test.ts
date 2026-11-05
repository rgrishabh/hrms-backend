import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, createTenant, makeApp, ownerQuery, PASSWORD, type TenantFixture } from './helpers.js';
import { deliverOutbox } from '../src/core/notify/service.js';
import { setMailer, type OutgoingMail } from '../src/core/notify/mailer.js';
import { LINKS_PER_HOUR } from '../src/core/auth/links.js';
import { base32Decode, hotp, timeStep } from '../src/core/auth/totp.js';

const SILENT = { error: () => undefined };
const NEW = 'marble kettle orbit lantern';
const sent: OutgoingMail[] = [];
let app: FastifyInstance; let T: TenantFixture;
/** An address of its own per call, so per-address limits stay out of the way unless a test is about them. */
let nextIp = 1;
const ip = () => `198.18.${Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}`;
const raw = (method: 'GET' | 'POST', url: string, payload: unknown, host = T.host, from = ip()) => app.inject({ method, url, payload: payload as never, headers: { host, 'x-forwarded-for': from } });
const forgot = (email: string, host = T.host) => raw('POST', '/api/v1/auth/password/forgot', { email }, host);
const reset = (token: string, newPassword = NEW, host = T.host) => raw('POST', '/api/v1/auth/password/reset', { token, newPassword }, host);
const deliver = () => deliverOutbox(app.deps.pool, SILENT);
const tokenIn = (m: OutgoingMail) => /#token=([A-Za-z0-9_-]+)/.exec(m.text)?.[1];
/** The link in the newest mail to this address, as the person would click it. */
const linkFor = async (email: string) => {
  await deliver();
  const m = sent.filter((x) => x.to === email && tokenIn(x)).at(-1);
  if (!m) throw new Error(`no link for ${email}`);
  return tokenIn(m)!;
};

beforeAll(async () => {
  setMailer({ send: async (m) => { sent.push(m); } }, 'test@test');
  app = await makeApp({ TRUST_PROXY: '1', MFA_AVAILABLE: 'true', MFA_METHODS: 'totp,email' }, { mailerOverride: true });
  T = await createTenant();
});
afterAll(async () => { setMailer(null); await app.close(); await ownerQuery(`DELETE FROM email_outbox WHERE status <> 'sent'`); });
beforeEach(() => { sent.length = 0; });

describe('password reset', () => {
  it('works once, signs out every session, and does not sign in', async () => {
    const X = await createTenant(); const email = X.users.employee!.email;
    const before = await Client.login(app, X.host, email);
    expect((await forgot(email, X.host)).json()).toEqual({ ok: true });
    const token = await linkFor(email);
    const r = await reset(token, NEW, X.host);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['set-cookie']).toBeUndefined();
    expect((await before.get('/api/v1/auth/me')).statusCode).toBe(401);
    await Client.login(app, X.host, email, NEW);
    // Token reuse.
    const again = await reset(token, 'another fine passphrase', X.host);
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('reset_link_invalid');
    await Client.login(app, X.host, email, NEW);
    expect((await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='auth.setup_link_rejected'`, [X.id])).length).toBe(1);
  });

  it('two people presenting one link at once: exactly one wins', async () => {
    const X = await createTenant(); const email = X.users.other!.email;
    await forgot(email, X.host);
    const token = await linkFor(email);
    const answers = await Promise.all([reset(token, 'first fine passphrase', X.host), reset(token, 'second fine passphrase', X.host)]);
    expect(answers.map((a) => a.statusCode).sort()).toEqual([200, 400]);
  });

  it('an expired link is refused', async () => {
    const X = await createTenant(); const email = X.users.other!.email;
    await forgot(email, X.host);
    const token = await linkFor(email);
    await ownerQuery(`UPDATE admin_setup_tokens SET expires_at=now() - interval '1 second' WHERE user_id=$1`, [X.users.other!.id]);
    expect((await reset(token, NEW, X.host)).json().error.code).toBe('reset_link_invalid');
    await Client.login(app, X.host, email);
  });

  it('expiry is short, and a new link ends the one before', async () => {
    const X = await createTenant(); const email = X.users.manager!.email;
    await forgot(email, X.host);
    const first = await linkFor(email);
    const [row] = await ownerQuery<{ minutes: number; purpose: string }>(`SELECT round(extract(epoch FROM expires_at - now()) / 60)::int AS minutes, purpose FROM admin_setup_tokens WHERE user_id=$1`, [X.users.manager!.id]);
    expect(row).toEqual({ minutes: 30, purpose: 'reset' });
    await forgot(email, X.host);
    const second = await linkFor(email);
    expect(second).not.toBe(first);
    expect((await reset(first, NEW, X.host)).statusCode).toBe(400);
    expect((await reset(second, NEW, X.host)).statusCode).toBe(200);
  });

  it('the token is hashed at rest and never readable in the outbox, before or after sending', async () => {
    const X = await createTenant(); const email = X.users.hr!.email;
    await forgot(email, X.host);
    const [queued] = await ownerQuery<{ text_body: string; html_body: string; secret_enc: string }>(`SELECT text_body, html_body, secret_enc FROM email_outbox WHERE to_email=$1 AND status='queued'`, [email]);
    expect(queued!.secret_enc).toMatch(/^v2\./);
    expect(queued!.text_body).toContain('#token=__SECRET__');
    expect(queued!.html_body).toContain('#token=__SECRET__');
    const token = await linkFor(email);
    expect(sent.find((m) => m.to === email)!.html.includes(token)).toBe(true);
    const [row] = await ownerQuery<{ token_hash: string }>(`SELECT token_hash FROM admin_setup_tokens WHERE user_id=$1`, [X.users.hr!.id]);
    expect(row!.token_hash).not.toContain(token);
    const [after] = await ownerQuery<{ secret_enc: string | null; text_body: string; html_body: string }>(`SELECT secret_enc, text_body, html_body FROM email_outbox WHERE to_email=$1 AND kind='security.password_reset'`, [email]);
    expect(after!.secret_enc).toBeNull();
    expect(after!.text_body + after!.html_body).not.toContain(token);
    expect((await ownerQuery(`SELECT 1 FROM notifications WHERE kind='security.password_reset'`)).length).toBe(0);
  });

  it('a mail that could not be sent in time does not go out, and its secret goes', async () => {
    const X = await createTenant(); const email = X.users.payroll!.email;
    await forgot(email, X.host);
    await ownerQuery(`UPDATE email_outbox SET expires_at=now() - interval '1 second' WHERE to_email=$1`, [email]);
    await deliver();
    expect(sent.filter((m) => m.to === email)).toEqual([]);
    const [row] = await ownerQuery<{ status: string; secret_enc: string | null }>(`SELECT status, secret_enc FROM email_outbox WHERE to_email=$1`, [email]);
    expect(row).toEqual({ status: 'failed', secret_enc: null });
  });

  it('the new password goes through the policy, and a refused one leaves the link alive', async () => {
    const X = await createTenant(); const email = X.users.it!.email;
    await forgot(email, X.host);
    const token = await linkFor(email);
    const weak = await reset(token, 'password1234', X.host);
    expect(weak.json().error.code).toBe('weak_password');
    expect((await reset(token, NEW, X.host)).statusCode).toBe(200);
  });

  it('a reset does not remove the second factor', async () => {
    const X = await createTenant(); const email = X.users.employee!.email;
    const c = await Client.login(app, X.host, email);
    const s = (await c.post('/api/v1/auth/mfa/setup')).json();
    expect((await c.post('/api/v1/auth/mfa/enable', { code: hotp(base32Decode(s.secret), timeStep(Date.now())) })).statusCode).toBe(200);
    await forgot(email, X.host);
    expect((await reset(await linkFor(email), NEW, X.host)).statusCode).toBe(200);
    const after = await Client.login(app, X.host, email, NEW);
    expect((await after.get('/api/v1/employees')).json().error.code).toBe('mfa_required');
  });

  it('a reset clears back-off held against the account', async () => {
    const X = await createTenant(); const email = X.users.other!.email;
    const from = '198.51.100.77';
    for (let i = 0; i < 5; i++) await raw('POST', '/api/v1/auth/login', { email, password: 'wrong-guess' }, X.host, from);
    expect((await raw('POST', '/api/v1/auth/login', { email, password: PASSWORD }, X.host, from)).statusCode).toBe(429);
    await forgot(email, X.host);
    await reset(await linkFor(email), NEW, X.host);
    expect((await raw('POST', '/api/v1/auth/login', { email, password: NEW }, X.host, from)).statusCode).toBe(200);
  });

  it('a link from one organization does nothing on another', async () => {
    const X = await createTenant(); const Y = await createTenant();
    await forgot(X.users.other!.email, X.host);
    const token = await linkFor(X.users.other!.email);
    expect((await reset(token, NEW, Y.host)).statusCode).toBe(400);
    expect((await reset(token, NEW, X.host)).statusCode).toBe(200);
  });
});

describe('no enumeration', () => {
  it('known, unknown, disabled and over-the-limit addresses get the same answer', async () => {
    const X = await createTenant();
    await ownerQuery(`UPDATE users SET status='disabled' WHERE id=$1`, [X.users.other!.id]);
    for (let i = 0; i < LINKS_PER_HOUR; i++) await forgot(X.users.manager!.email, X.host);
    const answers = await Promise.all([forgot(X.users.employee!.email, X.host), forgot(`nobody@${X.host}`, X.host), forgot(X.users.other!.email, X.host), forgot(X.users.manager!.email, X.host)]);
    for (const a of answers) { expect(a.statusCode).toBe(200); expect(a.body).toBe('{"ok":true}'); }
    await deliver();
    expect(sent.filter((m) => m.to === `nobody@${X.host}`)).toEqual([]);
    expect(sent.filter((m) => m.to === X.users.other!.email)).toEqual([]);
    expect(sent.filter((m) => m.to === X.users.employee!.email)).toHaveLength(1);
    expect(sent.filter((m) => m.to === X.users.manager!.email)).toHaveLength(LINKS_PER_HOUR);
  });

  const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  it('a reset request takes about as long for an address with no account', async () => {
    const X = await createTenant();
    const time = async (email: () => string) => { const out: number[] = []; for (let i = 0; i < 9; i++) { const t = performance.now(); await forgot(email(), X.host); out.push(performance.now() - t); } return median(out); };
    let n = 0;
    const known = await time(() => X.users.employee!.email);
    const unknown = await time(() => `nobody${n++}@${X.host}`);
    expect(known).toBeGreaterThanOrEqual(240);
    expect(Math.abs(known - unknown), `known ${known} ms, unknown ${unknown} ms`).toBeLessThan(60);
  }, 30000);

  it('a failed sign-in takes about as long for an address with no account', async () => {
    const X = await createTenant();
    const time = async (email: () => string) => { const out: number[] = []; for (let i = 0; i < 4; i++) { const t = performance.now(); const r = await raw('POST', '/api/v1/auth/login', { email: email(), password: 'wrong-guess-here' }, X.host); out.push(performance.now() - t); expect(r.statusCode).toBe(401); } return median(out); };
    let n = 0;
    const known = await time(() => X.users.employee!.email);
    const unknown = await time(() => `nobody${n++}@${X.host}`);
    expect(Math.abs(known - unknown) / known, `known ${known} ms, unknown ${unknown} ms`).toBeLessThan(0.4);
    const [a, b] = await Promise.all([raw('POST', '/api/v1/auth/login', { email: X.users.other!.email, password: 'wrong-guess-here' }, X.host), raw('POST', '/api/v1/auth/login', { email: `someone@${X.host}`, password: 'wrong-guess-here' }, X.host)]);
    expect(a.statusCode).toBe(b.statusCode);
    expect(a.body).toBe(b.body);
  }, 30000);

  it('an invited person with no password yet looks like any wrong password', async () => {
    const X = await createTenant();
    const admin = await Client.login(app, X.host, X.users.admin!.email);
    await admin.post('/api/v1/tenant/users', { email: `invited@${X.host}`, displayName: 'In Vited', roles: ['employee'] });
    const r = await raw('POST', '/api/v1/auth/login', { email: `invited@${X.host}`, password: 'anything-goes-here' }, X.host);
    expect(r.statusCode).toBe(401);
  });

  it('per-address limit answers 429 the same for known and unknown', async () => {
    const a = await makeApp({ TRUST_PROXY: '1' }, { mailerOverride: true });
    const X = await createTenant();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await a.inject({ method: 'POST', url: '/api/v1/auth/password/forgot', payload: { email: i % 2 ? `nobody@${X.host}` : X.users.other!.email }, headers: { host: X.host, 'x-forwarded-for': '203.0.113.50' } })).statusCode);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5)).toEqual([429, 429]);
    await a.close();
  }, 20000);

  it('without a mail transport the answer is still the same, and public config says it cannot work', async () => {
    setMailer(null);
    try {
      expect((await forgot(T.users.employee!.email)).json()).toEqual({ ok: true });
      expect((await ownerQuery(`SELECT 1 FROM admin_setup_tokens WHERE user_id=$1`, [T.users.employee!.id])).length).toBe(0);
    } finally { setMailer({ send: async (m) => { sent.push(m); } }, 'test@test'); }
    expect((await raw('GET', '/api/v1/config/public', undefined)).json().auth).toEqual({ resetByEmail: false });
  });
});

describe('invitations replace initial passwords', () => {
  let X: TenantFixture; let admin: Client;
  beforeAll(async () => { X = await createTenant(); admin = await Client.login(app, X.host, X.users.admin!.email); });
  const create = (email: string, extra: object = {}) => admin.post('/api/v1/tenant/users', { email, displayName: 'Asha Rao', roles: ['employee'], ...extra });

  it('an administrator cannot choose a password for someone', async () => {
    const r = await create(`chosen@${X.host}`, { initialPassword: 'Initial-Password-123' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/invitation/);
    expect((await ownerQuery(`SELECT 1 FROM users WHERE email=$1`, [`chosen@${X.host}`])).length).toBe(0);
  });

  it('creating a user sends an invitation; they choose a password and sign in', async () => {
    const email = `asha@${X.host}`;
    const r = await create(email);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().inviteSent).toBe(true);
    const [row] = await ownerQuery<{ password_hash: string | null; must_change_password: boolean; hours: number; purpose: string }>(`SELECT u.password_hash, u.must_change_password, round(extract(epoch FROM t.expires_at - now()) / 3600)::int AS hours, t.purpose FROM users u JOIN admin_setup_tokens t ON t.user_id=u.id WHERE u.email=$1`, [email]);
    expect(row).toEqual({ password_hash: null, must_change_password: false, hours: 72, purpose: 'invite' });
    const listed = (await admin.get('/api/v1/tenant/users?pageSize=50')).json().items.find((u: { email: string }) => u.email === email);
    expect(listed.invite_pending).toBe(true);
    const token = await linkFor(email);
    // Not a reset link: the two routes do not share purposes.
    expect((await reset(token, NEW, X.host)).statusCode).toBe(400);
    expect((await raw('POST', '/api/v1/auth/setup', { token, newPassword: 'password1234' }, X.host)).json().error.code).toBe('weak_password');
    expect((await raw('POST', '/api/v1/auth/setup', { token, newPassword: NEW }, X.host)).statusCode).toBe(200);
    const c = await Client.login(app, X.host, email, NEW);
    expect(c.passwordChangeRequired).toBe(false);
    expect((await raw('POST', '/api/v1/auth/setup', { token, newPassword: 'another fine passphrase' }, X.host)).json().error.code).toBe('setup_link_invalid');
  });

  it('a reset link does not work at the invitation route', async () => {
    const Y = await createTenant();
    await forgot(Y.users.other!.email, Y.host);
    const token = await linkFor(Y.users.other!.email);
    expect((await raw('POST', '/api/v1/auth/setup', { token, newPassword: NEW }, Y.host)).json().error.code).toBe('setup_link_invalid');
  });

  it('an expired invitation is refused; resending makes a new one and ends the old; an accepted one cannot be resent', async () => {
    const email = `late@${X.host}`;
    const id = (await create(email)).json().id as string;
    const first = await linkFor(email);
    expect((await admin.post(`/api/v1/tenant/users/${id}/invite`)).statusCode).toBe(200);
    const second = await linkFor(email);
    expect((await raw('POST', '/api/v1/auth/setup', { token: first, newPassword: NEW }, X.host)).statusCode).toBe(400);
    await ownerQuery(`UPDATE admin_setup_tokens SET expires_at=now() - interval '1 second' WHERE user_id=$1 AND used_at IS NULL`, [id]);
    expect((await raw('POST', '/api/v1/auth/setup', { token: second, newPassword: NEW }, X.host)).statusCode).toBe(400);
    expect((await admin.post(`/api/v1/tenant/users/${id}/invite`)).statusCode).toBe(200);
    await ownerQuery(`UPDATE admin_setup_tokens SET created_at=created_at - interval '2 hours' WHERE user_id=$1`, [id]);
    expect((await raw('POST', '/api/v1/auth/setup', { token: await linkFor(email), newPassword: NEW }, X.host)).statusCode).toBe(200);
    expect((await admin.post(`/api/v1/tenant/users/${id}/invite`)).statusCode).toBe(409);
  });

  it('resends are limited per person; a disabled person gets none and their link stops working', async () => {
    const email = `limited@${X.host}`;
    const id = (await create(email)).json().id as string;
    const token = await linkFor(email);
    for (let i = 1; i < LINKS_PER_HOUR; i++) expect((await admin.post(`/api/v1/tenant/users/${id}/invite`)).statusCode).toBe(200);
    expect((await admin.post(`/api/v1/tenant/users/${id}/invite`)).statusCode).toBe(429);
    await ownerQuery(`UPDATE admin_setup_tokens SET used_at=NULL WHERE user_id=$1 AND token_hash = (SELECT token_hash FROM admin_setup_tokens WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1)`, [id]);
    expect((await admin.patch(`/api/v1/tenant/users/${id}`, { status: 'disabled' })).statusCode).toBe(200);
    expect((await admin.post(`/api/v1/tenant/users/${id}/invite`)).statusCode).toBe(409);
    await deliver();
    const latest = tokenIn(sent.filter((m) => m.to === email).at(-1)!) ?? token;
    expect((await raw('POST', '/api/v1/auth/setup', { token: latest, newPassword: NEW }, X.host)).statusCode).toBe(400);
  });

  it('without mail the person is still created, and is told apart; resending says why it cannot', async () => {
    setMailer(null);
    try {
      const r = await create(`nomail@${X.host}`);
      expect(r.statusCode).toBe(201);
      expect(r.json().inviteSent).toBe(false);
      const again = await admin.post(`/api/v1/tenant/users/${r.json().id}/invite`);
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('feature_not_configured');
    } finally { setMailer({ send: async (m) => { sent.push(m); } }, 'test@test'); }
  });

  it('an administrator can send a reset to someone below them, and not to someone at or above', async () => {
    const Y = await createTenant();
    const a = await Client.login(app, Y.host, Y.users.admin!.email);
    const it_ = await Client.login(app, Y.host, Y.users.it!.email);
    expect((await a.post(`/api/v1/tenant/users/${Y.users.employee!.id}/password-reset`)).statusCode).toBe(200);
    const email = Y.users.employee!.email;
    expect((await reset(await linkFor(email), NEW, Y.host)).statusCode).toBe(200);
    expect((await it_.post(`/api/v1/tenant/users/${Y.users.admin!.id}/password-reset`)).statusCode).toBe(403);
    expect((await a.post(`/api/v1/tenant/users/00000000-0000-0000-0000-000000000000/password-reset`)).statusCode).toBe(404);
    expect((await (await Client.login(app, Y.host, Y.users.employee!.email, NEW)).post(`/api/v1/tenant/users/${Y.users.other!.id}/password-reset`)).statusCode).toBe(403);
  });
});

describe('security emails go out whatever the preference', () => {
  let X: TenantFixture;
  const optOut = (id: string) => ownerQuery(`UPDATE users SET email_notifications=false WHERE id=$1`, [id]);
  const mailsTo = async (email: string) => { await deliver(); return sent.filter((m) => m.to === email); };
  beforeAll(async () => { X = await createTenant(); });
  const loginFrom = (email: string, device?: string, password = PASSWORD) => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password }, headers: { host: X.host, 'x-forwarded-for': ip(), 'user-agent': 'Firefox/test', ...(device ? { cookie: device } : {}) } });
  const deviceOf = (r: { headers: Record<string, unknown> }) => ([r.headers['set-cookie']].flat() as string[]).find((c) => c.startsWith('hrms_did='))!.split(';')[0]!;

  it('new device: not on the first sign-in, not from a known browser, and yes from a new one', async () => {
    const u = X.users.employee!;
    await optOut(u.id);
    const first = await loginFrom(u.email);
    expect(await mailsTo(u.email)).toEqual([]);
    await loginFrom(u.email, deviceOf(first));
    expect(await mailsTo(u.email)).toEqual([]);
    await loginFrom(u.email);
    const mails = await mailsTo(u.email);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain('New sign-in');
    expect(mails[0]!.text).toContain('Firefox/test');
    expect(mails[0]!.text).toContain('cannot be turned off');
    expect(mails[0]!.text).not.toContain('You can turn off');
    expect((await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='auth.new_device' AND actor_id=$2`, [X.id, u.id])).length).toBe(1);
  });

  it('a wrong password from a new browser is not news', async () => {
    const u = X.users.manager!;
    await loginFrom(u.email);
    await loginFrom(u.email, undefined, 'wrong-guess-here');
    expect(await mailsTo(u.email)).toEqual([]);
  });

  it('password changed, by the person and by a link', async () => {
    const u = X.users.other!;
    await optOut(u.id);
    const c = await Client.login(app, X.host, u.email);
    await c.post('/api/v1/auth/password', { currentPassword: PASSWORD, newPassword: NEW });
    expect((await mailsTo(u.email)).filter((m) => m.subject.includes('password was changed'))).toHaveLength(1);
    sent.length = 0;
    await forgot(u.email, X.host);
    await reset(await linkFor(u.email), 'quiet river stone ladder', X.host);
    const mails = await mailsTo(u.email);
    expect(mails.filter((m) => m.subject.includes('password was changed'))).toHaveLength(1);
  });

  it('MFA on and off, recovery code used', async () => {
    const u = X.users.hr!;
    await optOut(u.id);
    const c = await Client.login(app, X.host, u.email);
    const s = (await c.post('/api/v1/auth/mfa/setup')).json();
    const on = await c.post('/api/v1/auth/mfa/enable', { code: hotp(base32Decode(s.secret), timeStep(Date.now())) });
    expect((await mailsTo(u.email)).map((m) => m.subject).join()).toContain('turned on');
    sent.length = 0;
    const d = await Client.login(app, X.host, u.email);
    expect((await d.post('/api/v1/auth/mfa/verify', { code: on.json().recoveryCodes[0] })).statusCode).toBe(200);
    expect((await mailsTo(u.email)).map((m) => m.subject).join()).toContain('recovery code');
    sent.length = 0;
    await ownerQuery(`UPDATE users SET mfa_last_step = mfa_last_step - 2 WHERE id=$1`, [u.id]);
    expect((await d.post('/api/v1/auth/mfa/disable', { password: PASSWORD, code: hotp(base32Decode(s.secret), timeStep(Date.now())) })).statusCode).toBe(200);
    expect((await mailsTo(u.email)).map((m) => m.subject).join()).toContain('turned off');
  });
});
