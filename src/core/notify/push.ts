import { createCipheriv, createECDH, createPrivateKey, createSign, hkdfSync, randomBytes, type ECDH } from 'node:crypto';
import type { Env } from '../../config/env.js';

/**
 * Web push: message encryption per RFC 8291 (aes128gcm, RFC 8188) and sender identification per RFC 8292 (VAPID),
 * on node:crypto alone. Nothing here sees a notification's text: pushPayload builds the only thing ever sent.
 */
export interface PushSubscription { endpoint: string; p256dh: string; auth: string }
export interface PushMessage { title: string; body: string; url: string }
export type PushResult = { ok: true } | { ok: false; gone: boolean; error: string };
export interface PushSender { publicKey: string; send(sub: PushSubscription, message: PushMessage): Promise<PushResult> }

let sender: PushSender | null = null;
/** Process-wide, like the mailer. Tests inject their own. */
export const setPushSender = (s: PushSender | null) => { sender = s; };
export const getPushSender = () => sender;

const b64u = (b: Buffer) => b.toString('base64url');
const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer | string, len: number) => Buffer.from(hkdfSync('sha256', ikm, salt, info, len));

/** The hosts of the browsers' push services. Endpoints are client-supplied URLs the server will call, so this is an SSRF control. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/, /^[a-z0-9.-]+\.notify\.windows\.com$/];

export function isAllowedEndpoint(endpoint: string): boolean {
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  return PUSH_HOSTS.some((h) => h.test(u.hostname));
}

/** RFC 8291 section 3.4: one record, with the sender's ephemeral public key as the key id. `eph` and `salt` are for the RFC's test vector. */
export function encryptPayload(plaintext: Buffer, p256dh: string, authSecret: string, testing?: { eph: ECDH; salt: Buffer }): Buffer {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const eph = testing?.eph ?? createECDH('prime256v1');
  if (!testing) eph.generateKeys();
  const asPublic = eph.getPublicKey();
  const shared = eph.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(shared, Buffer.from(authSecret, 'base64url'), keyInfo, 32);
  const salt = testing?.salt ?? randomBytes(16);
  const cek = hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** RFC 8292: an ES256 token for the push service's origin. */
export function vapidHeader(endpoint: string, publicKey: string, privateKey: string, subject: string, now = Date.now()): string {
  const pub = Buffer.from(publicKey, 'base64url');
  const key = createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
  const part = (o: object) => b64u(Buffer.from(JSON.stringify(o)));
  const input = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const sig = createSign('SHA256').update(input).sign({ key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u(sig)}, k=${publicKey}`;
}

/** Null when VAPID keys are not configured: the feature then answers feature_not_configured. */
export function createPushSender(env: Pick<Env, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT' | 'BRAND_SUPPORT_EMAIL'>): PushSender | null {
  const { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv } = env;
  if (!pub || !priv) return null;
  const subject = env.VAPID_SUBJECT ?? `mailto:${env.BRAND_SUPPORT_EMAIL}`;
  return {
    publicKey: pub,
    async send(sub, message) {
      if (!isAllowedEndpoint(sub.endpoint)) return { ok: false, gone: true, error: 'endpoint is not a known push service' };
      const res = await fetch(sub.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'normal', authorization: vapidHeader(sub.endpoint, pub, priv, subject) },
        body: new Uint8Array(encryptPayload(Buffer.from(JSON.stringify(message)), sub.p256dh, sub.auth)),
      });
      if (res.ok) return { ok: true };
      return { ok: false, gone: res.status === 404 || res.status === 410, error: `push service answered ${res.status}` };
    },
  };
}

/**
 * What a push may say. Built from the kind of event alone, never from its title or body, so that no name, amount or other
 * L3/L4 data can reach a push service or a lock screen. The app shows the rest after sign-in.
 */
export function pushPayload(kind: string, productName: string): PushMessage {
  return { title: productName, body: kind.startsWith('approval.') ? 'A request needs your attention.' : 'You have a new notification.', url: '/notifications' };
}
