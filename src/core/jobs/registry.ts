import type { Db } from '../../db/tx.js';
import { recalculateRange } from '../../modules/attendance/service.js';
import { runAccruals } from '../../modules/leave/jobs.js';
import { leaveYearOf, leaveYearBounds, yearStartMonth } from '../../modules/leave/service.js';
import { addDays } from '../../modules/attendance/time.js';
import { getSettingValue } from '../settings/service.js';
import { notifyUsers, usersWithPermission } from '../notify/service.js';
import { trainingExpiry, authorizationReview } from '../../modules/competency/jobs.js';
import { policyAckReminders } from '../../modules/policies/jobs.js';

/**
 * Background jobs. Schedules are in the organization's timezone (general.timezone).
 * A job runs only when its module is usable. Every job must be idempotent: it may be
 * retried after a failure or re-run manually.
 */
export type Schedule = { kind: 'daily'; at: string } | { kind: 'monthly'; day: number; at: string };

export interface JobContext {
  /** The period being processed: 'YYYY-MM-DD' for daily, 'YYYY-MM' for monthly, or the local date for manual runs. */
  period: string;
  /** Local date (organization timezone) at the time the run started. */
  localDate: string;
  actorId: string | null;
}

export interface JobDefinition {
  key: string;
  name: string;
  description: string;
  schedule: Schedule;
  /** Module that must be usable for the job to run. */
  feature?: string;
  /** Permission needed to trigger a manual run. */
  runPermission: string;
  run(db: Db, tenantId: string, ctx: JobContext): Promise<Record<string, unknown>>;
}

export const JOBS: readonly JobDefinition[] = [
  {
    key: 'attendance.close_day',
    name: 'Close attendance day',
    description: 'Calculates the previous day for every employee, so absences and missing punches appear even without any events. Locked days are skipped.',
    schedule: { kind: 'daily', at: '01:30' },
    feature: 'attendance',
    runPermission: 'attendance.recalculate',
    async run(db, tenantId, ctx) {
      const day = addDays(ctx.period.length === 10 ? ctx.period : ctx.localDate, -1);
      const emps = await db.query<{ id: string }>(`SELECT id FROM employees WHERE tenant_id=$1 AND date_of_joining <= $2
        AND (exit_date IS NULL OR exit_date >= $2) AND status IN ('active','on_notice','exited')`, [tenantId, day]);
      let calculated = 0; let locked = 0;
      for (const e of emps.rows) {
        const r = await recalculateRange(db, tenantId, e.id, day, day);
        calculated += r.results.length; locked += r.skippedLocked.length;
      }
      return { date: day, employees: emps.rowCount, daysCalculated: calculated, lockedSkipped: locked };
    },
  },
  {
    key: 'leave.accrual',
    name: 'Leave accrual',
    description: 'Credits annual entitlements (once per leave year) and monthly accruals up to the current month of the leave year. Never credits twice.',
    schedule: { kind: 'monthly', day: 1, at: '02:00' },
    feature: 'leave',
    runPermission: 'leave.manage',
    async run(db, tenantId, ctx) {
      const startMonth = await yearStartMonth(db, tenantId);
      const year = leaveYearOf(ctx.localDate, startMonth);
      const { start } = leaveYearBounds(year, startMonth);
      const through = (Number(ctx.localDate.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(ctx.localDate.slice(5, 7)) - startMonth + 1;
      return { ...(await runAccruals(db, tenantId, year, Math.min(12, Math.max(1, through)), ctx.actorId)) };
    },
  },
  {
    key: 'approvals.reminder',
    name: 'Approval reminders',
    description: 'Reminds approvers once a day about requests waiting longer than the configured number of days.',
    schedule: { kind: 'daily', at: '09:30' },
    runPermission: 'settings.manage',
    async run(db, tenantId, ctx) {
      const days = await getSettingValue<number>(db, tenantId, 'notifications.approval_reminder_days');
      if (days === 0) return { skipped: 'reminders turned off' };
      const pending = await db.query<{ id: string; summary: string; requester_id: string; approver_kind: string; approver_user_id: string | null; approver_permission: string | null; age_days: number }>(
        `SELECT r.id, r.summary, r.requester_id, s.approver_kind, s.approver_user_id, s.approver_permission, extract(day FROM now() - r.created_at)::int AS age_days
           FROM approval_requests r JOIN approval_steps s ON s.tenant_id=r.tenant_id AND s.request_id=r.id AND s.status='active'
          WHERE r.tenant_id=$1 AND r.status='pending' AND r.created_at < now() - make_interval(days => $2)`, [tenantId, days]);
      let notified = 0;
      for (const p of pending.rows) {
        const users = p.approver_kind === 'user' ? [p.approver_user_id!] : await usersWithPermission(db, tenantId, p.approver_permission!);
        const r = await notifyUsers(db, tenantId, users.filter((u) => u !== p.requester_id), { kind: 'approval.reminder', title: `Waiting ${p.age_days} day(s) for your approval`,
          body: p.summary, link: '/approvals', actionLabel: 'Review', dedupeKey: `reminder:${p.id}:${ctx.localDate}` });
        notified += r.inApp;
      }
      return { pendingOverdue: pending.rowCount, notificationsCreated: notified };
    },
  },
  {
    key: 'documents.expiry',
    name: 'Document expiry reminders',
    description: 'Notifies the employee and document managers 30 days and 7 days before a document expires, and on expiry.',
    schedule: { kind: 'daily', at: '08:00' },
    feature: 'core.documents',
    runPermission: 'documents.manage',
    async run(db, tenantId, ctx) {
      const docs = await db.query<{ id: string; title: string; expires_on: string; employee_id: string | null; user_id: string | null; name: string | null; days: number }>(
        `SELECT d.id, d.title, d.expires_on, d.employee_id, e.user_id, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, (d.expires_on - $2::date) AS days
           FROM documents d LEFT JOIN employees e ON e.tenant_id=d.tenant_id AND e.id=d.employee_id
          WHERE d.tenant_id=$1 AND d.status='active' AND d.expires_on IS NOT NULL AND d.expires_on - $2::date IN (30, 7, 0)`, [tenantId, ctx.localDate]);
      const managers = docs.rowCount ? await usersWithPermission(db, tenantId, 'documents.manage') : [];
      let notified = 0;
      for (const d of docs.rows) {
        const when = d.days === 0 ? 'expires today' : `expires in ${d.days} days`;
        const recipients = [...managers, ...(d.user_id ? [d.user_id] : [])];
        const r = await notifyUsers(db, tenantId, recipients, { kind: 'documents.expiring', title: `${d.title}${d.name ? ` (${d.name})` : ''} ${when}`,
          body: `Expiry date: ${d.expires_on}. Upload a renewed document before it lapses.`, link: d.employee_id ? `/employees/${d.employee_id}?tab=documents` : '/documents',
          actionLabel: 'Open', dedupeKey: `doc-expiry:${d.id}:${d.days}` });
        notified += r.inApp;
      }
      return { documents: docs.rowCount, notificationsCreated: notified };
    },
  },
  {
    key: 'training.expiry',
    name: 'Training expiry reminders',
    description: 'Notifies the employee and training managers 30 and 7 days before a training record expires, and on the day (unless already renewed).',
    schedule: { kind: 'daily', at: '07:30' },
    feature: 'training',
    runPermission: 'training.manage',
    run: (db, tenantId, ctx) => trainingExpiry(db, tenantId, ctx.localDate),
  },
  {
    key: 'competency.review',
    name: 'Technical authorization review',
    description: 'Expires authorizations whose periodic review is overdue and reminds quality and the employee 30 and 7 days before.',
    schedule: { kind: 'daily', at: '07:45' },
    feature: 'lab.competency',
    runPermission: 'competency.authorize',
    run: (db, tenantId, ctx) => authorizationReview(db, tenantId, ctx.localDate),
  },
  {
    key: 'policies.ack_reminder',
    name: 'Policy acknowledgement reminders',
    description: 'Reminds employees once a week while a required policy acknowledgement is overdue.',
    schedule: { kind: 'daily', at: '10:00' },
    feature: 'core.policies',
    runPermission: 'policies.publish',
    run: (db, tenantId, ctx) => policyAckReminders(db, tenantId, ctx.localDate),
  },
  {
    key: 'sessions.cleanup',
    name: 'Session cleanup',
    description: 'Deletes sessions that expired or were revoked more than 7 days ago.',
    schedule: { kind: 'daily', at: '03:00' },
    runPermission: 'security.manage',
    async run(db, tenantId) {
      const r = await db.query(`DELETE FROM sessions WHERE tenant_id=$1 AND (expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days')`, [tenantId]);
      return { deleted: r.rowCount };
    },
  },
];

export const JOB_MAP: ReadonlyMap<string, JobDefinition> = new Map(JOBS.map((j) => [j.key, j]));

/** The period that is due now (or null if the schedule has not been reached yet in the current period). */
export function duePeriod(s: Schedule, localDate: string, localTime: string): string | null {
  if (s.kind === 'daily') return localTime >= s.at ? localDate : null;
  const day = Number(localDate.slice(8, 10));
  if (day > s.day || (day === s.day && localTime >= s.at)) return localDate.slice(0, 7);
  return null;
}

/** Next scheduled start (local date + time) after `localDate localTime`, for display. */
export function nextRun(s: Schedule, localDate: string, localTime: string): string {
  if (s.kind === 'daily') return `${localTime < s.at ? localDate : addDays(localDate, 1)} ${s.at}`;
  const ym = localDate.slice(0, 7);
  const thisMonth = `${ym}-${String(s.day).padStart(2, '0')}`;
  if (localDate < thisMonth || (localDate === thisMonth && localTime < s.at)) return `${thisMonth} ${s.at}`;
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return `${next}-${String(s.day).padStart(2, '0')} ${s.at}`;
}
