import type { Pool } from '../../db/pool.js';
import { withPlatformBypass, type Db } from '../../db/tx.js';
import { SYSTEM_ROLES } from '../auth/permissions.js';
import { isModuleEnabled } from '../features/state.js';
import { getFrom, getMailer } from './mailer.js';
import { renderEmail, type EmailBrand } from './templates.js';
import { getSmsSender, normalizePhone, renderSms } from './sms.js';

/**
 * Notifications are written in the CALLER's transaction (outbox pattern): if the
 * business change rolls back, no notification exists. In-app notifications are
 * always created; an email is queued only when the `notifications.email` module is
 * enabled, a transport is configured, and the user has not opted out.
 */
let brand: EmailBrand = { brandName: 'HRMS', productName: 'HRMS', primaryColor: '#1f5f8b', supportEmail: null, appUrl: 'http://localhost' };
export function setEmailBrand(b: EmailBrand) { brand = b; }

export interface NotifyMessage {
  kind: string;
  title: string;
  body?: string | null;
  /** In-app relative link, e.g. /approvals */
  link?: string | null;
  actionLabel?: string;
  /** Same key + same user = one notification (e.g. daily reminders). */
  dedupeKey?: string;
  email?: boolean;
  /** SMS is sent only for kinds the organization has a DLT template for. */
  sms?: boolean;
}

export async function notifyUsers(db: Db, tenantId: string, userIds: string[], msg: NotifyMessage) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return { inApp: 0, emails: 0 };
  const inApp = await db.query(`INSERT INTO notifications (tenant_id, user_id, kind, title, body, link, dedupe_key)
    SELECT $1, u.id, $3, $4, $5, $6, $7 FROM users u WHERE u.tenant_id=$1 AND u.id = ANY($2) AND u.status='active'
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [tenantId, ids, msg.kind, msg.title.slice(0, 200), msg.body?.slice(0, 1000) ?? null, msg.link ?? null, msg.dedupeKey ?? null]);
  let emails = 0;
  if (msg.email !== false && getMailer() && isModuleEnabled('notifications.email')) {
    const rendered = renderEmail(brand, msg);
    const r = await db.query(`INSERT INTO email_outbox (tenant_id, to_user_id, to_email, subject, text_body, html_body, kind, dedupe_key)
      SELECT $1, u.id, u.email, $3, $4, $5, $6, $7 FROM users u
       WHERE u.tenant_id=$1 AND u.id = ANY($2) AND u.status='active' AND u.email_notifications
      ON CONFLICT (tenant_id, to_email, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [tenantId, ids, rendered.subject, rendered.text, rendered.html, msg.kind, msg.dedupeKey ?? null]);
    emails = r.rowCount ?? 0;
  }
  let sms = 0;
  if (msg.sms !== false && getSmsSender() && isModuleEnabled('notifications.sms')) {
    const t = (await db.query<{ dlt_template_id: string; text: string }>(`SELECT dlt_template_id, text FROM sms_templates WHERE tenant_id=$1 AND kind=$2 AND enabled`, [tenantId, msg.kind])).rows[0];
    if (t) {
      // Users who have not opted out and have a mobile number on their employee record.
      const r = await db.query(`INSERT INTO sms_outbox (tenant_id, to_user_id, to_phone, kind, dlt_template_id, text, dedupe_key)
        SELECT $1, u.id, e.phone, $3, $4, $5, $6 FROM users u JOIN employees e ON e.tenant_id=u.tenant_id AND e.user_id=u.id
         WHERE u.tenant_id=$1 AND u.id = ANY($2) AND u.status='active' AND u.sms_notifications AND coalesce(e.phone,'') <> ''
        ON CONFLICT (tenant_id, to_user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
        [tenantId, ids, msg.kind, t.dlt_template_id, renderSms(t.text, [msg.title, msg.body]), msg.dedupeKey ?? null]);
      sms = r.rowCount ?? 0;
    }
  }
  return { inApp: inApp.rowCount ?? 0, emails, sms };
}

/** Active users holding a permission through system or custom roles. */
export async function usersWithPermission(db: Db, tenantId: string, permission: string): Promise<string[]> {
  const systemRoles = SYSTEM_ROLES.filter((r) => (r.permissions as readonly string[]).includes(permission)).map((r) => r.key);
  const r = await db.query<{ id: string }>(`SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id AND ur.tenant_id=u.tenant_id
    LEFT JOIN tenant_roles tr ON tr.tenant_id=ur.tenant_id AND tr.key=ur.role_key
    WHERE u.tenant_id=$1 AND u.status='active' AND (ur.role_key = ANY($2) OR $3 = ANY(tr.permissions))`, [tenantId, systemRoles, permission]);
  return r.rows.map((x) => x.id);
}

const MAX_EMAIL_ATTEMPTS = 5;

/**
 * Deliver queued emails (called by the scheduler every tick, on every instance).
 * Rows are claimed with SKIP LOCKED so instances never send the same email twice.
 * Failures back off exponentially (2^attempts minutes) and stop after 5 attempts.
 */
export async function deliverOutbox(pool: Pool, log: { error: (o: object, m?: string) => void }, limit = 50) {
  const mailer = getMailer();
  if (!mailer) return { sent: 0, failed: 0 };
  const claimed = await withPlatformBypass(pool, async (db) => {
    await db.query(`UPDATE email_outbox SET status='queued' WHERE status='sending' AND next_attempt_at < now() - interval '10 minutes'`);
    return (await db.query<{ id: string; tenant_id: string; to_email: string; subject: string; text_body: string; html_body: string; attempts: number }>(
      `UPDATE email_outbox SET status='sending', attempts=attempts+1, next_attempt_at=now()
        WHERE id IN (SELECT id FROM email_outbox WHERE status='queued' AND next_attempt_at <= now() ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, tenant_id, to_email, subject, text_body, html_body, attempts`, [limit])).rows;
  });
  let sent = 0; let failed = 0;
  for (const m of claimed) {
    try {
      await mailer.send({ from: getFrom(), to: m.to_email, subject: m.subject, text: m.text_body, html: m.html_body });
      await withPlatformBypass(pool, (db) => db.query(`UPDATE email_outbox SET status='sent', sent_at=now(), last_error=NULL WHERE id=$1`, [m.id]));
      sent++;
    } catch (e) {
      failed++;
      const err = ((e as Error).message ?? 'send failed').slice(0, 500);
      log.error({ outboxId: m.id, attempts: m.attempts, err }, 'email delivery failed');
      await withPlatformBypass(pool, (db) => db.query(`UPDATE email_outbox SET last_error=$2,
          status = CASE WHEN attempts >= ${MAX_EMAIL_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
          next_attempt_at = now() + make_interval(mins => power(2, attempts)::int) WHERE id=$1`, [m.id, err]));
    }
  }
  return { sent, failed };
}

const MAX_SMS_ATTEMPTS = 5;

/** Deliver queued SMS like email: claimed with SKIP LOCKED, exponential back-off, at most 5 attempts. Invalid numbers fail at once. */
export async function deliverSmsOutbox(pool: Pool, log: { error: (o: object, m?: string) => void }, limit = 50) {
  const s = getSmsSender();
  if (!s) return { sent: 0, failed: 0 };
  const claimed = await withPlatformBypass(pool, async (db) => {
    await db.query(`UPDATE sms_outbox SET status='queued' WHERE status='sending' AND next_attempt_at < now() - interval '10 minutes'`);
    return (await db.query<{ id: string; to_phone: string; text: string; dlt_template_id: string; attempts: number }>(
      `UPDATE sms_outbox SET status='sending', attempts=attempts+1, next_attempt_at=now()
        WHERE id IN (SELECT id FROM sms_outbox WHERE status='queued' AND next_attempt_at <= now() ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, to_phone, text, dlt_template_id, attempts`, [limit])).rows;
  });
  let sent = 0; let failed = 0;
  for (const m of claimed) {
    const to = normalizePhone(m.to_phone);
    if (!to) {
      await withPlatformBypass(pool, (db) => db.query(`UPDATE sms_outbox SET status='failed', last_error='Not a valid mobile number' WHERE id=$1`, [m.id]));
      failed++; continue;
    }
    try {
      const r = await s.send({ to, text: m.text, templateId: m.dlt_template_id });
      await withPlatformBypass(pool, (db) => db.query(`UPDATE sms_outbox SET status='sent', sent_at=now(), last_error=NULL, provider_ref=$2 WHERE id=$1`, [m.id, r.ref]));
      sent++;
    } catch (e) {
      const final = m.attempts >= MAX_SMS_ATTEMPTS;
      await withPlatformBypass(pool, (db) => db.query(`UPDATE sms_outbox SET status=$2, last_error=$3, next_attempt_at=now() + make_interval(mins => $4) WHERE id=$1`,
        [m.id, final ? 'failed' : 'queued', (e as Error).message.slice(0, 500), 2 ** m.attempts]));
      log.error({ smsId: m.id, attempt: m.attempts, err: (e as Error).message }, 'sms delivery failed');
      failed++;
    }
  }
  return { sent, failed };
}
