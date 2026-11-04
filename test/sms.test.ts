import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture } from './helpers.js';
import { setSmsSender, normalizePhone, renderSms, maskPhone, type OutgoingSms } from '../src/core/notify/sms.js';
import { deliverSmsOutbox } from '../src/core/notify/service.js';

const sent: OutgoingSms[] = [];
let fail = false;
let app: FastifyInstance; let T: TenantFixture;
let admin: Client; let emp: Client; let mgr: Client;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const back = (n: number) => { let d = new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10); while (new Date(`${d}T00:00:00Z`).getUTCDay() === 0) d = new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10); return d; };
const ist = (date: string, hhmm: string) => `${date}T${hhmm}:00+05:30`;
const quiet = { error: () => {} };
const correction = (date: string) => emp.post('/api/v1/attendance/regularizations', { workDate: date, requestedIn: ist(date, '09:30'), requestedOut: ist(date, '18:00'), reason: 'Biometric device was offline' });
const deliver = () => deliverSmsOutbox(app.deps.pool, quiet);
const TEMPLATE = { dltTemplateId: '1107161234567890123', text: 'HRMS: {#var#}. Details: {#var#}. Open HRMS to act. -ACMELB' };

beforeAll(async () => {
  setSmsSender({ async send(m) { if (fail) throw new Error('provider down'); sent.push(m); return { ref: 'msg-1' }; } });
  app = await makeApp({ ENABLED_MODULES: 'default,notifications.sms' }, { smsOverride: true });
  T = await createTenant();
  admin = await Client.login(app, T.host, T.users.admin!.email);
  emp = await Client.login(app, T.host, T.users.employee!.email);
  mgr = await Client.login(app, T.host, T.users.manager!.email);
  await ownerQuery(`UPDATE employees SET phone='098765 43210' WHERE id=$1`, [T.users.manager!.employeeId]);
});
afterAll(async () => { setSmsSender(null); await app.close(); });

describe('sms', () => {
  it('numbers and templates', () => {
    expect(normalizePhone('98765 43210')).toBe('+919876543210');
    expect(normalizePhone('+91 98765-43210')).toBe('+919876543210');
    expect(normalizePhone('919876543210')).toBe('+919876543210');
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('+9112345678')).toBeNull();         // not an Indian mobile
    expect(normalizePhone('+447700900123')).toBe('+447700900123');
    expect(maskPhone('+919876543210')).toBe('•••••••••3210');
    expect(renderSms('Hi {#var#}, {#var#}!', ['A very long title that goes past thirty characters', 'ok'])).toBe('Hi A very long title that goes pa, ok!');
  });

  it('only the administrator manages templates; the DLT template ID and placeholders are checked', async () => {
    expect((await emp.get('/api/v1/sms/templates')).statusCode).toBe(403);
    const t = (await admin.get('/api/v1/sms/templates')).json();
    expect(t.transport).toBe(true);
    expect(t.items.find((i: { kind: string }) => i.kind === 'approval.requested')).toMatchObject({ template: null });
    expect((await admin.put('/api/v1/sms/templates/approval.requested', { ...TEMPLATE, dltTemplateId: '12AB' })).statusCode).toBe(400);
    expect((await admin.put('/api/v1/sms/templates/approval.requested', { ...TEMPLATE, text: '{#var#} {#var#} {#var#}' })).statusCode).toBe(400);
    expect((await admin.put('/api/v1/sms/templates/no.such', TEMPLATE)).statusCode).toBe(400);
    expect((await admin.put('/api/v1/sms/templates/approval.requested', TEMPLATE)).statusCode).toBe(200);
  });

  it('a notification with a template is queued in the same transaction and delivered to the mobile on the employee record', async () => {
    expect((await correction(back(2))).statusCode).toBe(201);
    const q = await ownerQuery<{ status: string; to_phone: string; text: string }>(`SELECT status, to_phone, text FROM sms_outbox WHERE tenant_id=$1`, [T.id]);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ status: 'queued', to_phone: '098765 43210' });
    expect(await deliver()).toMatchObject({ sent: 1 });
    expect(sent).toEqual([{ to: '+919876543210', templateId: TEMPLATE.dltTemplateId, text: expect.stringMatching(/^HRMS: .+\. Details: .*\. Open HRMS to act\. -ACMELB$/) }]);
    const out = (await admin.get('/api/v1/sms/outbox')).json().items;
    expect(out[0]).toMatchObject({ status: 'sent', to: '•••••••••3210' });
    expect(JSON.stringify(out)).not.toContain('98765');
  });

  it('failures retry with back-off; a user who opts out gets no SMS; no template, no SMS', async () => {
    fail = true;
    expect((await correction(back(4))).statusCode).toBe(201);
    expect(await deliver()).toMatchObject({ failed: 1 });
    const [r] = await ownerQuery<{ status: string; attempts: number; last_error: string }>(`SELECT status, attempts, last_error FROM sms_outbox WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1`, [T.id]);
    expect(r).toMatchObject({ status: 'queued', attempts: 1, last_error: 'provider down' });
    fail = false;
    expect((await mgr.put('/api/v1/auth/preferences', { smsNotifications: false })).statusCode).toBe(200);
    expect((await mgr.get('/api/v1/auth/me')).json().preferences).toMatchObject({ smsNotifications: false, emailNotifications: true });
    const before = (await ownerQuery(`SELECT 1 FROM sms_outbox WHERE tenant_id=$1`, [T.id])).length;
    expect((await correction(back(6))).statusCode).toBe(201);
    expect((await ownerQuery(`SELECT 1 FROM sms_outbox WHERE tenant_id=$1`, [T.id])).length).toBe(before);
  });
});
