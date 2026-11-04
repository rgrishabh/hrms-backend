import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDecipheriv, createECDH, createVerify, generateKeyPairSync, hkdfSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, flags, inApp, type TenantFixture } from './helpers.js';
import { createPushSender, encryptPayload, isAllowedEndpoint, pushPayload, setPushSender, vapidHeader, type PushMessage, type PushResult, type PushSubscription } from '../src/core/notify/push.js';
import { deliverPushOutbox, notifyUsers } from '../src/core/notify/service.js';
import { withTenant } from '../src/db/tx.js';

const b = (s: string) => Buffer.from(s, 'base64url');

describe('RFC 8291 and RFC 8292', () => {
  it('reproduces the test vector of RFC 8291 appendix A', () => {
    const eph = createECDH('prime256v1');
    eph.setPrivateKey(b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'));
    const out = encryptPayload(Buffer.from('When I grow up, I want to be a watermelon'),
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', { eph, salt: b('DGv6ra1nlYgDCS1FRnbzlw') });
    expect(out.toString('base64url')).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  });

  it('a browser can decrypt what is sent with fresh keys', () => {
    const ua = createECDH('prime256v1'); ua.generateKeys();
    const auth = Buffer.alloc(16, 3);
    const out = encryptPayload(Buffer.from('hello'), ua.getPublicKey().toString('base64url'), auth.toString('base64url'));
    const salt = out.subarray(0, 16); const idlen = out[20]!; const asPublic = out.subarray(21, 21 + idlen); const body = out.subarray(21 + idlen);
    const ikm = Buffer.from(hkdfSync('sha256', ua.computeSecret(asPublic), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
    const d = createDecipheriv('aes-128-gcm', Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16)), Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12)));
    d.setAuthTag(body.subarray(-16));
    const plain = Buffer.concat([d.update(body.subarray(0, -16)), d.final()]);
    expect(plain.toString()).toBe('hello\u0002');
  });

  it('the VAPID token verifies against the public key and names the push service', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string; y: string };
    const pub = Buffer.concat([Buffer.from([4]), b(jwk.x), b(jwk.y)]).toString('base64url');
    const h = vapidHeader('https://fcm.googleapis.com/fcm/send/abc', pub, jwk.d, 'mailto:a@example.test', 1_000_000_000_000);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
    expect(m[4]).toBe(pub);
    expect(JSON.parse(b(m[2]!).toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_000_000_000 + 43200, sub: 'mailto:a@example.test' });
    expect(createVerify('SHA256').update(`${m[1]}.${m[2]}`).verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, b(m[3]!))).toBe(true);
  });

  it('calls only the browsers\' push services', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://wns2-par02p.notify.windows.com/w/x']) expect(isAllowedEndpoint(ok)).toBe(true);
    for (const bad of ['http://fcm.googleapis.com/x', 'https://169.254.169.254/latest', 'https://localhost/x', 'https://fcm.googleapis.com.evil.test/x', 'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'not a url']) expect(isAllowedEndpoint(bad)).toBe(false);
  });

  it('without keys there is no sender', () => {
    expect(createPushSender({ VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined, VAPID_SUBJECT: undefined, BRAND_SUPPORT_EMAIL: 'a@example.test' })).toBeNull();
  });
});

describe('push notifications', () => {
  let app: FastifyInstance; let T: TenantFixture; let emp: Client;
  const sent: { sub: PushSubscription; msg: PushMessage }[] = [];
  let answer: PushResult = { ok: true };
  const log = { error: () => undefined };
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/device-1', keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } };
  beforeAll(async () => {
    setPushSender({ publicKey: 'PUB', async send(s, msg) { sent.push({ sub: s, msg }); return answer; } });
    app = await makeApp({ ...flags('default,notifications.push'), BRAND_NAME: 'Acme' }, { pushOverride: true });
    T = await createTenant();
    emp = await Client.login(app, T.host, T.users.employee!.email);
  });
  afterAll(async () => { setPushSender(null); await app.close(); });

  it('a browser subscribes; endpoints that are not push services are refused', async () => {
    expect((await emp.get('/api/v1/notifications/push/public-key')).json().publicKey).toBe('PUB');
    expect((await emp.post('/api/v1/notifications/push/subscribe', { ...sub, endpoint: 'https://internal.example.test/hook' })).statusCode).toBe(400);
    expect((await emp.post('/api/v1/notifications/push/subscribe', sub)).statusCode).toBe(201);
    expect((await emp.post('/api/v1/notifications/push/subscribe', sub)).statusCode).toBe(201);
    expect(await ownerQuery('SELECT 1 FROM push_subscriptions WHERE tenant_id=$1', [T.id])).toHaveLength(1);
  });

  it('the payload holds nothing from the notification, and only the kind reaches the outbox', async () => {
    const secret = 'Salary of Priya Sharma ₹91,234 and PAN ABCDE1234F';
    await inApp(app, () => withTenant(app.deps.pool, T.id, (db) => notifyUsers(db, T.id, [T.users.employee!.id, T.users.other!.id], { kind: 'employee.bank_changed', title: secret, body: secret, link: `/employees/${T.users.employee!.employeeId}` })));
    const outbox = await ownerQuery('SELECT * FROM push_outbox WHERE tenant_id=$1', [T.id]);
    expect(outbox).toHaveLength(1); // the other user has no subscription
    expect(JSON.stringify(outbox)).not.toMatch(/Priya|91,234|ABCDE/);
    await deliverPushOutbox(app.deps.pool, log);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]!.msg)).not.toMatch(/Priya|91,234|ABCDE|employees/);
    expect(sent[0]!.msg.url).toBe('/notifications');
    expect(pushPayload('approval.requested', 'P').body).toBe('A request needs your attention.');
    expect((await ownerQuery<{ status: string }>('SELECT status FROM push_outbox WHERE tenant_id=$1', [T.id]))[0]!.status).toBe('sent');
  });

  it('a subscription the push service says is gone is removed, and a failure is retried', async () => {
    answer = { ok: false, gone: false, error: 'push service answered 500' };
    await inApp(app, () => withTenant(app.deps.pool, T.id, (db) => notifyUsers(db, T.id, [T.users.employee!.id], { kind: 'x.y', title: 't' })));
    await deliverPushOutbox(app.deps.pool, log);
    const [r] = await ownerQuery<{ status: string; last_error: string }>(`SELECT status, last_error FROM push_outbox WHERE tenant_id=$1 AND kind='x.y'`, [T.id]);
    expect(r).toMatchObject({ status: 'queued', last_error: 'push service answered 500' });
    answer = { ok: false, gone: true, error: 'push service answered 410' };
    await ownerQuery(`UPDATE push_outbox SET next_attempt_at=now() WHERE tenant_id=$1`, [T.id]);
    await deliverPushOutbox(app.deps.pool, log);
    expect(await ownerQuery('SELECT 1 FROM push_subscriptions WHERE tenant_id=$1', [T.id])).toHaveLength(0);
  });

  it('feature on without VAPID keys answers feature_not_configured', async () => {
    const a = await makeApp({ ...flags('default,notifications.push') }); // builds its own, null, sender
    const U = await createTenant();
    const c = await Client.login(a, U.host, U.users.employee!.email);
    const r = await c.get('/api/v1/notifications/push/public-key');
    expect([r.statusCode, r.json().error.code]).toEqual([409, 'feature_not_configured']);
    await a.close();
    setPushSender({ publicKey: 'PUB', async send() { return { ok: true }; } });
  });
});
