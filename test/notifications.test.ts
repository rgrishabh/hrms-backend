import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture } from './helpers.js';
import { setMailer, type OutgoingMail } from '../src/core/notify/mailer.js';
import { deliverOutbox } from '../src/core/notify/service.js';
import { tick } from '../src/core/jobs/scheduler.js';
import { addDays, localDate } from '../src/modules/attendance/time.js';

const quiet = { info: () => undefined, error: () => undefined };
const sent: OutgoingMail[] = [];
let failNext = 0;
const capture = { async send(m: OutgoingMail) { if (failNext > 0) { failNext--; throw new Error('SMTP 451 temporary failure'); } sent.push(m); } };
const today = localDate(new Date(), 'Asia/Kolkata');
const workday = (min: number) => { let d = addDays(today, -min); while (new Date(d + 'T00:00:00Z').getUTCDay() === 0) d = addDays(d, -1); return d; };
const ist = (d: string, t: string) => `${d}T${t}:00+05:30`;

let app: FastifyInstance; let T: TenantFixture;
beforeAll(async () => {
  setMailer(capture, '"Acme Labs" <hr@acme.test>');
  app = await makeApp({ ENABLED_MODULES: 'default,notifications.email,attendance.mobile,attendance.biometric', BRAND_NAME: 'Acme Labs', BRAND_PRIMARY_COLOR: '#14532D',
    APP_URL: 'https://hrms.acme.test' }, { mailerOverride: true });
  T = await createTenant();
});
afterAll(async () => { await app.close(); setMailer(null); await makeApp().then((x) => x.close()); });
beforeEach(() => { sent.length = 0; failNext = 0; });

const inbox = async (c: Client) => (await c.get('/api/v1/notifications')).json();

describe('approval notifications', () => {
  it('notifies the approver in-app and by email (branded, no sensitive data) when a request is created', async () => {
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    const mgr = await Client.login(app, T.host, T.users.manager!.email);
    const d = workday(2);
    await emp.post('/api/v1/attendance/regularizations', { workDate: d, requestedIn: ist(d, '09:30'), requestedOut: ist(d, '18:00'), reason: 'Forgot to punch' });
    const n = await inbox(mgr);
    expect(n.items[0]).toMatchObject({ kind: 'approval.requested', link: '/approvals', read_at: null });
    expect(n.items[0].title).toMatch(/Attendance correction from employee needs your approval/);
    expect((await mgr.get('/api/v1/notifications/unread-count')).json().unread).toBe(1);
    expect((await inbox(emp)).items).toHaveLength(0); // requester is not notified of their own request
    await deliverOutbox(app.deps.pool, quiet);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: T.users.manager!.email, from: '"Acme Labs" <hr@acme.test>' });
    expect(sent[0]!.subject).toMatch(/needs your approval · Acme Labs$/);
    expect(sent[0]!.html).toContain('https://hrms.acme.test/approvals');
    expect(sent[0]!.html).toContain('#14532D');
    expect(sent[0]!.text).toContain('Review: https://hrms.acme.test/approvals');
  });

  it('notifies the requester of the decision with the comment', async () => {
    const mgr = await Client.login(app, T.host, T.users.manager!.email);
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    const req = (await mgr.get('/api/v1/approvals/inbox')).json().items[0];
    await mgr.post(`/api/v1/approvals/${req.id}/act`, { action: 'reject', comment: 'No record at the gate' });
    const n = (await inbox(emp)).items[0];
    expect(n).toMatchObject({ kind: 'approval.rejected', link: '/attendance/me', title: 'Your attendance correction was rejected' });
    expect(n.body).toContain('No record at the gate');
  });

  it('permission-based steps notify every holder of the permission (HR), never the requester', async () => {
    const other = await Client.login(app, T.host, T.users.other!.email); // has no manager login → HR step
    const d = workday(3);
    await other.post('/api/v1/attendance/regularizations', { workDate: d, requestedIn: ist(d, '09:30'), reason: 'Missed punch' });
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    expect((await inbox(hr)).items.some((x: { kind: string }) => x.kind === 'approval.requested')).toBe(true);
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    expect((await inbox(admin)).items.some((x: { kind: string }) => x.kind === 'approval.requested')).toBe(false);
  });
});

describe('inbox API', () => {
  it('marks read individually and all; users only see their own', async () => {
    const mgr = await Client.login(app, T.host, T.users.manager!.email);
    const first = (await inbox(mgr)).items[0];
    expect((await mgr.post(`/api/v1/notifications/${first.id}/read`)).statusCode).toBe(200);
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    expect((await emp.post(`/api/v1/notifications/${first.id}/read`)).statusCode).toBe(404); // someone else's
    await emp.post('/api/v1/notifications/read-all');
    expect((await emp.get('/api/v1/notifications/unread-count')).json().unread).toBe(0);
    expect((await emp.get('/api/v1/notifications?unread=true')).json().total).toBe(0);
  });
});

describe('email delivery', () => {
  it('respects the per-user opt-out but keeps the in-app notification', async () => {
    await deliverOutbox(app.deps.pool, quiet); // emails queued before the opt-out are still delivered
    sent.length = 0;
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    expect((await emp.put('/api/v1/auth/preferences', { emailNotifications: false })).statusCode).toBe(200);
    expect((await emp.get('/api/v1/auth/me')).json().preferences.emailNotifications).toBe(false);
    await emp.post('/api/v1/auth/password', { currentPassword: 'Test-Password-123!', newPassword: 'Changed-Password-456!' });
    await deliverOutbox(app.deps.pool, quiet);
    expect(sent.filter((m) => m.to === T.users.employee!.email)).toHaveLength(0);
    expect((await inbox(emp)).items[0]).toMatchObject({ kind: 'security.password_changed' });
  });

  it('retries failed sends with backoff, then delivers once', async () => {
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    await hr.post('/api/v1/auth/password', { currentPassword: 'Test-Password-123!', newPassword: 'Changed-Password-789!' });
    failNext = 1;
    expect(await deliverOutbox(app.deps.pool, quiet)).toMatchObject({ sent: 0, failed: 1 });
    const [row] = await ownerQuery<{ status: string; attempts: number; last_error: string }>(
      `SELECT status, attempts, last_error FROM email_outbox WHERE tenant_id=$1 AND kind='security.password_changed' AND to_email=$2`, [T.id, T.users.hr!.email]);
    expect(row).toMatchObject({ status: 'queued', attempts: 1, last_error: 'SMTP 451 temporary failure' });
    expect(await deliverOutbox(app.deps.pool, quiet)).toMatchObject({ sent: 0 }); // backoff not elapsed
    await ownerQuery(`UPDATE email_outbox SET next_attempt_at = now() WHERE tenant_id=$1 AND status='queued'`, [T.id]);
    await deliverOutbox(app.deps.pool, quiet);
    expect(sent.filter((m) => m.to === T.users.hr!.email)).toHaveLength(1);
    await deliverOutbox(app.deps.pool, quiet);
    expect(sent.filter((m) => m.to === T.users.hr!.email)).toHaveLength(1); // never sent twice
  });

  it('queues no email when the email module is not enabled', async () => {
    const off = await makeApp({ ENABLED_MODULES: 'default' }, { mailerOverride: true });
    const U = await createTenant();
    const u = await Client.login(off, U.host, U.users.employee!.email);
    await u.post('/api/v1/auth/password', { currentPassword: 'Test-Password-123!', newPassword: 'Changed-Password-000!' });
    expect(await ownerQuery(`SELECT 1 FROM email_outbox WHERE tenant_id=$1`, [U.id])).toHaveLength(0);
    expect(await ownerQuery(`SELECT 1 FROM notifications WHERE tenant_id=$1`, [U.id])).toHaveLength(1);
    await off.close();
    await makeApp({ ENABLED_MODULES: 'default,notifications.email' }, { mailerOverride: true }).then((x) => x.close());
  });
});

describe('reminders', () => {
  it('reminds approvers of overdue requests once per day', async () => {
    await ownerQuery(`UPDATE approval_requests SET created_at = now() - interval '5 days' WHERE tenant_id=$1 AND status='pending'`, [T.id]);
    const at = new Date(`${today}T23:00:00+05:30`);
    await tick(app.deps.pool, quiet, at);
    const [run] = await ownerQuery<{ result: { pendingOverdue: number; notificationsCreated: number } }>(
      `SELECT result FROM job_runs WHERE tenant_id=$1 AND job_key='approvals.reminder'`, [T.id]);
    expect(run!.result.pendingOverdue).toBeGreaterThan(0);
    expect(run!.result.notificationsCreated).toBeGreaterThan(0);
    const hr = await Client.login(app, T.host, T.users.hr!.email, 'Changed-Password-789!');
    const reminders = (await inbox(hr)).items.filter((x: { kind: string }) => x.kind === 'approval.reminder');
    expect(reminders.length).toBe(1);
    expect(reminders[0].title).toMatch(/Waiting 5 day\(s\) for your approval/);
    // A manual re-run the same day does not duplicate the reminder.
    await hr.runJob('approvals.reminder').catch(() => undefined);
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    await admin.runJob('approvals.reminder');
    expect((await inbox(hr)).items.filter((x: { kind: string }) => x.kind === 'approval.reminder').length).toBe(1);
  });
});

describe('there is no SMS', () => {
  it('tables and preference are gone, and so are the routes and the preference field', async () => {
    const a = await makeApp();
    const T = await createTenant();
    const rows = await ownerQuery<{ n: string }>(`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('sms_outbox','sms_templates')`);
    expect(rows[0]!.n).toBe('0');
    const cols = await ownerQuery<{ n: string }>(`SELECT count(*) AS n FROM information_schema.columns WHERE table_name='users' AND column_name='sms_notifications'`);
    expect(cols[0]!.n).toBe('0');
    const hr = await Client.login(a, T.host, T.users.hr!.email);
    expect((await hr.get('/api/v1/sms/templates')).statusCode).toBe(404);
    const me = (await hr.get('/api/v1/auth/me')).json();
    expect(me.preferences).not.toHaveProperty('smsNotifications');
    expect(me.capabilities).not.toHaveProperty('notifications.sms');
    await a.close();
  });
});
