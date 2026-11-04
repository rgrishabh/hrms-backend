/**
 * Report catalogue. Each report declares who may run it (org-wide permissions, and optionally
 * team permissions that limit it to the caller's reporting chain), the module it needs, its
 * parameters (the UI renders the form from these) and its query. Reports are read-only.
 * Grouping uses only fixed SQL expressions chosen from an enum — never user text.
 */
import { z } from 'zod';
import type { Db } from '../../db/tx.js';
import { IsoDate } from '../../core/http/pagination.js';
import { addDays, daysBetween } from '../attendance/time.js';
import { leaveYearOf, yearStartMonth } from '../leave/service.js';

export type ColType = 'text' | 'int' | 'number' | 'percent' | 'money' | 'date';
export interface Column { key: string; label: string; type: ColType }
export type Row = Record<string, unknown>;
type Opt = { value: string; label: string };
interface DefaultCtx { db: Db; tenantId: string; today: string }
export interface ParamDef {
  key: string; label: string; type: 'date' | 'month' | 'select' | 'int';
  options?: Opt[]; min?: number; max?: number;
  default: (c: DefaultCtx) => string | number | Promise<string | number>;
}
export type Params = Record<string, string | number>;
export interface ReportCtx { db: Db; tenantId: string; today: string; /** null = whole organization */ team: string[] | null; has: (p: string) => boolean;
  /** Whether a module is usable (cross-module reports leave out the parts that are not). */ usable: (f: string) => boolean }
export interface ReportResult { columns: Column[]; rows: Row[]; totals: Row | null; notes: string[] }
export interface ReportDef {
  key: string; name: string; description: string;
  category: 'People' | 'Time & leave' | 'Pay & expenses' | 'Training & competency' | 'Across modules';
  feature?: string;
  access: { all: string[]; team?: string[] };
  params: ParamDef[];
  check?: (p: Params) => string | null;
  run: (c: ReportCtx, p: Params) => Promise<ReportResult>;
}

export const MAX_ROWS = 5000;

// ---------------------------------------------------------------- helpers
const monthOf = (d: string) => d.slice(0, 7);
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
export function addMonths(ym: string, n: number) {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
const dateRange = (maxDays: number) => (p: Params) =>
  String(p.from) > String(p.to) ? '"From" must be on or before "To"'
    : daysBetween(String(p.from), String(p.to)) + 1 > maxDays ? `Choose a period of at most ${maxDays} days` : null;
const monthRange = (maxMonths: number) => (p: Params) => {
  const [a, b] = [String(p.from), String(p.to)];
  if (a > b) return '"From" must be on or before "To"';
  const n = (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7)) + 1;
  return n > maxMonths ? `Choose at most ${maxMonths} months` : null;
};

const EMP_NAME = `trim(e.first_name||' '||coalesce(e.last_name,''))`;
const EMP_JOINS = `LEFT JOIN departments d ON d.tenant_id=e.tenant_id AND d.id=e.department_id
  JOIN branches b ON b.tenant_id=e.tenant_id AND b.id=e.branch_id
  JOIN legal_entities le ON le.tenant_id=e.tenant_id AND le.id=e.legal_entity_id`;
const DEPT = `coalesce(d.name,'(No department)')`;
const scoped = (n: number) => `($${n}::uuid[] IS NULL OR e.id = ANY($${n}::uuid[]))`;
/** Employed on date D (inclusive of the joining date and the last working day). */
const onDate = (d: string) => `e.status <> 'pre_joining' AND e.date_of_joining <= ${d}::date AND (e.exit_date IS NULL OR e.exit_date >= ${d}::date)
  AND NOT (e.status IN ('exited','inactive') AND e.exit_date IS NULL)`;

export const EMPLOYMENT_TYPE: Record<string, string> = { permanent: 'Permanent', probation: 'Probation', contract: 'Contract', trainee: 'Trainee', intern: 'Intern', consultant: 'Consultant' };
const SEPARATION: Record<string, string> = { resignation: 'Resignation', termination: 'Termination', retirement: 'Retirement', contract_end: 'Contract end', death: 'Death', absconding: 'Absconding', mutual: 'Mutual separation' };
const ACTIVITY: Record<string, string> = { sampling: 'Sampling', perform: 'Perform tests', review: 'Review results', authorize_report: 'Authorize reports' };

const PEOPLE_GROUPS: Record<string, [string, string]> = {
  department: ['Department', DEPT], branch: ['Branch', 'b.name'], legal_entity: ['Legal entity', 'le.name'],
  employment_type: ['Employment type', 'e.employment_type'],
  grade: ['Grade', `coalesce(nullif(e.grade,''),'(No grade)')`], designation: ['Designation', `coalesce(nullif(e.designation,''),'(No designation)')`],
};
const peopleGroupParam: ParamDef = { key: 'groupBy', label: 'Group by', type: 'select', default: () => 'department',
  options: Object.entries(PEOPLE_GROUPS).map(([value, [label]]) => ({ value, label })) };
const fromDate = (def: (today: string) => string): ParamDef => ({ key: 'from', label: 'From', type: 'date', default: (c) => def(c.today) });
const toDate: ParamDef = { key: 'to', label: 'To', type: 'date', default: (c) => c.today };

const num = (v: unknown) => (v == null ? null : Number(v));
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
/** Numbers arrive from pg as strings for numeric/bigint: convert per column type, and split off the GROUPING SETS total row. */
function shape(columns: Column[], raw: Row[]): { rows: Row[]; totals: Row | null } {
  const numeric = columns.filter((c) => c.type !== 'text' && c.type !== 'date').map((c) => c.key);
  let totals: Row | null = null; const rows: Row[] = [];
  for (const r of raw) {
    const o: Row = { ...r };
    for (const k of numeric) if (k in o) o[k] = num(o[k]);
    const isTotal = o.is_total === 1 || o.is_total === true; delete o.is_total;
    if (isTotal) totals = o; else rows.push(o);
  }
  return { rows, totals };
}
function sumRows(columns: Column[], rows: Row[]): Row {
  const t: Row = {};
  for (const c of columns) if (c.type === 'int' || c.type === 'number' || c.type === 'money') t[c.key] = Math.round(rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0) * 100) / 100;
  return t;
}

// ---------------------------------------------------------------- reports
const headcount: ReportDef = {
  key: 'headcount', name: 'Headcount', category: 'People',
  description: 'Employees on a date, by department, branch, legal entity, type, grade or designation, with average tenure.',
  access: { all: ['employees.read'] },
  params: [{ key: 'asOf', label: 'On date', type: 'date', default: (c) => c.today }, peopleGroupParam],
  async run(c, p) {
    const [label, g] = PEOPLE_GROUPS[String(p.groupBy)]!;
    const columns: Column[] = [{ key: 'grp', label, type: 'text' }, { key: 'headcount', label: 'Headcount', type: 'int' },
      { key: 'permanent', label: 'Permanent', type: 'int' }, { key: 'probation', label: 'Probation', type: 'int' },
      { key: 'contract', label: 'Contract / consultant', type: 'int' }, { key: 'trainee', label: 'Trainee / intern', type: 'int' },
      { key: 'tenure', label: 'Average tenure (years)', type: 'number' }];
    const raw = (await c.db.query(`SELECT ${g} AS grp, grouping(${g}) AS is_total, count(*)::int AS headcount,
        count(*) FILTER (WHERE e.employment_type='permanent')::int AS permanent, count(*) FILTER (WHERE e.employment_type='probation')::int AS probation,
        count(*) FILTER (WHERE e.employment_type IN ('contract','consultant'))::int AS contract, count(*) FILTER (WHERE e.employment_type IN ('trainee','intern'))::int AS trainee,
        round(avg(($2::date - e.date_of_joining) / 365.25), 1) AS tenure
      FROM employees e ${EMP_JOINS} WHERE e.tenant_id=$1 AND ${onDate('$2')}
      GROUP BY GROUPING SETS ((${g}), ()) ORDER BY is_total, headcount DESC, grp`, [c.tenantId, p.asOf])).rows;
    const { rows, totals } = shape(columns, raw);
    if (p.groupBy === 'employment_type') for (const r of rows) r.grp = EMPLOYMENT_TYPE[String(r.grp)] ?? r.grp;
    return { columns, rows, totals, notes: ['Grouped by each person’s current department, branch, type, grade and designation.'] };
  },
};

const attrition: ReportDef = {
  key: 'attrition', name: 'Attrition', category: 'People',
  description: 'Opening and closing headcount, joiners, leavers and attrition rate for a period.',
  access: { all: ['employees.read'] },
  params: [fromDate((t) => `${addMonths(monthOf(t), -11)}-01`), toDate, peopleGroupParam],
  check: dateRange(3660),
  async run(c, p) {
    const [label, g] = PEOPLE_GROUPS[String(p.groupBy)]!;
    const columns: Column[] = [{ key: 'grp', label, type: 'text' }, { key: 'opening', label: 'Opening', type: 'int' }, { key: 'joiners', label: 'Joiners', type: 'int' },
      { key: 'leavers', label: 'Leavers', type: 'int' }, { key: 'voluntary', label: 'Resigned', type: 'int' }, { key: 'closing', label: 'Closing', type: 'int' },
      { key: 'attrition', label: 'Attrition %', type: 'percent' }, { key: 'annualized', label: 'Annualized %', type: 'percent' }];
    const raw = (await c.db.query(`SELECT ${g} AS grp, grouping(${g}) AS is_total,
        count(*) FILTER (WHERE e.date_of_joining < $2::date AND (e.exit_date IS NULL OR e.exit_date >= $2::date))::int AS opening,
        count(*) FILTER (WHERE e.date_of_joining BETWEEN $2 AND $3)::int AS joiners,
        count(*) FILTER (WHERE e.exit_date BETWEEN $2 AND $3)::int AS leavers,
        count(*) FILTER (WHERE e.exit_date BETWEEN $2 AND $3 AND EXISTS (SELECT 1 FROM separations s WHERE s.tenant_id=e.tenant_id AND s.employee_id=e.id
          AND s.kind='resignation' AND s.status IN ('approved','completed')))::int AS voluntary,
        count(*) FILTER (WHERE e.date_of_joining <= $3::date AND (e.exit_date IS NULL OR e.exit_date > $3::date))::int AS closing
      FROM employees e ${EMP_JOINS}
      WHERE e.tenant_id=$1 AND e.status <> 'pre_joining' AND NOT (e.status IN ('exited','inactive') AND e.exit_date IS NULL)
        AND e.date_of_joining <= $3::date AND (e.exit_date IS NULL OR e.exit_date >= $2::date)
      GROUP BY GROUPING SETS ((${g}), ()) ORDER BY is_total, grp`, [c.tenantId, p.from, p.to])).rows;
    const { rows, totals } = shape(columns, raw);
    const days = daysBetween(String(p.from), String(p.to)) + 1;
    for (const r of [...rows, ...(totals ? [totals] : [])]) {
      const avg = ((r.opening as number) + (r.closing as number)) / 2;
      r.attrition = pct(r.leavers as number, avg);
      r.annualized = r.attrition == null ? null : Math.round((r.attrition as number) * (365 / days) * 10) / 10;
      if (p.groupBy === 'employment_type' && r !== totals) r.grp = EMPLOYMENT_TYPE[String(r.grp)] ?? r.grp;
    }
    return { columns, rows, totals, notes: ['Attrition % = leavers ÷ average of opening and closing headcount. Opening counts people employed at the start of the first day; closing, those still employed after the last day.'] };
  },
};

const joinersLeavers: ReportDef = {
  key: 'joiners_leavers', name: 'Joiners and leavers', category: 'People',
  description: 'Everyone who joined or left in a period, with department, branch and (for HR) the type of separation.',
  access: { all: ['employees.read'] },
  params: [fromDate((t) => monthStart(addDays(monthStart(t), -1))), toDate,
    { key: 'event', label: 'Show', type: 'select', default: () => 'all', options: [{ value: 'all', label: 'Joiners and leavers' }, { value: 'joined', label: 'Joiners' }, { value: 'left', label: 'Leavers' }] }],
  check: dateRange(3660),
  async run(c, p) {
    const showKind = c.has('lifecycle.read');
    const columns: Column[] = [{ key: 'date', label: 'Date', type: 'date' }, { key: 'event', label: 'Event', type: 'text' }, { key: 'employee_code', label: 'Code', type: 'text' },
      { key: 'name', label: 'Name', type: 'text' }, { key: 'department', label: 'Department', type: 'text' }, { key: 'branch', label: 'Branch', type: 'text' },
      { key: 'designation', label: 'Designation', type: 'text' }, { key: 'employment_type', label: 'Type', type: 'text' },
      ...(showKind ? [{ key: 'separation', label: 'Separation', type: 'text' as const }] : [])];
    const sel = `e.employee_code, ${EMP_NAME} AS name, d.name AS department, b.name AS branch, e.designation, e.employment_type`;
    const raw = (await c.db.query(`SELECT * FROM (
        SELECT e.date_of_joining::text AS date, 'Joined' AS event, ${sel}, NULL::text AS separation FROM employees e ${EMP_JOINS}
          WHERE e.tenant_id=$1 AND e.status <> 'pre_joining' AND e.date_of_joining BETWEEN $2 AND $3 AND $4::text <> 'left'
        UNION ALL
        SELECT e.exit_date::text, 'Left', ${sel}, s.kind FROM employees e ${EMP_JOINS}
          LEFT JOIN LATERAL (SELECT kind FROM separations s WHERE s.tenant_id=e.tenant_id AND s.employee_id=e.id AND s.status IN ('approved','completed') ORDER BY s.created_at DESC LIMIT 1) s ON true
          WHERE e.tenant_id=$1 AND e.exit_date BETWEEN $2 AND $3 AND $4::text <> 'joined'
      ) x ORDER BY date, event, employee_code LIMIT ${MAX_ROWS + 1}`, [c.tenantId, p.from, p.to, p.event])).rows;
    const rows = raw.map((r) => {
      const o: Row = { ...r, employment_type: EMPLOYMENT_TYPE[String(r.employment_type)] ?? r.employment_type, separation: r.separation ? SEPARATION[String(r.separation)] ?? r.separation : null };
      if (!showKind) delete o.separation;
      return o;
    });
    return { columns, rows, totals: null, notes: [] };
  },
};

const ATT_METRICS = `count(*) FILTER (WHERE ad.day_type='working' AND ad.status <> 'not_joined')::int AS working,
  count(*) FILTER (WHERE ad.status='present')::int AS present, count(*) FILTER (WHERE ad.status='half_day')::int AS half_day,
  count(*) FILTER (WHERE ad.status='on_leave')::int AS on_leave, count(*) FILTER (WHERE ad.status='on_duty')::int AS on_duty, count(*) FILTER (WHERE ad.status='absent')::int AS absent,
  count(*) FILTER (WHERE ad.status='missing_punch')::int AS missing_punch, count(*) FILTER (WHERE ad.late_minutes > 0)::int AS late_days,
  round(sum(ad.worked_minutes) / 60.0, 1) AS worked_hours, round(sum(ad.overtime_minutes) / 60.0, 1) AS overtime_hours`;
const attendance: ReportDef = {
  key: 'attendance_summary', name: 'Attendance summary', category: 'Time & leave', feature: 'attendance',
  description: 'Working days, present, half days, leave, field duty, absences, missing punches, late days, hours and overtime per employee or department.',
  access: { all: ['attendance.read'], team: ['attendance.team.read'] },
  params: [fromDate(monthStart), toDate,
    { key: 'groupBy', label: 'Group by', type: 'select', default: () => 'employee', options: [{ value: 'employee', label: 'Employee' }, { value: 'department', label: 'Department' }] }],
  check: dateRange(366),
  async run(c, p) {
    const byEmp = p.groupBy === 'employee';
    const head: Column[] = byEmp
      ? [{ key: 'employee_code', label: 'Code', type: 'text' }, { key: 'name', label: 'Name', type: 'text' }, { key: 'department', label: 'Department', type: 'text' }]
      : [{ key: 'department', label: 'Department', type: 'text' }, { key: 'employees', label: 'Employees', type: 'int' }];
    const columns: Column[] = [...head, { key: 'working', label: 'Working days', type: 'int' }, { key: 'present', label: 'Present', type: 'int' },
      { key: 'half_day', label: 'Half days', type: 'int' }, { key: 'on_leave', label: 'On leave', type: 'int' }, { key: 'on_duty', label: 'Field duty', type: 'int' }, { key: 'absent', label: 'Absent', type: 'int' },
      { key: 'missing_punch', label: 'Missing punch', type: 'int' }, { key: 'late_days', label: 'Late days', type: 'int' },
      { key: 'worked_hours', label: 'Hours worked', type: 'number' }, { key: 'overtime_hours', label: 'Overtime hours', type: 'number' },
      { key: 'attendance_pct', label: 'Attendance %', type: 'percent' }];
    const sets = byEmp ? `(e.id, e.employee_code, e.first_name, e.last_name, d.name)` : `(${DEPT})`;
    const raw = (await c.db.query(`SELECT ${byEmp ? `e.employee_code, ${EMP_NAME} AS name, ${DEPT} AS department, grouping(e.id) AS is_total`
        : `${DEPT} AS department, grouping(${DEPT}) AS is_total`}, count(DISTINCT e.id)::int AS employees, ${ATT_METRICS}
      FROM attendance_daily ad JOIN employees e ON e.tenant_id=ad.tenant_id AND e.id=ad.employee_id ${EMP_JOINS}
      WHERE ad.tenant_id=$1 AND ad.work_date BETWEEN $2 AND $3 AND ${scoped(4)}
      GROUP BY GROUPING SETS (${sets}, ()) ORDER BY is_total, ${byEmp ? 'e.employee_code' : 'department'} LIMIT ${MAX_ROWS + 2}`, [c.tenantId, p.from, p.to, c.team])).rows;
    const { rows, totals } = shape([...columns, { key: 'employees', label: '', type: 'int' }], raw);
    for (const r of [...rows, ...(totals ? [totals] : [])]) {
      r.attendance_pct = pct((r.present as number) + (r.on_duty as number) + (r.half_day as number) / 2, (r.working as number) - (r.on_leave as number));
      if (byEmp) delete r.employees;
    }
    if (totals && byEmp) { totals.employee_code = null; totals.name = null; totals.department = null; }
    return { columns, rows, totals, notes: ['Attendance % = (present + field duty + ½ half days) ÷ (working days − leave days). From calculated attendance; recalculate first if punches changed.'] };
  },
};

/** Approved leave overlapping the period; requests that cross the boundary are prorated by calendar days. */
const LEAVE_IN_RANGE = `SELECT r.id, r.employee_id, r.leave_type_id,
    r.days * (least(r.end_date, $3::date) - greatest(r.start_date, $2::date) + 1)::numeric / (r.end_date - r.start_date + 1) AS days
  FROM leave_requests r JOIN employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id
  WHERE r.tenant_id=$1 AND r.status='approved' AND r.start_date <= $3::date AND r.end_date >= $2::date AND ${scoped(4)}`;
const leaveTaken: ReportDef = {
  key: 'leave_taken', name: 'Leave taken', category: 'Time & leave', feature: 'leave',
  description: 'Approved leave days in a period by leave type, per employee, department or leave type.',
  access: { all: ['leave.read'], team: ['leave.team.read'] },
  params: [fromDate(monthStart), toDate,
    { key: 'groupBy', label: 'Group by', type: 'select', default: () => 'employee', options: [{ value: 'employee', label: 'Employee' }, { value: 'department', label: 'Department' }, { value: 'leave_type', label: 'Leave type' }] }],
  check: dateRange(731),
  async run(c, p) {
    const args = [c.tenantId, p.from, p.to, c.team];
    const notes = ['Leave that crosses the start or end of the period is counted in proportion to the days inside it.'];
    if (p.groupBy === 'leave_type') {
      const columns: Column[] = [{ key: 'code', label: 'Code', type: 'text' }, { key: 'name', label: 'Leave type', type: 'text' },
        { key: 'requests', label: 'Requests', type: 'int' }, { key: 'employees', label: 'Employees', type: 'int' }, { key: 'days', label: 'Days', type: 'number' }];
      const raw = (await c.db.query(`WITH r AS (${LEAVE_IN_RANGE}) SELECT t.code, t.name, grouping(t.code) AS is_total, count(DISTINCT r.id)::int AS requests,
          count(DISTINCT r.employee_id)::int AS employees, round(sum(r.days), 1) AS days
        FROM r JOIN leave_types t ON t.tenant_id=$1 AND t.id=r.leave_type_id GROUP BY GROUPING SETS ((t.code, t.name), ()) ORDER BY is_total, t.code`, args)).rows;
      return { columns, ...shape(columns, raw), notes };
    }
    const byEmp = p.groupBy === 'employee';
    const raw = (await c.db.query<{ k: string; employee_code: string | null; name: string | null; department: string; code: string; days: string }>(`WITH r AS (${LEAVE_IN_RANGE})
      SELECT ${byEmp ? `e.id::text AS k, e.employee_code, ${EMP_NAME} AS name` : `${DEPT} AS k, NULL AS employee_code, NULL AS name`}, ${DEPT} AS department, t.code, sum(r.days) AS days
      FROM r JOIN employees e ON e.tenant_id=$1 AND e.id=r.employee_id LEFT JOIN departments d ON d.tenant_id=e.tenant_id AND d.id=e.department_id
      JOIN leave_types t ON t.tenant_id=$1 AND t.id=r.leave_type_id
      GROUP BY 1, 2, 3, 4, 5 ORDER BY ${byEmp ? 'employee_code' : 'k'}, t.code`, args)).rows;
    const types = (await c.db.query<{ code: string; name: string }>(`SELECT code, name FROM leave_types WHERE tenant_id=$1 AND (status='active' OR code = ANY($2::text[])) ORDER BY code`,
      [c.tenantId, [...new Set(raw.map((r) => r.code))]])).rows;
    const columns: Column[] = [...(byEmp ? [{ key: 'employee_code', label: 'Code', type: 'text' as const }, { key: 'name', label: 'Name', type: 'text' as const }] : []),
      { key: 'department', label: 'Department', type: 'text' }, ...types.map((t) => ({ key: `t_${t.code}`, label: t.code, type: 'number' as const })),
      { key: 'total', label: 'Total days', type: 'number' }];
    const by = new Map<string, Row>();
    for (const r of raw) {
      let o = by.get(r.k);
      if (!o) { o = byEmp ? { employee_code: r.employee_code, name: r.name, department: r.department } : { department: r.department }; for (const t of types) o[`t_${t.code}`] = 0; o.total = 0; by.set(r.k, o); }
      const d = Math.round(Number(r.days) * 10) / 10;
      o[`t_${r.code}`] = Math.round(((o[`t_${r.code}`] as number) + d) * 10) / 10; o.total = Math.round(((o.total as number) + d) * 10) / 10;
    }
    const rows = [...by.values()];
    return { columns, rows, totals: rows.length ? sumRows(columns, rows) : null, notes: [...notes, `Only ${byEmp ? 'employees' : 'departments'} with approved leave in the period are listed. Columns are leave type codes (${types.map((t) => `${t.code} = ${t.name}`).join(', ')}).`] };
  },
};

const leaveBalances: ReportDef = {
  key: 'leave_balances', name: 'Leave balances', category: 'Time & leave', feature: 'leave',
  description: 'Current balance of every leave type for each employee in a leave year, and days awaiting approval.',
  access: { all: ['leave.read'], team: ['leave.team.read'] },
  params: [{ key: 'year', label: 'Leave year', type: 'int', min: 2000, max: 2100, default: async (c) => leaveYearOf(c.today, (await yearStartMonth(c.db, c.tenantId)) ?? 1) }],
  async run(c, p) {
    const emps = (await c.db.query<{ id: string; employee_code: string; name: string; department: string }>(`SELECT e.id, e.employee_code, ${EMP_NAME} AS name, ${DEPT} AS department
      FROM employees e LEFT JOIN departments d ON d.tenant_id=e.tenant_id AND d.id=e.department_id
      WHERE e.tenant_id=$1 AND e.status IN ('active','on_notice') AND ${scoped(2)} ORDER BY e.employee_code LIMIT ${MAX_ROWS + 1}`, [c.tenantId, c.team])).rows;
    const ids = emps.map((e) => e.id);
    const bal = (await c.db.query<{ employee_id: string; code: string; days: string }>(`SELECT l.employee_id, t.code, sum(l.days) AS days FROM leave_ledger l
      JOIN leave_types t ON t.tenant_id=l.tenant_id AND t.id=l.leave_type_id WHERE l.tenant_id=$1 AND l.leave_year=$2 AND l.employee_id = ANY($3::uuid[]) GROUP BY 1, 2`, [c.tenantId, p.year, ids])).rows;
    const pend = (await c.db.query<{ employee_id: string; days: string }>(`SELECT employee_id, sum(days) AS days FROM leave_requests WHERE tenant_id=$1 AND leave_year=$2 AND status='pending'
      AND employee_id = ANY($3::uuid[]) GROUP BY 1`, [c.tenantId, p.year, ids])).rows;
    const codes = new Set(bal.map((b) => b.code));
    const types = (await c.db.query<{ code: string; name: string }>(`SELECT code, name FROM leave_types WHERE tenant_id=$1 AND ((status='active' AND requires_balance) OR code = ANY($2::text[])) ORDER BY code`, [c.tenantId, [...codes]])).rows;
    const columns: Column[] = [{ key: 'employee_code', label: 'Code', type: 'text' }, { key: 'name', label: 'Name', type: 'text' }, { key: 'department', label: 'Department', type: 'text' },
      ...types.map((t) => ({ key: `t_${t.code}`, label: t.code, type: 'number' as const })), { key: 'pending', label: 'Pending approval (days)', type: 'number' }];
    const rowOf = new Map<string, Row>(emps.map((e) => [e.id, { employee_code: e.employee_code, name: e.name, department: e.department, ...Object.fromEntries(types.map((t) => [`t_${t.code}`, 0])), pending: 0 }]));
    for (const b of bal) rowOf.get(b.employee_id)![`t_${b.code}`] = Number(b.days);
    for (const x of pend) rowOf.get(x.employee_id)!.pending = Number(x.days);
    return { columns, rows: [...rowOf.values()], totals: null, notes: [`Balance from the leave ledger for leave year ${p.year}; pending requests are not yet deducted. Columns are leave type codes (${types.map((t) => `${t.code} = ${t.name}`).join(', ')}).`] };
  },
};

const PAY_GROUPS: Record<string, [string, string]> = { period: ['Month', 'r.period'], department: ['Department', DEPT], branch: ['Branch', 'b.name'], legal_entity: ['Legal entity', 'rle.name'] };
const payrollCost: ReportDef = {
  key: 'payroll_cost', name: 'Payroll cost', category: 'Pay & expenses', feature: 'payroll',
  description: 'Gross, deductions, net pay, employer cost and loss-of-pay days from approved payroll runs, by month, department, branch or legal entity.',
  access: { all: ['payroll.read'] },
  params: [{ key: 'from', label: 'From month', type: 'month', default: (c) => addMonths(monthOf(c.today), -11) }, { key: 'to', label: 'To month', type: 'month', default: (c) => monthOf(c.today) },
    { key: 'groupBy', label: 'Group by', type: 'select', default: () => 'period', options: Object.entries(PAY_GROUPS).map(([value, [label]]) => ({ value, label })) }],
  check: monthRange(36),
  async run(c, p) {
    const [label, g] = PAY_GROUPS[String(p.groupBy)]!;
    const columns: Column[] = [{ key: 'grp', label, type: 'text' }, { key: 'employees', label: 'Employees', type: 'int' }, { key: 'gross', label: 'Gross', type: 'money' },
      { key: 'deductions', label: 'Deductions', type: 'money' }, { key: 'net', label: 'Net pay', type: 'money' }, { key: 'employer_cost', label: 'Employer cost', type: 'money' },
      { key: 'lop_days', label: 'Loss-of-pay days', type: 'number' }];
    const raw = (await c.db.query(`SELECT ${g} AS grp, grouping(${g}) AS is_total, count(DISTINCT pi.employee_id)::int AS employees, sum(pi.gross) AS gross,
        sum(pi.deductions) AS deductions, sum(pi.net) AS net, sum(pi.employer_cost) AS employer_cost, sum(pi.lop_days) AS lop_days
      FROM payroll_items pi JOIN payroll_runs r ON r.tenant_id=pi.tenant_id AND r.id=pi.run_id
      JOIN legal_entities rle ON rle.tenant_id=r.tenant_id AND rle.id=r.legal_entity_id
      JOIN employees e ON e.tenant_id=pi.tenant_id AND e.id=pi.employee_id
      LEFT JOIN departments d ON d.tenant_id=e.tenant_id AND d.id=e.department_id JOIN branches b ON b.tenant_id=e.tenant_id AND b.id=e.branch_id
      WHERE pi.tenant_id=$1 AND r.status IN ('approved','finalized','paid') AND r.period BETWEEN $2 AND $3
      GROUP BY GROUPING SETS ((${g}), ()) ORDER BY is_total, grp`, [c.tenantId, p.from, p.to])).rows;
    return { columns, ...shape(columns, raw), notes: ['Approved, finalized and paid runs, including full and final settlements. Department and branch are each person’s current ones.'] };
  },
};

const EXP_GROUPS: Record<string, [string, string]> = { category: ['Category', 'cat.name'], department: ['Department', DEPT], month: ['Month', `to_char(i.expense_date, 'YYYY-MM')`] };
const EXP_STATUS: Record<string, string[]> = { approved: ['approved', 'paid'], paid: ['paid'], pending: ['submitted'] };
const expenses: ReportDef = {
  key: 'expenses', name: 'Expenses', category: 'Pay & expenses', feature: 'expenses',
  description: 'Expense amounts by category, department, employee or month of the expense, for approved, paid or pending claims.',
  access: { all: ['expenses.read'] },
  params: [fromDate((t) => `${addMonths(monthOf(t), -2)}-01`), toDate,
    { key: 'groupBy', label: 'Group by', type: 'select', default: () => 'category', options: [...Object.entries(EXP_GROUPS).map(([value, [label]]) => ({ value, label })), { value: 'employee', label: 'Employee' }] },
    { key: 'status', label: 'Claims', type: 'select', default: () => 'approved', options: [{ value: 'approved', label: 'Approved or paid' }, { value: 'paid', label: 'Paid' }, { value: 'pending', label: 'Awaiting approval' }] }],
  check: dateRange(1096),
  async run(c, p) {
    const byEmp = p.groupBy === 'employee';
    const [label, g] = byEmp ? ['', ''] : EXP_GROUPS[String(p.groupBy)]!;
    const columns: Column[] = [...(byEmp ? [{ key: 'employee_code', label: 'Code', type: 'text' as const }, { key: 'name', label: 'Name', type: 'text' as const }, { key: 'department', label: 'Department', type: 'text' as const }]
      : [{ key: 'grp', label, type: 'text' as const }]),
      { key: 'claims', label: 'Claims', type: 'int' }, { key: 'items', label: 'Items', type: 'int' }, { key: 'amount', label: 'Amount', type: 'money' }];
    const raw = (await c.db.query(`SELECT ${byEmp ? `e.employee_code, ${EMP_NAME} AS name, ${DEPT} AS department, grouping(e.id) AS is_total` : `${g} AS grp, grouping(${g}) AS is_total`},
        count(DISTINCT cl.id)::int AS claims, count(*)::int AS items, sum(i.amount) AS amount
      FROM expense_items i JOIN expense_claims cl ON cl.tenant_id=i.tenant_id AND cl.id=i.claim_id
      JOIN expense_categories cat ON cat.tenant_id=i.tenant_id AND cat.id=i.category_id
      JOIN employees e ON e.tenant_id=cl.tenant_id AND e.id=cl.employee_id LEFT JOIN departments d ON d.tenant_id=e.tenant_id AND d.id=e.department_id
      WHERE i.tenant_id=$1 AND i.expense_date BETWEEN $2 AND $3 AND cl.status = ANY($4::text[])
      GROUP BY GROUPING SETS (${byEmp ? '(e.id, e.employee_code, e.first_name, e.last_name, d.name)' : `(${g})`}, ())
      ORDER BY is_total, ${byEmp ? 'amount DESC' : 'grp'} LIMIT ${MAX_ROWS + 2}`, [c.tenantId, p.from, p.to, EXP_STATUS[String(p.status)]])).rows;
    const out = shape(columns, raw);
    if (out.totals && byEmp) { out.totals.employee_code = null; out.totals.name = null; out.totals.department = null; }
    return { columns, ...out, notes: ['By the date of each expense item.'] };
  },
};

const dueParams = (what: string): ParamDef[] => [
  { key: 'withinDays', label: 'Due within (days)', type: 'int', min: 0, max: 365, default: () => 60 },
  { key: 'show', label: 'Show', type: 'select', default: () => 'all', options: [{ value: 'all', label: `Expired and due ${what}` }, { value: 'expired', label: 'Expired only' }, { value: 'due', label: 'Not yet expired' }] }];
const showFilter = (col: string, n: number) => `($${n}::text = 'all' OR ($${n}::text = 'expired') = (${col} < $2::date))`;

const trainingExpiry: ReportDef = {
  key: 'training_expiry', name: 'Training due for renewal', category: 'Training & competency', feature: 'training',
  description: 'The latest valid training of current employees that has expired or expires soon.',
  access: { all: ['competency.read', 'training.manage'] },
  params: dueParams('soon'),
  async run(c, p) {
    const columns: Column[] = [{ key: 'employee_code', label: 'Code', type: 'text' }, { key: 'name', label: 'Name', type: 'text' }, { key: 'department', label: 'Department', type: 'text' },
      { key: 'course_code', label: 'Course', type: 'text' }, { key: 'course', label: 'Course name', type: 'text' }, { key: 'completed_on', label: 'Completed', type: 'date' },
      { key: 'expires_on', label: 'Expires', type: 'date' }, { key: 'days_left', label: 'Days left', type: 'int' }];
    const raw = (await c.db.query(`WITH latest AS (SELECT DISTINCT ON (t.employee_id, t.course_id) t.employee_id, t.course_id, t.completed_on, t.expires_on FROM training_records t
        WHERE t.tenant_id=$1 AND t.status='active' AND t.result IN ('passed','completed') ORDER BY t.employee_id, t.course_id, t.completed_on DESC, t.created_at DESC)
      SELECT e.employee_code, ${EMP_NAME} AS name, ${DEPT} AS department, co.code AS course_code, co.name AS course, l.completed_on::text, l.expires_on::text, (l.expires_on - $2::date) AS days_left
      FROM latest l JOIN employees e ON e.tenant_id=$1 AND e.id=l.employee_id LEFT JOIN departments d ON d.tenant_id=e.tenant_id AND d.id=e.department_id
      JOIN training_courses co ON co.tenant_id=$1 AND co.id=l.course_id
      WHERE l.expires_on IS NOT NULL AND l.expires_on <= $2::date + $3::int AND e.status IN ('active','on_notice') AND co.status='active' AND ${showFilter('l.expires_on', 4)}
      ORDER BY l.expires_on, e.employee_code LIMIT ${MAX_ROWS + 1}`, [c.tenantId, c.today, p.withinDays, p.show])).rows;
    return { columns, ...shape(columns, raw), notes: ['A negative number of days left means the training has expired.'] };
  },
};

const authorizationReviews: ReportDef = {
  key: 'authorization_reviews', name: 'Authorizations due for review', category: 'Training & competency', feature: 'lab.competency',
  description: 'Technical authorizations in force (or suspended) whose periodic review is overdue or due soon.',
  access: { all: ['competency.read'] },
  params: dueParams('soon'),
  async run(c, p) {
    const columns: Column[] = [{ key: 'employee_code', label: 'Code', type: 'text' }, { key: 'name', label: 'Name', type: 'text' }, { key: 'department', label: 'Department', type: 'text' },
      { key: 'method_code', label: 'Method', type: 'text' }, { key: 'method', label: 'Method name', type: 'text' }, { key: 'activity', label: 'Activity', type: 'text' },
      { key: 'status', label: 'Status', type: 'text' }, { key: 'review_due', label: 'Review due', type: 'date' }, { key: 'days_left', label: 'Days left', type: 'int' }];
    const raw = (await c.db.query(`SELECT e.employee_code, ${EMP_NAME} AS name, ${DEPT} AS department, m.code AS method_code, m.name AS method, a.activity, a.status,
        a.review_due::text, (a.review_due - $2::date) AS days_left
      FROM lab_authorizations a JOIN employees e ON e.tenant_id=a.tenant_id AND e.id=a.employee_id LEFT JOIN departments d ON d.tenant_id=e.tenant_id AND d.id=e.department_id
      JOIN lab_methods m ON m.tenant_id=a.tenant_id AND m.id=a.method_id
      WHERE a.tenant_id=$1 AND a.status IN ('authorized','suspended') AND a.review_due IS NOT NULL AND a.review_due <= $2::date + $3::int
        AND e.status IN ('active','on_notice') AND ${showFilter('a.review_due', 4)}
      ORDER BY a.review_due, e.employee_code LIMIT ${MAX_ROWS + 1}`, [c.tenantId, c.today, p.withinDays, p.show])).rows;
    const out = shape(columns, raw);
    for (const r of out.rows) { r.activity = ACTIVITY[String(r.activity)] ?? r.activity; r.status = r.status === 'authorized' ? 'Authorized' : 'Suspended'; }
    return { columns, ...out, notes: ['A negative number of days left means the review is overdue.'] };
  },
};

/**
 * One row per department across modules. Each block of columns appears only when its module is in use AND the
 * person running the report may see that data (attendance, leave, overtime, expenses, payroll cost).
 */
const departmentOverview: ReportDef = {
  key: 'department_overview', name: 'Department overview', category: 'Across modules', feature: 'reports.advanced',
  description: 'Headcount, joiners and leavers, attendance, leave, overtime, expenses and payroll cost per department, for one period.',
  access: { all: ['employees.read'] },
  params: [fromDate(monthStart), toDate],
  check: dateRange(366),
  async run(c, p) {
    const from = String(p.from); const to = String(p.to);
    const rows = new Map<string, Row>();
    const row = (dept: string) => { let r = rows.get(dept); if (!r) { r = { department: dept }; rows.set(dept, r); } return r; };
    const merge = (list: Record<string, unknown>[], keys: string[]) => { for (const x of list) { const r = row(String(x.department)); for (const k of keys) r[k] = x[k] == null ? null : Number(x[k]); } };
    const columns: Column[] = [{ key: 'department', label: 'Department', type: 'text' }, { key: 'headcount', label: 'Headcount', type: 'int' },
      { key: 'joiners', label: 'Joined', type: 'int' }, { key: 'leavers', label: 'Left', type: 'int' }];
    const notes: string[] = [];
    merge((await c.db.query(`SELECT ${DEPT} AS department, count(*) FILTER (WHERE ${onDate('$3')})::int AS headcount,
        count(*) FILTER (WHERE e.status <> 'pre_joining' AND e.date_of_joining BETWEEN $2 AND $3)::int AS joiners,
        count(*) FILTER (WHERE e.exit_date BETWEEN $2 AND $3)::int AS leavers
      FROM employees e ${EMP_JOINS} WHERE e.tenant_id=$1 GROUP BY 1`, [c.tenantId, from, to])).rows, ['headcount', 'joiners', 'leavers']);
    const blocks: { on: boolean; cols: Column[]; sql: string; keys: string[] }[] = [
      { on: c.usable('attendance') && c.has('attendance.read'), cols: [{ key: 'attendance_pct', label: 'Attendance %', type: 'percent' }],
        keys: ['present', 'half', 'working', 'leave'],
        sql: `SELECT ${DEPT} AS department, count(*) FILTER (WHERE ad.status IN ('present','on_duty'))::int AS present, count(*) FILTER (WHERE ad.status='half_day')::int AS half,
            count(*) FILTER (WHERE ad.day_type='working' AND ad.status <> 'not_joined')::int AS working, count(*) FILTER (WHERE ad.status='on_leave')::int AS leave
          FROM attendance_daily ad JOIN employees e ON e.tenant_id=ad.tenant_id AND e.id=ad.employee_id ${EMP_JOINS} WHERE ad.tenant_id=$1 AND ad.work_date BETWEEN $2 AND $3 GROUP BY 1` },
      { on: c.usable('leave') && c.has('leave.read'), cols: [{ key: 'leave_days', label: 'Leave days', type: 'number' }], keys: ['leave_days'],
        sql: `SELECT ${DEPT} AS department, round(sum(r.days),1) AS leave_days FROM leave_requests r JOIN employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id ${EMP_JOINS}
          WHERE r.tenant_id=$1 AND r.status='approved' AND r.start_date <= $3 AND r.end_date >= $2 GROUP BY 1` },
      { on: c.usable('overtime') && c.has('overtime.read'), cols: [{ key: 'overtime_hours', label: 'Overtime approved (h)', type: 'number' }], keys: ['overtime_hours'],
        sql: `SELECT ${DEPT} AS department, round(sum(o.minutes)/60.0,1) AS overtime_hours FROM overtime_claims o JOIN employees e ON e.tenant_id=o.tenant_id AND e.id=o.employee_id ${EMP_JOINS}
          WHERE o.tenant_id=$1 AND o.status='approved' AND o.work_date BETWEEN $2 AND $3 GROUP BY 1` },
      { on: c.usable('expenses') && c.has('expenses.read'), cols: [{ key: 'expenses', label: 'Expenses approved', type: 'money' }], keys: ['expenses'],
        sql: `SELECT ${DEPT} AS department, sum(x.total) AS expenses FROM expense_claims x JOIN employees e ON e.tenant_id=x.tenant_id AND e.id=x.employee_id ${EMP_JOINS}
          WHERE x.tenant_id=$1 AND x.status IN ('approved','paid') AND x.approved_at::date BETWEEN $2 AND $3 GROUP BY 1` },
      { on: c.usable('payroll') && c.has('payroll.read'), cols: [{ key: 'payroll_gross', label: 'Payroll gross', type: 'money' }, { key: 'employer_cost', label: 'Employer cost', type: 'money' }],
        keys: ['payroll_gross', 'employer_cost'],
        sql: `SELECT ${DEPT} AS department, sum(pi.gross) AS payroll_gross, sum(pi.employer_cost) AS employer_cost
          FROM payroll_items pi JOIN payroll_runs r ON r.tenant_id=pi.tenant_id AND r.id=pi.run_id JOIN employees e ON e.tenant_id=pi.tenant_id AND e.id=pi.employee_id ${EMP_JOINS}
          WHERE pi.tenant_id=$1 AND r.status IN ('finalized','paid') AND r.period BETWEEN to_char($2::date,'YYYY-MM') AND to_char($3::date,'YYYY-MM') GROUP BY 1` },
    ];
    for (const b of blocks) {
      if (!b.on) continue;
      columns.push(...b.cols);
      merge((await c.db.query(b.sql, [c.tenantId, from, to])).rows, b.keys);
    }
    const hidden = blocks.filter((b) => !b.on).flatMap((b) => b.cols.map((x) => x.label));
    if (hidden.length) notes.push(`Not shown (module not in use, or not visible to you): ${hidden.join(', ')}.`);
    notes.push('Departments are the employees\' current departments. Payroll covers finalized runs for the months in the period.');
    const out = [...rows.values()].filter((r) => Object.keys(r).length > 1).sort((a, b) => String(a.department).localeCompare(String(b.department)));
    const sum = (k: string) => out.reduce((t, r) => t + (Number(r[k]) || 0), 0);
    for (const r of out) {
      if ('working' in r) { r.attendance_pct = pct((Number(r.present) || 0) + (Number(r.half) || 0) / 2, (Number(r.working) || 0) - (Number(r.leave) || 0)); delete r.present; delete r.half; delete r.working; delete r.leave; }
    }
    const totals: Row = { department: 'All departments' };
    for (const col of columns.slice(1)) if (col.type !== 'percent') totals[col.key] = sum(col.key);
    return { columns, rows: out, totals, notes };
  },
};

export const REPORTS: readonly ReportDef[] = [headcount, attrition, joinersLeavers, attendance, leaveTaken, leaveBalances, payrollCost, expenses, trainingExpiry, authorizationReviews, departmentOverview];
export const REPORT_MAP: ReadonlyMap<string, ReportDef> = new Map(REPORTS.map((r) => [r.key, r]));

/** Validate the query against the report's parameters; missing ones take their defaults. */
export async function resolveParams(def: ReportDef, raw: unknown, dc: DefaultCtx): Promise<{ params: Params; error: string | null }> {
  const shapeOf: Record<string, z.ZodType> = {};
  for (const p of def.params) {
    const base = p.type === 'date' ? IsoDate
      : p.type === 'month' ? z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM')
        : p.type === 'select' ? z.enum(p.options!.map((o) => o.value) as [string, ...string[]])
          : z.coerce.number().int().min(p.min ?? 0).max(p.max ?? 100000);
    shapeOf[p.key] = z.preprocess((v) => (v === '' ? undefined : v), base.optional());
  }
  const parsed = z.object(shapeOf).parse(raw ?? {}) as Record<string, string | number | undefined>;
  const params: Params = {};
  for (const p of def.params) params[p.key] = parsed[p.key] ?? await p.default(dc);
  return { params, error: def.check?.(params) ?? null };
}
