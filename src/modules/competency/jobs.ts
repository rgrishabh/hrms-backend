import type { Db } from '../../db/tx.js';
import { usersWithPermission, notifyUsers } from '../../core/notify/service.js';
import { addEvent, describe, loadAuthorization, notifyEmployee } from './service.js';

/** Reminders 30 and 7 days before a training record expires, and on the day. Idempotent via dedupe keys. */
export async function trainingExpiry(db: Db, tenantId: string, today: string) {
  const rows = (
    await db.query<{ id: string; course: string; expires_on: string; user_id: string | null; name: string; days: number }>(
      `SELECT t.id, c.code||' '||c.name AS course, t.expires_on::text, e.user_id, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, (t.expires_on - $2::date) AS days
       FROM training_records t JOIN training_courses c ON c.tenant_id=t.tenant_id AND c.id=t.course_id JOIN employees e ON e.tenant_id=t.tenant_id AND e.id=t.employee_id
      WHERE t.tenant_id=$1 AND t.status='active' AND t.result<>'failed' AND e.status IN ('active','on_notice') AND t.expires_on - $2::date IN (30, 7, 0)
        -- a newer valid record for the same course means it has been renewed
        AND NOT EXISTS (SELECT 1 FROM training_records n WHERE n.tenant_id=t.tenant_id AND n.employee_id=t.employee_id AND n.course_id=t.course_id
              AND n.status='active' AND n.result<>'failed' AND n.id<>t.id AND (n.expires_on IS NULL OR n.expires_on > t.expires_on))`,
      [tenantId, today],
    )
  ).rows;
  const managers = rows.length ? await usersWithPermission(db, tenantId, 'training.manage') : [];
  let notified = 0;
  for (const r of rows) {
    const when = r.days === 0 ? 'expires today' : `expires in ${r.days} days`;
    const res = await notifyUsers(db, tenantId, [...managers, ...(r.user_id ? [r.user_id] : [])], {
      kind: 'training.expiring',
      title: `Training ${r.course} for ${r.name} ${when}`,
      body: `Expiry date ${r.expires_on}. Technical authorizations that require this training stop being in force once it lapses.`,
      link: '/competency',
      actionLabel: 'Open',
      dedupeKey: `training-expiry:${r.id}:${r.days}`,
    });
    notified += res.inApp;
  }
  return { expiring: rows.length, notificationsCreated: notified };
}

/** Authorizations past their periodic review become 'expired'; quality is reminded 30 days ahead. */
export async function authorizationReview(db: Db, tenantId: string, today: string) {
  const quality = await usersWithPermission(db, tenantId, 'competency.authorize');
  const expired = (
    await db.query<{ id: string }>(
      `UPDATE lab_authorizations SET status='expired', ended_at=now(), end_reason='Periodic review overdue'
      WHERE tenant_id=$1 AND status IN ('authorized','suspended') AND review_due < $2::date RETURNING id`,
      [tenantId, today],
    )
  ).rows;
  for (const { id } of expired) {
    await addEvent(db, tenantId, id, 'expired', null, 'Periodic review overdue');
    const a = (await loadAuthorization(db, tenantId, id))!;
    await notifyEmployee(
      db,
      tenantId,
      a,
      `Your authorization expired: ${describe(a)}`,
      `The periodic review was due on ${a.review_due}. A new assessment and authorization are needed.`,
      `auth-expired:${id}`,
    );
    await notifyUsers(db, tenantId, quality, {
      kind: 'competency.expired',
      title: `Authorization expired: ${a.employee_name}`,
      body: describe(a),
      link: '/competency',
      dedupeKey: `auth-expired-q:${id}`,
    });
  }
  const due = (
    await db.query<{ id: string }>(`SELECT id FROM lab_authorizations WHERE tenant_id=$1 AND status='authorized' AND review_due - $2::date IN (30, 7)`, [tenantId, today])
  ).rows;
  for (const { id } of due) {
    const a = (await loadAuthorization(db, tenantId, id))!;
    await notifyUsers(
      db,
      tenantId,
      quality.filter((u) => u !== a.employee_user_id),
      {
        kind: 'competency.review_due',
        title: `Authorization review due ${a.review_due}: ${a.employee_name}`,
        body: describe(a),
        link: '/competency',
        actionLabel: 'Review',
        dedupeKey: `auth-review:${id}:${a.review_due}:${today}`,
      },
    );
    await notifyEmployee(db, tenantId, a, `Your authorization review is due on ${a.review_due}`, describe(a), `auth-review-e:${id}:${a.review_due}:${today}`);
  }
  return { expired: expired.length, reviewReminders: due.length };
}
