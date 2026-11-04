import type { Db } from '../../db/tx.js';
import { localDate } from '../attendance/time.js';
import { notifyUsers } from '../../core/notify/service.js';

export const ACTIVITIES = ['sampling', 'perform', 'review', 'authorize_report'] as const;
export type Activity = (typeof ACTIVITIES)[number];
export const ACTIVITY_LABEL: Record<Activity, string> = { sampling: 'Sampling', perform: 'Perform test', review: 'Review results', authorize_report: 'Authorize reports' };

export async function orgToday(db: Db, tenantId: string): Promise<string> {
  const tz = (await db.query<{ timezone: string }>('SELECT timezone FROM tenants WHERE id=$1', [tenantId])).rows[0]!.timezone;
  return localDate(new Date(), tz);
}

/** Required courses for a method that the employee does not hold a valid (passed/completed, active, unexpired) record for on `date`. */
export async function missingPrerequisites(db: Db, tenantId: string, employeeId: string, methodId: string, date: string) {
  return (await db.query<{ id: string; code: string; name: string; lapsed_on: string | null }>(
    `SELECT c.id, c.code, c.name,
            (SELECT max(t.expires_on)::text FROM training_records t WHERE t.tenant_id=r.tenant_id AND t.employee_id=$3 AND t.course_id=r.course_id
               AND t.status='active' AND t.result IN ('completed','passed')) AS lapsed_on
       FROM lab_method_requirements r JOIN training_courses c ON c.tenant_id=r.tenant_id AND c.id=r.course_id
      WHERE r.tenant_id=$1 AND r.method_id=$2
        AND NOT EXISTS (SELECT 1 FROM training_records t WHERE t.tenant_id=r.tenant_id AND t.employee_id=$3 AND t.course_id=r.course_id
              AND t.status='active' AND t.result IN ('completed','passed') AND t.completed_on <= $4::date AND (t.expires_on IS NULL OR t.expires_on >= $4::date))
      ORDER BY c.code`, [tenantId, methodId, employeeId, date])).rows;
}

export async function addEvent(db: Db, tenantId: string, authorizationId: string, action: string, actorId: string | null, reason?: string | null) {
  await db.query('INSERT INTO lab_authorization_events (tenant_id, authorization_id, action, actor_id, reason) VALUES ($1,$2,$3,$4,$5)',
    [tenantId, authorizationId, action, actorId, reason ?? null]);
}

export interface AuthorizationRow {
  id: string; employee_id: string; method_id: string; activity: Activity; status: string; review_due: string | null; valid_from: string | null;
  requested_by: string; employee_user_id: string | null; employee_name: string; method_code: string; method_name: string; review_months: number;
}
export async function loadAuthorization(db: Db, tenantId: string, id: string, lock = false): Promise<AuthorizationRow | undefined> {
  return (await db.query<AuthorizationRow>(
    `SELECT a.id, a.employee_id, a.method_id, a.activity, a.status, a.review_due::text, a.valid_from::text, a.requested_by,
            e.user_id AS employee_user_id, trim(e.first_name||' '||coalesce(e.last_name,'')) AS employee_name, m.code AS method_code, m.name AS method_name, m.review_months
       FROM lab_authorizations a JOIN employees e ON e.tenant_id=a.tenant_id AND e.id=a.employee_id JOIN lab_methods m ON m.tenant_id=a.tenant_id AND m.id=a.method_id
      WHERE a.tenant_id=$1 AND a.id=$2${lock ? ' FOR UPDATE OF a' : ''}`, [tenantId, id])).rows[0];
}

export const describe = (a: Pick<AuthorizationRow, 'activity' | 'method_code' | 'method_name'>) => `${ACTIVITY_LABEL[a.activity]} — ${a.method_code} ${a.method_name}`;

export async function notifyEmployee(db: Db, tenantId: string, a: AuthorizationRow, title: string, body: string, dedupeKey?: string) {
  if (a.employee_user_id) await notifyUsers(db, tenantId, [a.employee_user_id], { kind: 'competency.authorization', title, body, link: '/competency', actionLabel: 'View', dedupeKey });
}

/**
 * Is the employee authorized for this method and activity right now?
 * In force = status 'authorized', review not overdue, every required training valid today.
 */
export async function checkAuthorization(db: Db, tenantId: string, employeeId: string, methodId: string, activity: Activity) {
  const today = await orgToday(db, tenantId);
  const a = (await db.query<{ id: string; status: string; valid_from: string; review_due: string }>(
    `SELECT id, status, valid_from::text, review_due::text FROM lab_authorizations WHERE tenant_id=$1 AND employee_id=$2 AND method_id=$3 AND activity=$4
       AND status IN ('authorized','suspended')`, [tenantId, employeeId, methodId, activity])).rows[0];
  const reasons: string[] = [];
  const emp = (await db.query<{ status: string; exit_date: string | null }>('SELECT status, exit_date::text FROM employees WHERE tenant_id=$1 AND id=$2', [tenantId, employeeId])).rows[0];
  if (!emp || ['exited', 'inactive'].includes(emp.status) || (emp.exit_date && emp.exit_date < today)) reasons.push('Employee is no longer employed');
  if (!a) reasons.push('No technical authorization for this method and activity');
  else {
    if (a.status === 'suspended') reasons.push('Authorization is suspended');
    if (a.review_due < today) reasons.push(`Periodic review was due on ${a.review_due}`);
    if (a.valid_from > today) reasons.push(`Authorization starts on ${a.valid_from}`);
  }
  for (const m of await missingPrerequisites(db, tenantId, employeeId, methodId, today))
    reasons.push(m.lapsed_on ? `Required training ${m.code} lapsed on ${m.lapsed_on}` : `Required training ${m.code} not completed`);
  return { authorized: reasons.length === 0, date: today, authorizationId: a?.id ?? null, status: a?.status ?? null, reviewDue: a?.review_due ?? null, reasons };
}
