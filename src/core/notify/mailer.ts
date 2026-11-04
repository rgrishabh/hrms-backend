import nodemailer from 'nodemailer';
import type { Env } from '../../config/env.js';

export interface OutgoingMail { from: string; to: string; subject: string; text: string; html: string }
export interface Mailer { send(m: OutgoingMail): Promise<void> }

let mailer: Mailer | null = null;
let fromHeader = '';
/** Process-wide mail transport (one installation per process). Tests inject their own. */
export function setMailer(m: Mailer | null, from = fromHeader) { mailer = m; fromHeader = from; }
export const getMailer = () => mailer;
export const getFrom = () => fromHeader;

/** Null unless SMTP_HOST is set and FEATURE_EMAIL_NOTIFICATIONS is on. Mail comes from BRAND_EMAIL_FROM, in the product's name. */
export function createMailer(env: Env): Mailer | null {
  fromHeader = `"${env.BRAND_PRODUCT_NAME.replace(/["\r\n]/g, '')}" <${env.BRAND_EMAIL_FROM}>`;
  if (!env.SMTP_HOST || !env.enabledFeatures.has('notifications.email')) return null;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST, port: env.SMTP_PORT, ...smtpSecurity(env.SMTP_SECURE),
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
  });
  return { async send(m) { await transport.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text, html: m.html }); } };
}

/** tls: encrypted from the first byte. starttls: upgraded, or refused. none: plain, never upgraded (Mailpit; refused in production). */
export function smtpSecurity(mode: Env['SMTP_SECURE']) {
  if (mode === 'tls') return { secure: true };
  if (mode === 'starttls') return { secure: false, requireTLS: true };
  return { secure: false, ignoreTLS: true };
}
