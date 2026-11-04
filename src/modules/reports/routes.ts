import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantActor, requireFeature, type TenantActor } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { badRequest, forbidden, notFound } from '../../core/http/errors.js';
import { csv } from '../../core/http/csv.js';
import { evaluateFeatures } from '../../core/features/state.js';
import { orgToday } from '../competency/service.js';
import { teamEmployeeIds } from '../attendance/service.js';
import { MAX_ROWS, REPORTS, REPORT_MAP, resolveParams, type ReportDef } from './registry.js';

/** 'all' (organization-wide), 'team' (the caller's reporting chain) or null (no access). */
function scopeOf(r: ReportDef, a: TenantActor): 'all' | 'team' | null {
  if (r.access.all.some((p) => a.has(p))) return 'all';
  if (a.user.employeeId && r.access.team?.some((p) => a.has(p))) return 'team';
  return null;
}

/** Permissions that can open at least one report (the UI shows the Reports menu for these). */
export const REPORT_PERMISSIONS = [...new Set(REPORTS.flatMap((r) => [...r.access.all, ...(r.access.team ?? [])]))];

export async function reportRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    const a = tenantActor(req);
    return a.tx(async (db) => {
      const features = await evaluateFeatures(db, a.tenantId);
      const today = await orgToday(db, a.tenantId);
      const items = [];
      for (const r of REPORTS) {
        const scope = scopeOf(r, a);
        if (!scope || (r.feature && !features.get(r.feature)?.usable)) continue;
        const params = [];
        for (const p of r.params) params.push({ key: p.key, label: p.label, type: p.type, options: p.options, min: p.min, max: p.max, default: await p.default({ db, tenantId: a.tenantId, today }) });
        items.push({ key: r.key, name: r.name, description: r.description, category: r.category, scope, params });
      }
      return { items, today };
    });
  });

  async function execute(req: FastifyRequest) {
    const a = tenantActor(req);
    const { key } = z.object({ key: z.string().max(60) }).parse(req.params);
    const def = REPORT_MAP.get(key);
    if (!def) throw notFound('Report not found');
    const scope = scopeOf(def, a);
    if (!scope) throw forbidden();
    return a.tx(async (db) => {
      if (def.feature) await requireFeature(db, a.tenantId, def.feature);
      const today = await orgToday(db, a.tenantId);
      const { params, error } = await resolveParams(def, req.query, { db, tenantId: a.tenantId, today });
      if (error) throw badRequest(error);
      const team = scope === 'team' ? await teamEmployeeIds(db, a.tenantId, a.user.employeeId!) : null;
      const out = await def.run({ db, tenantId: a.tenantId, today, team, has: a.has }, params);
      const truncated = out.rows.length > MAX_ROWS;
      if (truncated) out.rows = out.rows.slice(0, MAX_ROWS);
      if (scope === 'team') out.notes.unshift('Your reporting team only.');
      if (truncated) out.notes.unshift(`Only the first ${MAX_ROWS} rows are shown; narrow the period or filters.`);
      return { a, def, scope, params, today, truncated, ...out };
    });
  }

  app.get('/:key', async (req) => {
    const { a: _a, def, ...r } = await execute(req);
    return { key: def.key, name: def.name, generatedAt: new Date().toISOString(), ...r };
  });

  /** CSV export: audited (who exported which report with which parameters). */
  app.get('/:key/export.csv', async (req, reply) => {
    const { a, def, params, today, columns, rows, totals, scope } = await execute(req);
    await a.tx((db) => audit(db, { ...a.auditBase, action: 'reports.exported', category: 'access', targetType: 'report', targetId: def.key, metadata: { params, scope, rows: rows.length } }));
    const cell = (type: string, v: unknown) => (v == null ? '' : type === 'money' ? Number(v).toFixed(2) : v);
    const lines: unknown[][] = [columns.map((c) => c.label), ...rows.map((r) => columns.map((c) => cell(c.type, r[c.key])))];
    if (totals) lines.push(columns.map((c, i) => (i === 0 ? 'Total' : cell(c.type, totals[c.key]))));
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${def.key}-${today}.csv"`)
      .header('cache-control', 'private, no-store').send('﻿' + csv(lines));
  });
}
