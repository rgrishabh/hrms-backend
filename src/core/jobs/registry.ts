import type { Db } from '../../db/tx.js';
import { recalculateRange } from '../../modules/attendance/service.js';
import { runAccruals } from '../../modules/leave/jobs.js';
import { leaveYearOf, leaveYearBounds, yearStartMonth } from '../../modules/leave/service.js';
import { addDays } from '../../modules/attendance/time.js';
import { getSettingValue } from '../settings/service.js';
import { getStore } from '../storage/index.js';
import { notifyUsers, usersWithPermission } from '../notify/service.js';
import { trainingExpiry, authorizationReview } from '../../modules/competency/jobs.js';
import { policyAckReminders } from '../../modules/policies/jobs.js';
import { recruitmentRetention } from '../../modules/recruitment/routes.js';
import { lifecycleDaily } from '../../modules/lifecycle/routes.js';
import { caseDeadlines } from '../../modules/cases/routes.js';
import { assetsDaily } from '../../modules/assets/routes.js';
import { runSchedules } from '../../modules/reports/service.js';
import { escalateOverdue, reassignStranded, stepRecipients, blockedUsers, handlerFeature, offEntityTypes } from '../workflow/engine.js';

/**
 * Background jobs. Schedules are in the organization's timezone (general.timezone).
 * A job runs only when its module is usable, except retention jobs. Every job must be idempotent: it may be
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
  /** Module that must be usable for the job to run; with a list, any one of them. */
  feature?: string | readonly string[];
  /** Erases data at the end of its retention. Runs even while its module is off: data must not outlive its date. */
  retention?: boolean;
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
      const pending = await db.query<{ id: string; entity_type: string; summary: string; approver_kind: string; approver_user_id: string | null; approver_permission: string | null;
        escalated_to: string | null; escalated_permission: string | null; age_days: number }>(
        `SELECT r.id, r.entity_type, r.summary, s.approver_kind, s.approver_user_id, s.approver_permission, s.escalated_to, s.escalated_permission,
                extract(day FROM now() - r.created_at)::int AS age_days
           FROM approval_requests r JOIN approval_steps s ON s.tenant_id=r.tenant_id AND s.request_id=r.id AND s.status='active'
          WHERE r.tenant_id=$1 AND r.status='pending' AND r.created_at < now() - make_interval(days => $2) AND NOT (r.entity_type = ANY($3))`, [tenantId, days, offEntityTypes()]);
      let notified = 0;
      for (const p of pending.rows) {
        const { direct, delegates } = await stepRecipients(db, tenantId, p, ctx.localDate);
        const blocked = await blockedUsers(db, tenantId, p.id);
        const r = await notifyUsers(db, tenantId, [...direct, ...delegates.keys()].filter((u) => !blocked.has(u)), { kind: 'approval.reminder', feature: handlerFeature(p.entity_type), title: `Waiting ${p.age_days} day(s) for your approval`,
          body: p.summary, link: '/approvals', actionLabel: 'Review', dedupeKey: `reminder:${p.id}:${ctx.localDate}` });
        notified += r.inApp;
      }
      return { pendingOverdue: pending.rowCount, notificationsCreated: notified };
    },
  },
  {
    key: 'approvals.escalation',
    name: 'Approval escalation',
    description: "Sends requests that have waited too long for one person to that person's manager (or HR), once per step.",
    schedule: { kind: 'daily', at: '10:00' },
    runPermission: 'settings.manage',
    async run(db, tenantId) {
      const stranded = await reassignStranded(db, tenantId);
      const days = await getSettingValue<number>(db, tenantId, 'approvals.escalate_after_days');
      if (!days) return { skipped: 'escalation turned off', stranded };
      return { ...(await escalateOverdue(db, tenantId, days)), stranded };
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
    key: 'recruitment.retention',
    name: 'Candidate data retention',
    description: 'Anonymizes candidates (and deletes resumes) after the retention period, unless hired or still in an open process.',
    schedule: { kind: 'daily', at: '04:00' },
    feature: 'recruitment',
    retention: true,
    runPermission: 'recruitment.manage',
    run: (db, tenantId, ctx) => recruitmentRetention(db, tenantId, ctx.localDate),
  },
  {
    key: 'attendance.selfie_retention',
    name: 'Check-in selfie retention',
    description: 'Erases check-in selfies at the end of the retention period, and those never used for a clock-in after a day.',
    schedule: { kind: 'daily', at: '04:15' },
    feature: 'attendance.selfie',
    retention: true,
    runPermission: 'attendance.configure',
    async run(db, tenantId) {
      const due = await db.query<{ id: string; storage_key: string }>(`SELECT id, storage_key FROM attendance_selfies WHERE tenant_id=$1 AND erased_at IS NULL AND storage_key IS NOT NULL
        AND (retain_until <= now() OR (event_id IS NULL AND created_at < now() - interval '1 day')) ORDER BY retain_until LIMIT 2000 FOR UPDATE SKIP LOCKED`, [tenantId]);
      if (!due.rowCount) return { erased: 0 };
      const store = getStore();
      if (!store) throw new Error('Selfies are due for erasure but no storage is configured');
      for (const s of due.rows) {
        await store.delete(s.storage_key);
        await db.query(`UPDATE attendance_selfies SET storage_key=NULL, erased_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, s.id]);
      }
      return { erased: due.rowCount };
    },
  },
  {
    key: 'lifecycle.daily',
    name: 'Onboarding, probation and exit',
    feature: ['core.onboarding', 'core.offboarding'],
    description: 'Reminds checklist task owners (due/overdue, weekly), opens probation reviews ahead of the end date, and ends system access after the last working day.',
    schedule: { kind: 'daily', at: '06:30' },
    runPermission: 'lifecycle.manage',
    run: (db, tenantId, ctx) => lifecycleDaily(db, tenantId, ctx.localDate),
  },
  {
    key: 'cases.deadlines',
    name: 'POSH and grievance timelines',
    description: 'Reminds the Internal Committee 7 days before POSH inquiry/report deadlines, on the day and weekly after; reminds handlers of grievances past their response target.',
    schedule: { kind: 'daily', at: '09:00' },
    feature: ['posh', 'grievance'],
    runPermission: 'grievance.manage',
    run: (db, tenantId, ctx) => caseDeadlines(db, tenantId, ctx.localDate),
  },
  {
    key: 'assets.daily',
    name: 'Asset calibration and returns',
    description: 'Reminds asset managers 30 and 7 days before an instrument calibration is due and on the day; reminds employees weekly about assets past their return date.',
    schedule: { kind: 'daily', at: '08:15' },
    feature: 'assets',
    runPermission: 'assets.manage',
    run: (db, tenantId, ctx) => assetsDaily(db, tenantId, ctx.localDate),
  },
  {
    key: 'reports.scheduled',
    name: 'Scheduled reports',
    description: 'Runs saved reports that are due, as their owners, and tells the recipients the report is ready in the app (no report data goes by email). Removes copies older than 90 days.',
    schedule: { kind: 'daily', at: '06:30' },
    feature: 'reports.advanced',
    runPermission: 'settings.manage',
    run: (db, tenantId, ctx) => runSchedules(db, tenantId, ctx.localDate),
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

/** Whether a job may run, given which modules are usable. */
export function jobActive(job: JobDefinition, isUsable: (key: string) => boolean) {
  if (!job.feature || job.retention) return true;
  return (typeof job.feature === 'string' ? [job.feature] : job.feature).some(isUsable);
}

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
