import type { Pool } from '../../db/pool.js';
import { withPlatformBypass, type Db } from '../../db/tx.js';
import { SYSTEM_ROLES } from '../auth/permissions.js';
import { isModuleEnabled } from '../features/state.js';
import { getFrom, getMailer } from './mailer.js';
import { renderEmail, type EmailBrand } from './templates.js';
import { getPushSender, pushPayload } from './push.js';

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
  push?: boolean;
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
  if (msg.push !== false && getPushSender() && isModuleEnabled('notifications.push')) {
    // Only the kind is kept: the outbox holds nothing a push could leak.
    await db.query(`INSERT INTO push_outbox (tenant_id, to_user_id, kind, dedupe_key)
      SELECT $1, u.id, $3, $4 FROM users u WHERE u.tenant_id=$1 AND u.id = ANY($2) AND u.status='active'
        AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.tenant_id=u.tenant_id AND p.user_id=u.id)
      ON CONFLICT (tenant_id, to_user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`, [tenantId, ids, msg.kind, msg.dedupeKey ?? null]);
  }
  return { inApp: inApp.rowCount ?? 0, emails };
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

const MAX_PUSH_ATTEMPTS = 5;

/** Deliver queued pushes like email: claimed with SKIP LOCKED, back-off, at most 5 attempts. Dead subscriptions are removed. */
export async function deliverPushOutbox(pool: Pool, log: { error: (o: object, m?: string) => void }, limit = 50) {
  const push = getPushSender();
  if (!push) return { sent: 0, failed: 0 };
  const claimed = await withPlatformBypass(pool, async (db) => {
    await db.query(`DELETE FROM push_outbox WHERE status IN ('sent','failed') AND created_at < now() - interval '30 days'`);
    await db.query(`UPDATE push_outbox SET status='queued' WHERE status='sending' AND next_attempt_at < now() - interval '10 minutes'`);
    return (await db.query<{ id: string; tenant_id: string; to_user_id: string; kind: string; attempts: number }>(
      `UPDATE push_outbox SET status='sending', attempts=attempts+1, next_attempt_at=now()
        WHERE id IN (SELECT id FROM push_outbox WHERE status='queued' AND next_attempt_at <= now() ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, tenant_id, to_user_id, kind, attempts`, [limit])).rows;
  });
  let sent = 0; let failed = 0;
  for (const m of claimed) {
    const subs = await withPlatformBypass(pool, async (db) => (await db.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE tenant_id=$1 AND user_id=$2', [m.tenant_id, m.to_user_id])).rows);
    const payload = pushPayload(m.kind, brand.productName);
    let lastError: string | null = null;
    for (const sub of subs) {
      try {
        const r = await push.send(sub, payload);
        if (r.ok) await withPlatformBypass(pool, (db) => db.query('UPDATE push_subscriptions SET last_used_at=now() WHERE id=$1', [sub.id]));
        else if (r.gone) await withPlatformBypass(pool, (db) => db.query('DELETE FROM push_subscriptions WHERE id=$1', [sub.id]));
        else lastError = r.error;
      } catch (e) { lastError = ((e as Error).message ?? 'send failed').slice(0, 500); }
    }
    if (lastError) {
      failed++;
      log.error({ pushId: m.id, attempts: m.attempts, err: lastError }, 'push delivery failed');
      await withPlatformBypass(pool, (db) => db.query(`UPDATE push_outbox SET last_error=$2, status = CASE WHEN attempts >= ${MAX_PUSH_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
        next_attempt_at = now() + make_interval(mins => power(2, attempts)::int) WHERE id=$1`, [m.id, lastError]));
    } else {
      sent++;
      await withPlatformBypass(pool, (db) => db.query(`UPDATE push_outbox SET status='sent', sent_at=now(), last_error=NULL WHERE id=$1`, [m.id]));
    }
  }
  return { sent, failed };
}
