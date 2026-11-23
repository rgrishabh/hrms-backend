import type { Db } from '../../db/tx.js';
import { notifyUsers } from '../../core/notify/service.js';
import { AUDIENCE_SQL } from './routes.js';

/** Weekly reminder to each employee whose acknowledgement is overdue. Idempotent per week via dedupe keys. */
export async function policyAckReminders(db: Db, tenantId: string, today: string) {
  const rows = (
    await db.query<{ version_id: string; user_id: string; title: string; version_no: number; due_on: string; overdue: number }>(
      `SELECT v.id AS version_id, e.user_id, p.title, v.version_no, d.due_on::text, ($2::date - d.due_on) AS overdue
       FROM policy_versions v JOIN policies p ON p.tenant_id=v.tenant_id AND p.id=v.policy_id JOIN tenants t ON t.id=v.tenant_id
       CROSS JOIN LATERAL (SELECT (v.published_at AT TIME ZONE t.timezone)::date + v.ack_due_days AS due_on) d
       JOIN employees e ON e.tenant_id=v.tenant_id AND e.user_id IS NOT NULL
      WHERE v.tenant_id=$1 AND v.status='published' AND v.requires_ack AND p.status='active' AND d.due_on < $2::date AND ${AUDIENCE_SQL}
        AND NOT EXISTS (SELECT 1 FROM policy_acknowledgements k WHERE k.tenant_id=v.tenant_id AND k.version_id=v.id AND k.employee_id=e.id)`,
      [tenantId, today],
    )
  ).rows;
  let notified = 0;
  for (const r of rows) {
    const res = await notifyUsers(db, tenantId, [r.user_id], {
      kind: 'policies.ack_overdue',
      title: `Overdue: please acknowledge ${r.title} (v${r.version_no})`,
      body: `It was due on ${r.due_on}.`,
      link: `/policies?version=${r.version_id}`,
      actionLabel: 'Read policy',
      dedupeKey: `policy-ack:${r.version_id}:${Math.floor((r.overdue - 1) / 7)}`,
    });
    notified += res.inApp;
  }
  return { overdue: rows.length, notificationsCreated: notified };
}
