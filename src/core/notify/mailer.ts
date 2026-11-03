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

export function createMailer(env: Env, log: { info: (o: object, m?: string) => void }): Mailer | null {
  const fromName = (env.MAIL_FROM_NAME ?? env.BRAND_NAME ?? env.ORGANIZATION_NAME).replace(/["\r\n]/g, '');
  fromHeader = env.MAIL_FROM_ADDRESS ? `"${fromName}" <${env.MAIL_FROM_ADDRESS}>` : `"${fromName}" <no-reply@localhost>`;
  if (env.MAIL_TRANSPORT === 'disabled') return null;
  if (env.MAIL_TRANSPORT === 'log') {
    // Development only: records that an email would be sent, never the body.
    return { async send(m) { log.info({ to: m.to, subject: m.subject }, 'email (log transport, not sent)'); } };
  }
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE, requireTLS: !env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
  });
  return { async send(m) { await transport.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text, html: m.html }); } };
}
