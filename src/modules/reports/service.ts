import type { Db } from '../../db/tx.js';
import { badRequest, forbidden, notFound } from '../../core/http/errors.js';
import { requireFeature } from '../../core/http/context.js';
import { evaluateFeatures } from '../../core/features/state.js';
import { loadPermissions } from '../../core/auth/session.js';
import { notifyUsers } from '../../core/notify/service.js';
import { orgToday } from '../competency/service.js';
import { teamEmployeeIds } from '../attendance/service.js';
import { addDays } from '../attendance/time.js';
import { MAX_ROWS, REPORT_MAP, resolveParams, type ReportDef, type ReportResult, type Params } from './registry.js';

export interface Viewer { userId: string; employeeId: string | null; has: (p: string) => boolean }

/** 'all' (organization-wide), 'team' (the viewer's reporting chain) or null (no access). */
export function scopeOf(r: ReportDef, v: Pick<Viewer, 'employeeId' | 'has'>): 'all' | 'team' | null {
  if (r.access.all.some((p) => v.has(p))) return 'all';
  if (v.employeeId && r.access.team?.some((p) => v.has(p))) return 'team';
  return null;
}

/** Run a report as `viewer`, with that person's access (organization or their team). */
export async function runReport(db: Db, tenantId: string, key: string, rawParams: unknown, viewer: Viewer) {
  const def = REPORT_MAP.get(key);
  if (!def) throw notFound('Report not found');
  const scope = scopeOf(def, viewer);
  if (!scope) throw forbidden();
  const features = await evaluateFeatures(db, tenantId);
  const usable = (f: string) => !!features.get(f)?.usable;
  if (def.feature) await requireFeature(db, tenantId, def.feature);
  const today = await orgToday(db, tenantId);
  const { params, error } = await resolveParams(def, rawParams, { db, tenantId, today });
  if (error) throw badRequest(error);
  const team = scope === 'team' ? await teamEmployeeIds(db, tenantId, viewer.employeeId!) : null;
  const out: ReportResult = await def.run({ db, tenantId, today, team, has: viewer.has, usable }, params);
  const truncated = out.rows.length > MAX_ROWS;
  if (truncated) out.rows = out.rows.slice(0, MAX_ROWS);
  if (scope === 'team') out.notes.unshift('Your reporting team only.');
  if (truncated) out.notes.unshift(`Only the first ${MAX_ROWS} rows are shown; narrow the period or filters.`);
  return { def, scope, params, today, truncated, ...out };
}

/** The viewer as of now: active user, current roles (a schedule never outlives its owner's access). */
export async function viewerOf(db: Db, tenantId: string, userId: string): Promise<Viewer | null> {
  const u = (await db.query<{ status: string; employee_id: string | null }>(`SELECT u.status, (SELECT e.id FROM employees e WHERE e.tenant_id=u.tenant_id AND e.user_id=u.id LIMIT 1) AS employee_id
    FROM users u WHERE u.tenant_id=$1 AND u.id=$2`, [tenantId, userId])).rows[0];
  if (!u || u.status !== 'active') return null;
  const { permissions } = await loadPermissions(db, userId, tenantId);
  return { userId, employeeId: u.employee_id, has: (p) => permissions.has(p) };
}

const ym = (d: string) => d.slice(0, 7);
const firstOf = (d: string) => `${ym(d)}-01`;
/** A schedule's relative period, as the report's from/to (date or month parameters). */
export function periodParams(def: ReportDef, period: string, today: string): Params {
  if (period === 'as_saved') return {};
  const y = addDays(today, -1);
  const lastMonthEnd = addDays(firstOf(today), -1);
  const [from, to] = period === 'yesterday' ? [y, y] : period === 'last_7_days' ? [addDays(today, -7), y]
    : period === 'last_month' ? [firstOf(lastMonthEnd), lastMonthEnd] : period === 'month_to_date' ? [firstOf(today), today] : [`${today.slice(0, 4)}-01-01`, today];
  const out: Params = {};
  for (const p of def.params) {
    if (p.key !== 'from' && p.key !== 'to') continue;
    const v = p.key === 'from' ? from : to;
    out[p.key] = p.type === 'month' ? ym(v) : v;
  }
  return out;
}

/** The next run date strictly after `after`. */
export function nextRun(s: { frequency: string; weekday: number | null; day_of_month: number | null }, after: string): string {
  let d = addDays(after, 1);
  for (let i = 0; i < 40; i++, d = addDays(d, 1)) {
    if (s.frequency === 'daily') return d;
    if (s.frequency === 'weekly' && new Date(`${d}T00:00:00Z`).getUTCDay() === s.weekday) return d;
    if (s.frequency === 'monthly' && Number(d.slice(8)) === s.day_of_month) return d;
  }
  return d;
}

const RETAIN_DAYS = 90;

/**
 * Run every schedule due by `today` (daily job). Each runs with its owner's current access; recipients other than
 * the owner get it only when they may see the report for the whole organization themselves, and only when the
 * owner's copy is organization-wide (a manager's team report goes to that manager alone). Recipients are told in
 * HRMS (and by email); the data stays in HRMS behind sign-in. Old snapshots are removed.
 */
export async function runSchedules(db: Db, tenantId: string, today: string) {
  const due = (await db.query<{ id: string; frequency: string; weekday: number | null; day_of_month: number | null; period: string; recipient_ids: string[];
    saved_id: string; owner_id: string; report_key: string; name: string; params: Record<string, unknown> }>(`SELECT s.id, s.frequency, s.weekday, s.day_of_month, s.period, s.recipient_ids,
      r.id AS saved_id, r.owner_id, r.report_key, r.name, r.params FROM report_schedules s JOIN saved_reports r ON r.tenant_id=s.tenant_id AND r.id=s.saved_report_id
    WHERE s.tenant_id=$1 AND s.enabled AND s.next_run_on <= $2 ORDER BY s.next_run_on FOR UPDATE OF s SKIP LOCKED`, [tenantId, today])).rows;
  let ran = 0; let skipped = 0;
  for (const s of due) {
    const advance = (result: string, disable = false) => db.query(`UPDATE report_schedules SET next_run_on=$3, last_run_at=now(), last_result=$4, enabled=enabled AND NOT $5 WHERE tenant_id=$1 AND id=$2`,
      [tenantId, s.id, nextRun(s, today), result.slice(0, 300), disable]);
    const owner = await viewerOf(db, tenantId, s.owner_id);
    const def = REPORT_MAP.get(s.report_key);
    if (!owner || !def || !scopeOf(def, owner)) { await advance('Stopped: the owner can no longer run this report', true); skipped++; continue; }
    try {
      const r = await runReport(db, tenantId, s.report_key, { ...s.params, ...periodParams(def, s.period, today) }, owner);
      const recipients = [owner.userId];
      if (r.scope === 'all') {
        for (const id of s.recipient_ids) {
          if (id === owner.userId) continue;
          const v = await viewerOf(db, tenantId, id);
          if (v && scopeOf(def, v) === 'all') recipients.push(id);
        }
      }
      const snap = (await db.query<{ id: string }>(`INSERT INTO report_snapshots (tenant_id, schedule_id, owner_id, report_key, name, params, scope, columns, rows, totals, notes, row_count, recipient_ids, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now() + make_interval(days => $14)) RETURNING id`,
        [tenantId, s.id, owner.userId, s.report_key, s.name, JSON.stringify(r.params), r.scope, JSON.stringify(r.columns), JSON.stringify(r.rows), r.totals ? JSON.stringify(r.totals) : null,
         JSON.stringify(r.notes), r.rows.length, recipients, RETAIN_DAYS])).rows[0]!.id;
      await notifyUsers(db, tenantId, recipients, { kind: 'reports.ready', title: `Report ready: ${s.name}`, body: `${def.name} · ${r.rows.length} row(s). Open it in HRMS.`,
        link: `/reports?snapshot=${snap}`, actionLabel: 'Open report', dedupeKey: `report:${snap}` });
      await advance(`Sent to ${recipients.length} person(s)${recipients.length < s.recipient_ids.length + 1 ? '; recipients without organization-wide access were left out' : ''}`);
      ran++;
    } catch (e) {
      await advance(`Failed: ${(e as Error).message}`);
      skipped++;
    }
  }
  const purged = (await db.query(`DELETE FROM report_snapshots WHERE tenant_id=$1 AND expires_at < now()`, [tenantId])).rowCount ?? 0;
  return { due: due.length, ran, skipped, purged };
}
