import type { FastifyInstance } from 'fastify';
import { Decimal } from 'decimal.js';
import { tenantActor, type TenantActor } from '../../core/http/context.js';
import { evaluateFeatures } from '../../core/features/state.js';
import type { Db } from '../../db/tx.js';
import { orgToday } from '../competency/service.js';
import { teamEmployeeIds } from '../attendance/service.js';
import { leaveYearOf, yearStartMonth } from '../leave/service.js';
import { money } from '../../core/brand.js';

/**
 * Dashboard summary: one call returning the tiles and short lists the signed-in user may see.
 * Every block is gated by the same permission + feature checks as the screen it links to, so
 * the dashboard never reveals a number the user could not already look up.
 */
export type Tone = 'neutral' | 'good' | 'warn' | 'bad';
export interface Tile { key: string; label: string; value: number | string; detail?: string; href?: string; tone?: Tone }
export interface Section { key: 'me' | 'team' | 'org' | 'today' | 'attention'; title: string; tiles: Tile[] }
export interface ListItem { primary: string; secondary?: string; date?: string }
export interface ListBlock { key: string; title: string; items: ListItem[]; href?: string; more?: number }

const NAME = `trim(e.first_name||' '||coalesce(e.last_name,''))`;
const ACTIVE = `e.status IN ('active','on_notice')`;
const LIST_MAX = 8;

interface Ctx { db: Db; a: TenantActor; tenantId: string; today: string; usable: (f: string) => boolean }

/** Today's attendance for a set of employees (null = everyone): expected, clocked in, on leave, on field duty, not yet in, late. */
async function attendanceToday(c: Ctx, ids: string[] | null) {
  const r = (await c.db.query<{ expected: number; clocked_in: number; on_leave: number; on_duty: number; late: number; off_today: number }>(`
    WITH emp AS (SELECT e.id FROM employees e WHERE e.tenant_id=$1 AND ${ACTIVE} AND e.date_of_joining <= $2 AND ($3::uuid[] IS NULL OR e.id = ANY($3))),
    lv AS (SELECT DISTINCT r.employee_id FROM leave_requests r JOIN emp ON emp.id=r.employee_id
      WHERE r.tenant_id=$1 AND r.status='approved' AND r.start_date <= $2 AND r.end_date >= $2),
    fd AS (SELECT DISTINCT f.employee_id FROM field_duty_requests f JOIN emp ON emp.id=f.employee_id
      WHERE f.tenant_id=$1 AND f.status='approved' AND f.start_date <= $2 AND f.end_date >= $2
        AND NOT EXISTS (SELECT 1 FROM lv WHERE lv.employee_id=f.employee_id))
    SELECT (SELECT count(*) FROM emp)::int AS expected,
      count(*) FILTER (WHERE d.first_in IS NOT NULL AND lv.employee_id IS NULL)::int AS clocked_in,
      (SELECT count(*) FROM lv)::int AS on_leave,
      count(*) FILTER (WHERE fd.employee_id IS NOT NULL AND d.first_in IS NULL)::int AS on_duty,
      count(*) FILTER (WHERE d.late_minutes > 0)::int AS late,
      count(*) FILTER (WHERE d.day_type <> 'working' AND d.first_in IS NULL AND lv.employee_id IS NULL AND fd.employee_id IS NULL)::int AS off_today
    FROM emp LEFT JOIN attendance_daily d ON d.tenant_id=$1 AND d.employee_id=emp.id AND d.work_date=$2
    LEFT JOIN lv ON lv.employee_id=emp.id LEFT JOIN fd ON fd.employee_id=emp.id`, [c.tenantId, c.today, ids])).rows[0]!;
  // Away on field duty without punching in is accounted for, not "not in yet".
  return { ...r, not_in: Math.max(0, r.expected - r.clocked_in - r.on_leave - r.on_duty - r.off_today) };
}

async function missingPunches(c: Ctx, ids: string[] | null) {
  return (await c.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM attendance_daily d JOIN employees e ON e.tenant_id=d.tenant_id AND e.id=d.employee_id
    WHERE d.tenant_id=$1 AND d.status='missing_punch' AND d.work_date BETWEEN $2::date - 7 AND $2::date - 1 AND ${ACTIVE}
      AND ($3::uuid[] IS NULL OR e.id = ANY($3))`, [c.tenantId, c.today, ids])).rows[0]!.n;
}

async function onLeaveToday(c: Ctx, ids: string[] | null): Promise<ListBlock> {
  const rows = (await c.db.query<{ name: string; type: string; end_date: string; total: number }>(`SELECT ${NAME} AS name, t.name AS type, r.end_date::text, count(*) OVER ()::int AS total
    FROM leave_requests r JOIN employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id JOIN leave_types t ON t.tenant_id=r.tenant_id AND t.id=r.leave_type_id
    WHERE r.tenant_id=$1 AND r.status='approved' AND r.start_date <= $2 AND r.end_date >= $2 AND ${ACTIVE} AND ($3::uuid[] IS NULL OR e.id = ANY($3))
    ORDER BY name LIMIT ${LIST_MAX}`, [c.tenantId, c.today, ids])).rows;
  const total = rows[0]?.total ?? 0;
  return { key: 'on_leave_today', title: 'On leave today', href: '/leave', more: Math.max(0, total - rows.length),
    items: rows.map((r) => ({ primary: r.name, secondary: r.type, ...(r.end_date > c.today ? { date: r.end_date } : {}) })) };
}

function attendanceTiles(prefix: string, t: Awaited<ReturnType<typeof attendanceToday>>, href: string): Tile[] {
  const sfx = prefix === 'team' ? ' today' : '';  // the organization's tiles sit under an "Attendance today" heading
  return [
    { key: `${prefix}_in`, label: `Clocked in${sfx}`, value: t.clocked_in, detail: `of ${t.expected}`, href, tone: 'neutral' },
    { key: `${prefix}_leave`, label: `On leave${sfx}`, value: t.on_leave, href: '/leave' },
    { key: `${prefix}_duty`, label: `On field duty${sfx}`, value: t.on_duty, href: '/field-duty' },
    { key: `${prefix}_not_in`, label: 'Not clocked in yet', value: t.not_in, href, tone: t.not_in ? 'warn' : 'good' },
    { key: `${prefix}_late`, label: `Late${sfx}`, value: t.late, href, tone: t.late ? 'warn' : 'neutral' },
  ];
}

async function mySection(c: Ctx): Promise<Section | null> {
  const emp = c.a.user.employeeId;
  if (!emp) return null;
  const tiles: Tile[] = [];
  if (c.a.has('leave.self') && c.usable('leave')) {
    const year = leaveYearOf(c.today, (await yearStartMonth(c.db, c.tenantId)) ?? 1);
    const rows = (await c.db.query<{ code: string; name: string; balance: string; pending: string }>(`SELECT t.code, t.name,
        coalesce((SELECT sum(days) FROM leave_ledger l WHERE l.tenant_id=t.tenant_id AND l.employee_id=$2 AND l.leave_type_id=t.id AND l.leave_year=$3),0)::text AS balance,
        coalesce((SELECT sum(days) FROM leave_requests r WHERE r.tenant_id=t.tenant_id AND r.employee_id=$2 AND r.leave_type_id=t.id AND r.leave_year=$3 AND r.status='pending'),0)::text AS pending
      FROM leave_types t JOIN employees e ON e.tenant_id=t.tenant_id AND e.id=$2
      WHERE t.tenant_id=$1 AND t.status='active' AND t.requires_balance
        AND (cardinality(t.applicable_employment_types)=0 OR e.employment_type = ANY(t.applicable_employment_types)) ORDER BY t.code LIMIT 4`, [c.tenantId, emp, year])).rows;
    for (const r of rows) {
      const avail = new Decimal(r.balance).minus(r.pending);
      tiles.push({ key: `leave_${r.code}`, label: `${r.name} available`, value: avail.toNumber(), detail: new Decimal(r.pending).gt(0) ? `${new Decimal(r.pending).toNumber()} pending` : 'days', href: '/leave' });
    }
  }
  if (c.a.has('competency.self') && c.usable('training')) {
    const r = (await c.db.query<{ expired: number; due: number }>(`WITH latest AS (SELECT DISTINCT ON (t.course_id) t.course_id, t.expires_on FROM training_records t
        JOIN training_courses co ON co.tenant_id=t.tenant_id AND co.id=t.course_id AND co.status='active'
        WHERE t.tenant_id=$1 AND t.employee_id=$2 AND t.status='active' AND t.result IN ('passed','completed') ORDER BY t.course_id, t.completed_on DESC, t.created_at DESC)
      SELECT count(*) FILTER (WHERE expires_on < $3)::int AS expired, count(*) FILTER (WHERE expires_on BETWEEN $3 AND $3::date + 60)::int AS due FROM latest`, [c.tenantId, emp, c.today])).rows[0]!;
    if (r.expired || r.due) tiles.push({ key: 'my_training', label: r.expired ? 'Your training has expired' : 'Your training is due for renewal', value: r.expired + r.due,
      detail: r.expired ? `${r.expired} expired` : 'within 60 days', href: '/competency', tone: r.expired ? 'bad' : 'warn' });
  }
  return tiles.length ? { key: 'me', title: 'You', tiles } : null;
}

export async function dashboardSummary(db: Db, a: TenantActor) {
  const tenantId = a.tenantId;
  const features = await evaluateFeatures(db, tenantId);
  const usable = (f: string) => !!features.get(f)?.usable;
  const today = await orgToday(db, tenantId);
  const c: Ctx = { db, a, tenantId, today, usable };
  const sections: Section[] = [];
  const lists: ListBlock[] = [];
  const attention: Tile[] = [];

  const me = await mySection(c);
  if (me) sections.push(me);

  // ---- team (managers without organization-wide access)
  const teamAtt = usable('attendance') && a.has('attendance.team.read') && !a.has('attendance.read');
  const teamLeave = usable('leave') && a.has('leave.team.read') && !a.has('leave.read');
  const fieldDuty = usable('field_duty') && a.has('field_duty.team.read');
  const team = a.user.employeeId && (teamAtt || teamLeave) ? await teamEmployeeIds(db, tenantId, a.user.employeeId) : [];
  if (team.length) {
    const size = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM employees e WHERE e.tenant_id=$1 AND e.id = ANY($2) AND ${ACTIVE}`, [tenantId, team])).rows[0]!.n;
    const tiles: Tile[] = [{ key: 'team_size', label: 'People in your team', value: size, href: '/attendance/team' }];
    if (teamAtt) {
      const t = await attendanceToday(c, team);
      tiles.push(...attendanceTiles('team', t, '/attendance/team').filter((x) => (teamLeave || x.key !== 'team_leave') && (fieldDuty || x.key !== 'team_duty')));
      const mp = await missingPunches(c, team);
      if (mp) attention.push({ key: 'team_missing_punch', label: 'Missing punches in your team', value: mp, detail: 'last 7 days', href: '/attendance/team', tone: 'warn' });
    }
    sections.push({ key: 'team', title: 'Your team', tiles });
    if (teamLeave) lists.push(await onLeaveToday(c, team));
  }

  // ---- organization
  const org: Tile[] = [];
  const todayTiles: Tile[] = [];
  if (a.has('employees.read')) {
    const monthStart = today.slice(0, 8) + '01';
    const r = (await db.query<{ headcount: number; joined: number; left: number; pre_joining: number }>(`SELECT
        count(*) FILTER (WHERE ${ACTIVE} AND date_of_joining <= $2)::int AS headcount,
        count(*) FILTER (WHERE status <> 'pre_joining' AND date_of_joining BETWEEN $3 AND $2)::int AS joined,
        count(*) FILTER (WHERE exit_date BETWEEN $3 AND $2)::int AS left,
        count(*) FILTER (WHERE status='pre_joining')::int AS pre_joining
      FROM employees e WHERE tenant_id=$1`, [tenantId, today, monthStart])).rows[0]!;
    const jl = `/reports?r=joiners_leavers&from=${monthStart}&to=${today}`;
    org.push({ key: 'headcount', label: 'Headcount', value: r.headcount, href: '/reports?r=headcount' },
      { key: 'joined', label: 'Joined this month', value: r.joined, href: `${jl}&event=joined`, tone: r.joined ? 'good' : 'neutral' },
      { key: 'left', label: 'Left this month', value: r.left, href: `${jl}&event=left` });
    if (r.pre_joining) org.push({ key: 'pre_joining', label: 'Joining soon', value: r.pre_joining, href: '/employees' });
  }
  if (usable('attendance') && a.has('attendance.read')) {
    const t = await attendanceToday(c, null);
    todayTiles.push(...attendanceTiles('org', t, '/attendance/team').filter((x) => ((a.has('leave.read') && usable('leave')) || x.key !== 'org_leave')
      && ((usable('field_duty') && a.has('field_duty.read')) || x.key !== 'org_duty')));
    const mp = await missingPunches(c, null);
    if (mp) attention.push({ key: 'missing_punch', label: 'Missing punches', value: mp, detail: 'last 7 days', href: '/attendance/team', tone: 'warn' });
  }
  if (usable('payroll') && a.has('payroll.read')) {
    // Latest period; with several legal entities, show the run that is furthest behind.
    const ORDER = ['draft', 'computed', 'pending', 'approved', 'finalized', 'paid'];
    const row = (await db.query<{ period: string; statuses: string[] }>(`SELECT period, array_agg(status) AS statuses FROM payroll_runs
      WHERE tenant_id=$1 AND status <> 'cancelled' GROUP BY period ORDER BY period DESC LIMIT 1`, [tenantId])).rows[0];
    const r = row && { period: row.period, runs: row.statuses.length, status: ORDER[Math.min(...row.statuses.map((x) => ORDER.indexOf(x)))]! };
    const label: Record<string, string> = { draft: 'Draft', computed: 'Computed', pending: 'Awaiting approval', approved: 'Approved', finalized: 'Finalized', paid: 'Paid' };
    if (r) {
      const [y, m] = r.period.split('-');
      const month = new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
      const done = ['finalized', 'paid'].includes(r.status);
      org.push({ key: 'payroll', label: `Payroll · ${month}`, value: label[r.status] ?? r.status, detail: r.runs > 1 ? `${r.runs} runs` : undefined, href: '/payroll', tone: done ? 'good' : 'warn' });
    }
  }
  if (org.length) sections.push({ key: 'org', title: 'Organization', tiles: org });
  if (todayTiles.length) sections.push({ key: 'today', title: 'Attendance today', tiles: todayTiles });
  if (usable('leave') && a.has('leave.read')) lists.push(await onLeaveToday(c, null));

  // ---- things that need someone to act
  if (usable('core.onboarding')) {
    const hr = a.has('lifecycle.manage');
    const r = (await db.query<{ n: number; overdue: number }>(`SELECT count(*)::int AS n, count(*) FILTER (WHERE r.probation_end < $3)::int AS overdue
      FROM probation_reviews r JOIN employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id LEFT JOIN employees m ON m.tenant_id=e.tenant_id AND m.id=e.reporting_manager_id
      WHERE r.tenant_id=$1 AND r.status='open' AND ${ACTIVE} AND ($2 OR m.user_id=$4)`, [tenantId, hr, today, a.user.userId])).rows[0]!;
    if (r.n) attention.push({ key: 'probation', label: hr ? 'Probation reviews open' : 'Probation reviews to complete', value: r.n,
      detail: r.overdue ? `${r.overdue} past the end date` : undefined, href: '/lifecycle?tab=probation', tone: r.overdue ? 'bad' : 'warn' });
  }
  if (usable('expenses') && a.has('expenses.pay')) {
    const r = (await db.query<{ n: number; amount: string }>(`SELECT count(*)::int AS n, coalesce(sum(total),0)::text AS amount FROM expense_claims
      WHERE tenant_id=$1 AND status='approved' AND batch_id IS NULL`, [tenantId])).rows[0]!;
    if (r.n) attention.push({ key: 'expenses_to_pay', label: 'Approved claims to reimburse', value: r.n, detail: `₹${new Decimal(r.amount).toNumber().toLocaleString('en-IN', { maximumFractionDigits: 2 })}`, href: '/expenses?tab=finance', tone: 'warn' });
  }
  if (usable('recruitment') && a.has('recruitment.read')) {
    const r = (await db.query<{ open: number; openings: number; active: number }>(`SELECT
        (SELECT count(*) FROM job_requisitions WHERE tenant_id=$1 AND status='approved')::int AS open,
        (SELECT coalesce(sum(greatest(positions - filled, 0)),0) FROM job_requisitions WHERE tenant_id=$1 AND status='approved')::int AS openings,
        (SELECT count(*) FROM job_applications WHERE tenant_id=$1 AND stage NOT IN ('hired','rejected','withdrawn'))::int AS active`, [tenantId])).rows[0]!;
    if (r.open) attention.push({ key: 'open_positions', label: 'Open positions', value: r.openings, detail: `${r.open} requisition${r.open === 1 ? '' : 's'} · ${r.active} candidates in process`, href: '/recruitment?tab=requisitions' });
  }
  if (usable('training') && (a.has('competency.read') || a.has('training.manage'))) {
    const r = (await db.query<{ expired: number; due: number }>(`WITH latest AS (SELECT DISTINCT ON (t.employee_id, t.course_id) t.employee_id, t.expires_on FROM training_records t
        JOIN training_courses co ON co.tenant_id=t.tenant_id AND co.id=t.course_id AND co.status='active'
        WHERE t.tenant_id=$1 AND t.status='active' AND t.result IN ('passed','completed') ORDER BY t.employee_id, t.course_id, t.completed_on DESC, t.created_at DESC)
      SELECT count(*) FILTER (WHERE l.expires_on < $2)::int AS expired, count(*) FILTER (WHERE l.expires_on BETWEEN $2 AND $2::date + 30)::int AS due
      FROM latest l JOIN employees e ON e.tenant_id=$1 AND e.id=l.employee_id WHERE ${ACTIVE}`, [tenantId, today])).rows[0]!;
    if (r.expired || r.due) attention.push({ key: 'training_expiry', label: 'Training expired or due', value: r.expired + r.due,
      detail: `${r.expired} expired · ${r.due} due in 30 days`, href: '/reports?r=training_expiry&withinDays=30', tone: r.expired ? 'bad' : 'warn' });
  }
  if (usable('lab.competency') && a.has('competency.read')) {
    const r = (await db.query<{ overdue: number; due: number }>(`SELECT count(*) FILTER (WHERE a.review_due < $2)::int AS overdue,
        count(*) FILTER (WHERE a.review_due BETWEEN $2 AND $2::date + 30)::int AS due
      FROM lab_authorizations a JOIN employees e ON e.tenant_id=a.tenant_id AND e.id=a.employee_id
      WHERE a.tenant_id=$1 AND a.status IN ('authorized','suspended') AND a.review_due IS NOT NULL AND ${ACTIVE}`, [tenantId, today])).rows[0]!;
    if (r.overdue || r.due) attention.push({ key: 'authorization_reviews', label: 'Authorization reviews due', value: r.overdue + r.due,
      detail: `${r.overdue} overdue · ${r.due} in 30 days`, href: '/reports?r=authorization_reviews&withinDays=30', tone: r.overdue ? 'bad' : 'warn' });
  }
  if (usable('core.documents') && a.has('documents.read')) {
    const r = (await db.query<{ expired: number; due: number }>(`SELECT count(*) FILTER (WHERE d.expires_on < $2)::int AS expired,
        count(*) FILTER (WHERE d.expires_on BETWEEN $2 AND $2::date + 30)::int AS due
      FROM documents d JOIN document_categories c ON c.tenant_id=d.tenant_id AND c.id=d.category_id
      LEFT JOIN employees e ON e.tenant_id=d.tenant_id AND e.id=d.employee_id
      WHERE d.tenant_id=$1 AND d.status='active' AND d.expires_on IS NOT NULL AND d.expires_on <= $2::date + 30
        AND ($3 OR NOT c.restricted) AND (d.employee_id IS NULL OR ${ACTIVE})`, [tenantId, today, a.has('documents.restricted')])).rows[0]!;
    if (r.expired || r.due) attention.push({ key: 'documents_expiry', label: 'Documents expired or expiring', value: r.expired + r.due,
      detail: `${r.expired} expired · ${r.due} in 30 days`, href: '/documents', tone: r.expired ? 'bad' : 'warn' });
  }
  if (usable('grievance') && a.has('grievance.manage')) {
    const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM cases WHERE tenant_id=$1 AND kind='grievance' AND status IN ('open','in_progress','reopened')`, [tenantId])).rows[0]!.n;
    if (n) attention.push({ key: 'grievances', label: 'Open grievances', value: n, href: '/cases', tone: 'warn' });
  }
  if (attention.length) sections.push({ key: 'attention', title: 'Needs attention', tiles: attention });

  // ---- upcoming holidays (the employee's branch plus organization-wide ones)
  if (usable('holidays')) {
    const rows = (await db.query<{ holiday_date: string; name: string; optional: boolean; branch: string | null }>(`SELECT h.holiday_date::text, h.name, h.optional, b.name AS branch
      FROM holidays h LEFT JOIN branches b ON b.tenant_id=h.tenant_id AND b.id=h.branch_id
      WHERE h.tenant_id=$1 AND h.holiday_date >= $2 AND h.holiday_date <= $2::date + 120
        AND (h.branch_id IS NULL OR $3::uuid IS NULL OR h.branch_id = (SELECT branch_id FROM employees WHERE tenant_id=$1 AND id=$3))
      ORDER BY h.holiday_date, h.name LIMIT 4`, [tenantId, today, a.user.employeeId ?? null])).rows;
    if (rows.length) lists.push({ key: 'holidays', title: 'Upcoming holidays', items: rows.map((h) => ({ primary: h.name, date: h.holiday_date,
      secondary: [h.optional ? 'Optional' : null, !a.user.employeeId && h.branch ? h.branch : null].filter(Boolean).join(' · ') || undefined })) });
  }
  return { today, sections, lists };
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    const a = tenantActor(req);
    return a.tx((db) => dashboardSummary(db, a));
  });
}

