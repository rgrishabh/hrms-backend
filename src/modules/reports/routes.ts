import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { only } from '../../core/features/routes.js';
import { tenantActor, requireFeature, readDevice, type TenantActor } from '../../core/http/context.js';
import { openJson } from '../../core/crypto/index.js';
import { wantsReveal } from '../../core/policy/salary.js';
import { audit } from '../../core/audit/audit.js';
import { badRequest, conflict, notFound } from '../../core/http/errors.js';
import { csv } from '../../core/http/csv.js';
import { xlsx, XLSX_TYPE } from '../../core/http/xlsx.js';
import { Uuid } from '../../core/http/pagination.js';
import { allOff, evaluateFeatures } from '../../core/features/state.js';
import { orgToday } from '../competency/service.js';
import { REPORTS, REPORT_MAP, type Column, type Row } from './registry.js';
import { runReport, scopeOf, snapshotForReader, viewerOf, nextRun, type Viewer } from './service.js';
import type { Db } from '../../db/tx.js';

/** Permissions that can open at least one report (the UI shows the Reports menu for these). */
export const REPORT_PERMISSIONS = [...new Set(REPORTS.flatMap((r) => [...r.access.all, ...(r.access.team ?? [])]))];

const viewer = (a: TenantActor): Viewer => ({ userId: a.user.userId, employeeId: a.user.employeeId, level: a.user.salaryLevel, has: a.has });
const ADV = 'reports.advanced';

/** The same report as an Excel workbook: typed columns (money, dates, percentages), bold header and totals. */
function sendXlsx(reply: FastifyReply, name: string, title: string, columns: Column[], rows: Row[], totals: Row | null) {
  const body = xlsx([{ name: title, columns: columns.map((c) => ({ label: c.label, type: c.type })), rows: rows.map((r) => columns.map((c) => r[c.key])),
    totals: totals ? columns.map((c, i) => (i === 0 ? 'Total' : totals[c.key])) : null }]);
  return reply.header('content-type', XLSX_TYPE).header('content-disposition', `attachment; filename="${name}.xlsx"`).header('cache-control', 'private, no-store').send(body);
}

function sendCsv(reply: FastifyReply, name: string, columns: Column[], rows: Row[], totals: Row | null) {
  const cell = (type: string, v: unknown) => (v == null ? '' : type === 'money' ? Number(v).toFixed(2) : v);
  const lines: unknown[][] = [columns.map((c) => c.label), ...rows.map((r) => columns.map((c) => cell(c.type, r[c.key])))];
  if (totals) lines.push(columns.map((c, i) => (i === 0 ? 'Total' : cell(c.type, totals[c.key]))));
  return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}.csv"`)
    .header('cache-control', 'private, no-store').send('﻿' + csv(lines));
}

const SavedBody = z.object({ reportKey: z.string().max(60), name: z.string().trim().min(2).max(100), params: z.record(z.string(), z.union([z.string(), z.number()])).default({}) });
const ScheduleBody = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly']), weekday: z.number().int().min(0).max(6).optional(), dayOfMonth: z.number().int().min(1).max(28).optional(),
  period: z.enum(['as_saved', 'yesterday', 'last_7_days', 'last_month', 'month_to_date', 'year_to_date']).default('as_saved'),
  recipientIds: z.array(Uuid).max(50).default([]), enabled: z.boolean().default(true),
});

async function ownSaved(db: Db, a: TenantActor, id: string) {
  const s = (await db.query<{ id: string; report_key: string; name: string; params: Record<string, unknown> }>(`SELECT id, report_key, name, params FROM saved_reports WHERE tenant_id=$1 AND id=$2 AND owner_id=$3`,
    [a.tenantId, id, a.user.userId])).rows[0];
  if (!s) throw notFound('Saved report not found');
  return s;
}

const offReportKeys = () => REPORTS.filter((r) => allOff(r.feature)).map((r) => r.key);

export async function reportRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    const a = tenantActor(req);
    return a.tx(async (db) => {
      const features = await evaluateFeatures(db, a.tenantId);
      const today = await orgToday(db, a.tenantId);
      const items = [];
      for (const r of REPORTS) {
        const scope = scopeOf(r, viewer(a));
        if (!scope || (r.feature && !features.get(r.feature)?.usable)) continue;
        const params = [];
        for (const p of r.params) params.push({ key: p.key, label: p.label, type: p.type, options: p.options, min: p.min, max: p.max, default: await p.default({ db, tenantId: a.tenantId, today }) });
        items.push({ key: r.key, name: r.name, description: r.description, category: r.category, scope, params });
      }
      return { items, today, advanced: !!features.get(ADV)?.usable };
    });
  });

  // ------------------------------------------------------------ advanced: saved reports, schedules, snapshots
  only(app, 'reports.advanced').get('/saved', async (req) => {
    const a = tenantActor(req);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, ADV);
      const items = (await db.query(`SELECT r.id, r.report_key, r.name, r.params, r.created_at,
          (SELECT json_build_object('id', s.id, 'frequency', s.frequency, 'weekday', s.weekday, 'dayOfMonth', s.day_of_month, 'period', s.period, 'recipientIds', s.recipient_ids,
             'enabled', s.enabled, 'nextRunOn', s.next_run_on::text, 'lastRunAt', s.last_run_at, 'lastResult', s.last_result)
            FROM report_schedules s WHERE s.tenant_id=r.tenant_id AND s.saved_report_id=r.id LIMIT 1) AS schedule
        FROM saved_reports r WHERE r.tenant_id=$1 AND r.owner_id=$2 AND NOT (r.report_key = ANY($3)) ORDER BY r.name`, [a.tenantId, a.user.userId, offReportKeys()])).rows;
      return { items: items.filter((i) => REPORT_MAP.has(i.report_key)).map((i) => ({ ...i, reportName: REPORT_MAP.get(i.report_key)!.name })) };
    });
  });

  only(app, 'reports.advanced').post('/saved', async (req, reply) => {
    const a = tenantActor(req);
    const b = SavedBody.parse(req.body);
    const def = REPORT_MAP.get(b.reportKey);
    if (!def || !scopeOf(def, viewer(a))) throw notFound('Report not found');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, ADV);
      const params = Object.fromEntries(Object.entries(b.params).filter(([k]) => def.params.some((p) => p.key === k)));
      const id = (await db.query<{ id: string }>(`INSERT INTO saved_reports (tenant_id, owner_id, report_key, name, params) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (tenant_id, owner_id, name) DO NOTHING RETURNING id`, [a.tenantId, a.user.userId, b.reportKey, b.name, JSON.stringify(params)])).rows[0]?.id;
      if (!id) throw conflict('You already have a saved report with this name');
      reply.code(201); return { id };
    });
  });

  only(app, 'reports.advanced').delete('/saved/:id', async (req) => {
    const a = tenantActor(req);
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await ownSaved(db, a, id);
      await db.query(`DELETE FROM saved_reports WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      return { ok: true };
    });
  });

  /** Schedule a saved report (one schedule per saved report). Recipients need organization-wide access themselves. */
  only(app, 'reports.advanced').put('/saved/:id/schedule', async (req) => {
    const a = tenantActor(req);
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const b = ScheduleBody.parse(req.body);
    if (b.frequency === 'weekly' && b.weekday === undefined) throw badRequest('Choose the day of the week');
    if (b.frequency === 'monthly' && b.dayOfMonth === undefined) throw badRequest('Choose the day of the month (1–28)');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, ADV);
      const s = await ownSaved(db, a, id);
      const def = REPORT_MAP.get(s.report_key)!;
      const scope = scopeOf(def, viewer(a));
      if (!scope) throw notFound('Report not found');
      const others = [...new Set(b.recipientIds.filter((r) => r !== a.user.userId))];
      if (others.length && scope !== 'all') throw badRequest('A report limited to your team can only be scheduled for yourself');
      let refused = 0;
      for (const r of others) { const v = await viewerOf(db, a.tenantId, r); if (!v || scopeOf(def, v) !== 'all') refused++; }
      if (refused) throw badRequest(`${refused} recipient(s) cannot see this report for the whole organization`);
      const sched = { frequency: b.frequency, weekday: b.frequency === 'weekly' ? b.weekday! : null, day_of_month: b.frequency === 'monthly' ? b.dayOfMonth! : null };
      const next = nextRun(sched, await orgToday(db, a.tenantId));
      const args = [a.tenantId, id, sched.frequency, sched.weekday, sched.day_of_month, b.period, others, b.enabled, next];
      const u = await db.query(`UPDATE report_schedules SET frequency=$3, weekday=$4, day_of_month=$5, period=$6, recipient_ids=$7, enabled=$8, next_run_on=$9
        WHERE tenant_id=$1 AND saved_report_id=$2`, args);
      if (!u.rowCount) await db.query(`INSERT INTO report_schedules (tenant_id, saved_report_id, frequency, weekday, day_of_month, period, recipient_ids, enabled, next_run_on, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [...args, a.user.userId]);
      await audit(db, { ...a.auditBase, action: 'reports.scheduled', category: 'configuration', targetType: 'saved_report', targetId: id, metadata: { report: s.report_key, ...b } });
      return { ok: true, nextRunOn: next };
    });
  });

  /** People who may receive this saved report: active users who can see it for the whole organization. */
  only(app, 'reports.advanced').get('/saved/:id/recipients', async (req) => {
    const a = tenantActor(req);
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, ADV);
      const s = await ownSaved(db, a, id);
      const def = REPORT_MAP.get(s.report_key)!;
      if (scopeOf(def, viewer(a)) !== 'all') return { items: [] };
      const users = (await db.query<{ id: string; display_name: string; email: string }>(`SELECT id, display_name, email FROM users WHERE tenant_id=$1 AND status='active' AND id <> $2 ORDER BY display_name`,
        [a.tenantId, a.user.userId])).rows;
      const items = [];
      for (const u of users) { const v = await viewerOf(db, a.tenantId, u.id); if (v && scopeOf(def, v) === 'all') items.push({ id: u.id, name: u.display_name, email: u.email }); }
      return { items };
    });
  });

  only(app, 'reports.advanced').delete('/saved/:id/schedule', async (req) => {
    const a = tenantActor(req);
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await ownSaved(db, a, id);
      await db.query(`DELETE FROM report_schedules WHERE tenant_id=$1 AND saved_report_id=$2`, [a.tenantId, id]);
      return { ok: true };
    });
  });

  /** Scheduled reports sent to me (kept 90 days). */
  only(app, 'reports.advanced').get('/snapshots', async (req) => {
    const a = tenantActor(req);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, ADV);
      return { items: (await db.query(`SELECT s.id, s.name, s.report_key, s.params, s.scope, s.row_count, s.generated_at, s.expires_at, u.display_name AS owner
        FROM report_snapshots s JOIN users u ON u.id=s.owner_id WHERE s.tenant_id=$1 AND $2 = ANY(s.recipient_ids) AND s.expires_at > now() AND NOT (s.report_key = ANY($3)) ORDER BY s.generated_at DESC LIMIT 100`,
        [a.tenantId, a.user.userId, offReportKeys()])).rows };
    });
  });

  /** A snapshot: only its recipients, and only while they can still see that report (access is checked again now). */
  async function loadSnapshot(a: TenantActor, id: string) {
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, ADV);
      const stored = (await db.query<{ id: string; name: string; report_key: string; scope: string; owner_id: string; columns: Column[]; data_enc: string; notes: string[]; params: unknown; generated_at: Date; viewer_level: number | null }>(
        `SELECT id, name, report_key, scope, owner_id, columns, data_enc, notes, params, generated_at, viewer_level FROM report_snapshots
          WHERE tenant_id=$1 AND id=$2 AND $3 = ANY(recipient_ids) AND expires_at > now()`, [a.tenantId, id, a.user.userId])).rows[0];
      const def = stored && REPORT_MAP.get(stored.report_key);
      if (!stored || !def) throw notFound('Report not found');
      // Sealed for one reader at one level. Someone whose level has since dropped no longer gets it.
      if (stored.viewer_level !== null && stored.viewer_level > a.user.salaryLevel) throw notFound('Report not found');
      const { data_enc, ...meta } = stored;
      const s = { ...meta, ...openJson<{ rows: Row[]; totals: Row | null }>(data_enc) };
      const mine = scopeOf(def, viewer(a));
      if (!mine || (s.scope === 'all' && mine !== 'all')) throw notFound('Report not found');
      if (def.feature) await requireFeature(db, a.tenantId, def.feature);
      const features = await evaluateFeatures(db, a.tenantId);
      return snapshotForReader(def, s, a.has, (f) => !!features.get(f)?.usable);
    });
  }
  only(app, 'reports.advanced').get('/snapshots/:id', async (req) => {
    const a = tenantActor(req);
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const s = await loadSnapshot(a, id);
    if (REPORT_MAP.get(s.report_key)?.l4) await a.tx((db) => audit(db, { ...a.auditBase, userAgent: readDevice(req).userAgent, action: 'l4.read', category: 'access', targetType: 'report_snapshot', targetId: id, metadata: { report: s.report_key, rows: s.rows.length } }));
    return { id: s.id, key: s.report_key, name: s.name, params: s.params, scope: s.scope, columns: s.columns, rows: s.rows, totals: s.totals, notes: s.notes, generatedAt: s.generated_at };
  });
  for (const format of ['csv', 'xlsx'] as const) app.get(`/snapshots/:id/export.${format}`, async (req, reply) => {
    const a = tenantActor(req);
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const s = await loadSnapshot(a, id);
    await a.tx((db) => audit(db, { ...a.auditBase, action: 'reports.exported', category: 'access', targetType: 'report_snapshot', targetId: id, metadata: { report: s.report_key, rows: s.rows.length, format } }));
    const name = `${s.report_key}-${new Date(s.generated_at).toISOString().slice(0, 10)}`;
    return format === 'csv' ? sendCsv(reply, name, s.columns, s.rows, s.totals) : sendXlsx(reply, name, s.name, s.columns, s.rows, s.totals);
  });

  // ------------------------------------------------------------ run a report
  /** A report that is not available is a 404 before anything else, so this route does not change what `/saved` answers while it is off. */
  const reportKey = (req: FastifyRequest) => {
    const { key } = z.object({ key: z.string().max(60) }).parse(req.params);
    const def = REPORT_MAP.get(key);
    if (!def || allOff(def.feature)) throw notFound('Report not found');
    return key;
  };

  app.get('/:key', async (req) => {
    const key = reportKey(req);
    const a = tenantActor(req);
    const reveal = wantsReveal(req);
    const { def, ...r } = await a.tx((db) => runReport(db, a.tenantId, key, req.query, viewer(a), { reveal }));
    if (def.l4 && reveal) await a.tx((db) => audit(db, { ...a.auditBase, userAgent: readDevice(req).userAgent, action: 'l4.reveal', category: 'access', targetType: 'report', targetId: def.key, metadata: { params: r.params, excluded: r.excluded ?? 0 } }));
    return { key: def.key, name: def.name, generatedAt: new Date().toISOString(), ...r };
  });

  /** CSV or Excel export: audited (who exported which report with which parameters, in which format). */
  for (const format of ['csv', 'xlsx'] as const) app.get(`/:key/export.${format}`, async (req, reply) => {
    const key = reportKey(req);
    const a = tenantActor(req);
    const { def, params, today, columns, rows, totals, scope, excluded } = await a.tx((db) => runReport(db, a.tenantId, key, req.query, viewer(a), { reveal: true }));
    await a.tx((db) => audit(db, { ...a.auditBase, userAgent: readDevice(req).userAgent, action: 'reports.exported', category: 'access', targetType: 'report', targetId: def.key, metadata: { params, scope, rows: rows.length, format, excluded: excluded ?? 0 } }));
    reply.header('x-excluded-subjects', String(excluded ?? 0));
    return format === 'csv' ? sendCsv(reply, `${def.key}-${today}`, columns, rows, totals) : sendXlsx(reply, `${def.key}-${today}`, def.name, columns, rows, totals);
  });
}
