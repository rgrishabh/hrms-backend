import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../core/audit/audit.js';
import { tenantActor, tenantActorAny, type TenantActor } from '../../core/http/context.js';
import { AppError, badRequest, forbidden, notFound } from '../../core/http/errors.js';
import { PageQuery, Uuid, offsetOf, paged } from '../../core/http/pagination.js';
import { auditL4, holdsL4, l4RowFilter, policyViewer, readContext, subjectVisible } from '../../core/policy/salary.js';
import { getSettingValue } from '../../core/settings/service.js';
import { localDate } from '../attendance/time.js';
import { AUDIT_LOG_NOTE, CARVE_OUT_BASIS, NOT_LEGAL_ADVICE } from './map.js';
import {
  assertReachable,
  EXPORT_SECTIONS,
  erasureFollowUp,
  executeErasure,
  exportSection,
  finishFiles,
  l4Fields,
  loadEmployee,
  publicRequest,
  refusalFor,
  REQUEST_COLS,
  type Actor,
  type ErasureRow,
  type ExportSection,
  type ExportView,
} from './service.js';

const IdParams = z.object({ id: Uuid });
const ExportQuery = z.object({
  section: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  offset: z.coerce.number().int().min(0).default(0),
});
const CreateBody = z.object({ subjectType: z.enum(['employee', 'candidate']), subjectId: Uuid, reason: z.string().trim().max(1000).optional() });
const DecideBody = z.object({ note: z.string().trim().max(1000).optional() });
const ListQuery = PageQuery.extend({ status: z.enum(['pending', 'rejected', 'retained', 'completed']).optional() });

const actorOf = (a: TenantActor): Actor => ({
  tenantId: a.tenantId,
  userId: a.user.userId,
  employeeId: a.user.employeeId,
  level: a.user.salaryLevel,
  roles: a.user.roles,
  auditBase: a.auditBase,
});

/** DPDP data rights: export, erasure on request, retention periods. docs/DATA_RIGHTS.md. Always on, since a module being off keeps its data. */
export async function dataRightsRoutes(app: FastifyInstance) {
  /**
   * Everything held about a person, across every module, on or off. Self, or HR above them. Each section is one page of `limit` rows; a section with more says `nextOffset`, and `?section=` asks for
   * that section alone. L4 goes only to someone who may see it, and each answer carrying it is audited.
   */
  app.get(
    '/employees/:id/export',
    { schema: { params: IdParams, querystring: ExportQuery }, config: { permAny: ['profile.self', 'employees.manage', 'data_rights.execute'] } },
    async (req) => {
      const a = tenantActorAny(req, 'profile.self', 'employees.manage', 'data_rights.execute');
      const { id } = IdParams.parse(req.params);
      const q = ExportQuery.parse(req.query);
      const only = q.section ? EXPORT_SECTIONS.find((s) => s.section === q.section) : undefined;
      if (q.section && !only) throw badRequest(`Unknown section '${q.section}'`);
      return a.tx(async (db) => {
        const v = await policyViewer(db, a.tenantId, a.user);
        const self = a.user.employeeId === id;
        // HR above them; or whoever would carry out their erasure, since someone must be able to answer for HR's own data.
        if (!self && !a.has('employees.manage') && !a.has('data_rights.execute')) throw notFound('Employee not found');
        if (!self) await assertReachable(db, actorOf(a), id);
        const e = await loadEmployee(db, a.tenantId, id);
        if (!e) throw notFound('Employee not found');
        const view: ExportView = { self, mayL3: true, mayL4: self || (holdsL4(v) && (await subjectVisible(db, a.tenantId, v, id, l4RowFilter))) };
        const sections: ExportSection[] = [];
        for (const t of only ? [only] : EXPORT_SECTIONS) sections.push(await exportSection(db, a.tenantId, t, { id: e.id, userId: e.userId }, view, q.limit, only ? q.offset : 0));
        await audit(db, {
          ...a.auditBase,
          action: 'data_rights.exported',
          category: 'access',
          targetType: 'employee',
          targetId: id,
          userAgent: a.userAgent,
          metadata: { self, section: q.section ?? 'all', offset: q.offset, rows: sections.reduce((n, s) => n + s.rows.length, 0) },
        });
        const fields = l4Fields(sections, view);
        if (fields.length) await auditL4(db, readContext(req, a), 'export', 'data-rights.export', [{ employeeId: id, fields }]);
        return {
          subject: { type: 'employee', id },
          generatedAt: new Date().toISOString(),
          complete: sections.every((s) => s.nextOffset === null),
          l4Included: view.mayL4,
          note: 'File contents are not in this export: each file is listed with its name. PAN and Aadhaar appear by their last four characters, and the bank account number by its last four digits.',
          sections,
        };
      });
    },
  );

  /** A candidate has no account and no level: whoever runs recruitment or HR. Works with recruitment off, since the data stays. */
  app.get('/candidates/:id/export', { schema: { params: IdParams }, config: { permAny: ['recruitment.manage', 'data_rights.manage'] } }, async (req) => {
    const a = tenantActorAny(req, 'recruitment.manage', 'data_rights.manage');
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      const c = (
        await db.query<Record<string, unknown>>(
          `SELECT id, first_name, last_name, email, phone, source, current_company, current_designation, experience_months, notice_days, location, qualification, resume_name, consent_at, consent_note, retain_until, status, created_at
        ${a.has('recruitment.compensation') || a.has('data_rights.execute') ? ', expected_ctc' : ''} FROM candidates WHERE tenant_id=$1 AND id=$2`,
          [a.tenantId, id],
        )
      ).rows[0];
      if (!c) throw notFound('Candidate not found');
      const applications = (
        await db.query(
          `SELECT ap.id, q.title, ap.stage, ap.rejection_reason, ap.created_at FROM job_applications ap JOIN job_requisitions q ON q.tenant_id=ap.tenant_id AND q.id=ap.requisition_id WHERE ap.tenant_id=$1 AND ap.candidate_id=$2 ORDER BY ap.created_at`,
          [a.tenantId, id],
        )
      ).rows;
      await audit(db, {
        ...a.auditBase,
        action: 'data_rights.exported',
        category: 'access',
        targetType: 'candidate',
        targetId: id,
        userAgent: a.userAgent,
        metadata: { applications: applications.length },
      });
      return { subject: { type: 'candidate', id }, generatedAt: new Date().toISOString(), complete: true, candidate: c, applications };
    });
  });

  /** The periods in force and what they rest on. */
  app.get('/retention', { schema: {}, config: { permAny: ['settings.read', 'data_rights.manage'] } }, async (req) => {
    const a = tenantActorAny(req, 'settings.read', 'data_rights.manage');
    return a.tx(async (db) => {
      // One after another: a connection runs one query at a time.
      const carveOuts = [];
      for (const [category, b] of Object.entries(CARVE_OUT_BASIS))
        carveOuts.push({ category, label: b.label, years: await getSettingValue<number>(db, a.tenantId, b.setting), basis: b.basis, setting: b.setting });
      return { carveOuts, auditLog: AUDIT_LOG_NOTE, notLegalAdvice: NOT_LEGAL_ADVICE };
    });
  });

  /**
   * Raising a request. The person themselves, or HR. Asking twice answers with the same request. Someone still employed is refused here, with the reason, as well as when it is carried out.
   */
  app.post('/erasure-requests', { schema: { body: CreateBody }, config: { permAny: ['profile.self', 'data_rights.manage'] } }, async (req, reply) => {
    const a = tenantActorAny(req, 'profile.self', 'data_rights.manage');
    const b = CreateBody.parse(req.body);
    const self = b.subjectType === 'employee' && a.user.employeeId === b.subjectId;
    if (!self && !a.has('data_rights.manage')) throw forbidden();
    return a.tx(async (db) => {
      if (b.subjectType === 'employee') {
        if (!self) await assertReachable(db, actorOf(a), b.subjectId);
        const e = await loadEmployee(db, a.tenantId, b.subjectId);
        if (!e) throw notFound('Person not found');
        const refusal = refusalFor(e);
        if (refusal) throw new AppError(409, 'erasure_refused', refusal);
      } else if (!(await db.query('SELECT 1 FROM candidates WHERE tenant_id=$1 AND id=$2', [a.tenantId, b.subjectId])).rowCount) throw notFound('Person not found');
      const created = (
        await db.query<ErasureRow>(
          `INSERT INTO erasure_requests (tenant_id, subject_type, subject_id, reason, requested_by) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (tenant_id, subject_type, subject_id) WHERE status <> 'rejected' DO NOTHING RETURNING ${REQUEST_COLS}`,
          [a.tenantId, b.subjectType, b.subjectId, b.reason ?? null, a.user.userId],
        )
      ).rows[0];
      if (!created) {
        const existing = (
          await db.query<ErasureRow>(`SELECT ${REQUEST_COLS} FROM erasure_requests WHERE tenant_id=$1 AND subject_type=$2 AND subject_id=$3 AND status <> 'rejected'`, [
            a.tenantId,
            b.subjectType,
            b.subjectId,
          ])
        ).rows[0]!;
        return publicRequest(existing);
      }
      await audit(db, {
        ...a.auditBase,
        action: 'data_rights.erasure_requested',
        category: 'security',
        targetType: b.subjectType,
        targetId: b.subjectId,
        metadata: { requestId: created.id, self },
      });
      reply.code(201);
      return publicRequest(created);
    });
  });

  app.get('/erasure-requests', { schema: { querystring: ListQuery }, config: { permAny: ['data_rights.manage', 'data_rights.execute'] } }, async (req) => {
    const a = tenantActorAny(req, 'data_rights.manage', 'data_rights.execute');
    const q = ListQuery.parse(req.query);
    return a.tx(async (db) => {
      const where = `tenant_id=$1${q.status ? ' AND status=$2' : ''}`;
      const p: unknown[] = q.status ? [a.tenantId, q.status] : [a.tenantId];
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM erasure_requests WHERE ${where}`, p)).rows[0]!.n);
      const rows = (
        await db.query<ErasureRow>(
          `SELECT ${REQUEST_COLS} FROM erasure_requests WHERE ${where} ORDER BY created_at DESC LIMIT ${Number(q.pageSize)} OFFSET ${Number(offsetOf(q))}`,
          p,
        )
      ).rows;
      return paged(rows.map(publicRequest), total, q);
    });
  });

  app.get('/erasure-requests/:id', { schema: { params: IdParams }, config: { permAny: ['data_rights.manage', 'data_rights.execute', 'profile.self'] } }, async (req) => {
    const a = tenantActorAny(req, 'data_rights.manage', 'data_rights.execute', 'profile.self');
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      const r = (await db.query<ErasureRow>(`SELECT ${REQUEST_COLS} FROM erasure_requests WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id])).rows[0];
      if (!r) throw notFound();
      if (!a.has('data_rights.manage') && !a.has('data_rights.execute') && r.requested_by !== a.user.userId) throw notFound();
      return publicRequest(r);
    });
  });

  /** Carries it out, and answers with what was erased and what stays, until when. Repeating it answers the same. */
  app.post('/erasure-requests/:id/execute', { schema: { params: IdParams, body: DecideBody }, config: { perm: ['data_rights.execute'] } }, async (req) => {
    const a = tenantActor(req, 'data_rights.execute');
    const { id } = IdParams.parse(req.params);
    const { note } = DecideBody.parse(req.body);
    const tz = req.server.deps.env.BRAND_TIMEZONE;
    const { row, alreadyDone } = await a.tx(async (db) => {
      const r = (await db.query<ErasureRow>(`SELECT ${REQUEST_COLS} FROM erasure_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [a.tenantId, id])).rows[0];
      if (!r) throw notFound();
      const today = localDate(new Date(), tz);
      const out = await executeErasure(db, r, actorOf(a), today, note);
      // Anything whose period has already run out goes now rather than at tonight's job.
      if (!out.alreadyDone && out.row.status === 'retained' && out.row.report!.retained.some((c) => c.until <= today)) {
        await erasureFollowUp(db, a.tenantId, today);
        return { row: (await db.query<ErasureRow>(`SELECT ${REQUEST_COLS} FROM erasure_requests WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id])).rows[0]!, alreadyDone: false };
      }
      return out;
    });
    const finished = await finishFiles(a, a.tenantId, row, (e) => {
      req.log.error({ err: e.message }, 'erased file could not be deleted');
    });
    return { ...publicRequest(finished), alreadyDone };
  });

  app.post('/erasure-requests/:id/reject', { schema: { params: IdParams, body: DecideBody }, config: { perm: ['data_rights.execute'] } }, async (req) => {
    const a = tenantActor(req, 'data_rights.execute');
    const { id } = IdParams.parse(req.params);
    const { note } = DecideBody.parse(req.body);
    return a.tx(async (db) => {
      const r = (
        await db.query<ErasureRow>(
          `UPDATE erasure_requests SET status='rejected', decided_by=$3, decided_at=now(), decision_note=$4 WHERE tenant_id=$1 AND id=$2 AND status='pending' RETURNING ${REQUEST_COLS}`,
          [a.tenantId, id, a.user.userId, note ?? null],
        )
      ).rows[0];
      if (!r) throw notFound('No pending request');
      await audit(db, {
        ...a.auditBase,
        action: 'data_rights.erasure_rejected',
        category: 'security',
        targetType: r.subject_type,
        targetId: r.subject_id,
        metadata: { requestId: r.id },
      });
      return publicRequest(r);
    });
  });
}
