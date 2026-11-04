import type { Env } from '../../config/env.js';

/**
 * SMS delivery through the organization's provider. In India every transactional SMS must use a sender ID and a
 * template registered on the operator's DLT platform, and the text must match the template; the provider rejects
 * anything else. The HTTP transport is provider-neutral: the deployment supplies the URL, one auth header and the
 * request body with placeholders, so it works with JSON or form APIs (e.g. MSG91, Gupshup, Kaleyra, Twilio).
 */
export interface OutgoingSms { to: string; text: string; templateId: string }
export interface SmsSender { send(m: OutgoingSms): Promise<{ ref: string | null }> }

let sender: SmsSender | null = null;
export function setSmsSender(s: SmsSender | null) { sender = s; }
export const getSmsSender = () => sender;

/** Indian mobile numbers to +91XXXXXXXXXX; other numbers only in full international form. Anything else is refused. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/[\s()-]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s.startsWith('+91') && !/^\+91[6-9]\d{9}$/.test(s) ? null : s;
  const d = s.replace(/^0+/, '');
  if (/^[6-9]\d{9}$/.test(d)) return `+91${d}`;
  if (/^91[6-9]\d{9}$/.test(d)) return `+${d}`;
  return null;
}
export const maskPhone = (p: string) => (p.length > 4 ? `${'•'.repeat(Math.max(0, p.length - 4))}${p.slice(-4)}` : '••••');

/** The registered template with its {#var#} placeholders filled in order (DLT allows up to 30 characters each). */
export function renderSms(template: string, vars: (string | null | undefined)[]) {
  let i = 0;
  return template.replace(/\{#var#\}/gi, () => (vars[i++] ?? '').replace(/\s+/g, ' ').trim().slice(0, 30));
}

export function createSmsSender(env: Env, log: { info: (o: object, m?: string) => void }): SmsSender | null {
  if (env.SMS_TRANSPORT === 'disabled') return null;
  if (env.SMS_TRANSPORT === 'log') {
    // Development only: records that an SMS would be sent, never the number or the text.
    return { async send(m) { log.info({ to: maskPhone(m.to), templateId: m.templateId }, 'sms (log transport, not sent)'); return { ref: null }; } };
  }
  const form = env.SMS_HTTP_CONTENT_TYPE === 'form';
  const [hName, ...hRest] = (env.SMS_HTTP_AUTH_HEADER ?? '').split(':');
  const headers: Record<string, string> = { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' };
  if (hName && hRest.length) headers[hName.trim()] = hRest.join(':').trim();
  const fill = (v: string) => (form ? encodeURIComponent(v) : JSON.stringify(v).slice(1, -1));
  return {
    async send(m) {
      const vars: Record<string, string> = { to: m.to, to_digits: m.to.replace(/^\+/, ''), message: m.text, template_id: m.templateId,
        sender_id: env.SMS_SENDER_ID ?? '', entity_id: env.SMS_DLT_ENTITY_ID ?? '' };
      const body = env.SMS_HTTP_BODY!.replace(/\{\{(\w+)\}\}/g, (_, k: string) => fill(vars[k] ?? ''));
      const res = await fetch(env.SMS_HTTP_URL!, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
      const text = await res.text().catch(() => '');
      if (!res.ok) throw new Error(`SMS provider answered ${res.status}: ${text.slice(0, 200)}`);
      return { ref: text.slice(0, 200) || null };
    },
  };
}
