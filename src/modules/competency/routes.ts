import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantActor, tenantActorAny, requireFeature, type TenantActor } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { IsoDate, PageQuery, offsetOf, paged, Uuid } from '../../core/http/pagination.js';
import { createApprovalRequest, registerApprovalHandler, cancelRequest } from '../../core/workflow/engine.js';
import { getSettingValue } from '../../core/settings/service.js';
import { daysBetween } from '../attendance/time.js';
import type { Db } from '../../db/tx.js';
import {
  ACTIVITIES, ACTIVITY_LABEL, addEvent, checkAuthorization, describe, loadAuthorization, missingPrerequisites, notifyEmployee, orgToday,
} from './service.js';

const Code = (max: number, re: RegExp) => z.string().trim().toUpperCase().regex(re).max(max);
const Text = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v || null);
const CourseBody = z.object({
  code: Code(30, /^[A-Z][A-Z0-9_-]*$/), name: z.string().trim().min(2).max(150),
  kind: z.enum(['induction', 'safety', 'method', 'instrument', 'quality', 'external', 'other']),
  description: Text(500), validityMonths: z.number().int().min(1).max(120).nullable().default(null), status: z.enum(['active', 'inactive']).default('active'),
});
const MethodBody = z.object({
  code: Code(40, /^[A-Z][A-Z0-9_./-]*$/), name: z.string().trim().min(2).max(200), standardRef: Text(200), discipline: Text(80), matrix: Text(80),
  branchId: Uuid.nullable().default(null), reviewMonths: z.number().int().min(1).max(60).default(12), status: z.enum(['active', 'inactive']).default('active'),
  requiredCourseIds: z.array(Uuid).max(30).default([]),
});
const Activity = z.enum(ACTIVITIES);
const Reason = z.object({ reason: z.string().trim().min(3).max(1000) });

/** Own employee id, or a 404-style refusal when reading someone else's records without permission. */
function scopeEmployee(a: TenantActor, employeeId: string | undefined, ...readPerms: string[]) {
  if (readPerms.some((p) => a.has(p))) return employeeId;
  if (!a.has('competency.self') || !a.user.employeeId) throw forbidden();
  if (employeeId && employeeId !== a.user.employeeId) throw notFound('Employee not found');
  return a.user.employeeId;
}

async function assertEmployee(db: Db, tenantId: string, employeeId: string) {
  const e = (await db.query<{ user_id: string | null; name: string }>(`SELECT user_id, trim(first_name||' '||coalesce(last_name,'')) AS name FROM employees WHERE tenant_id=$1 AND id=$2`, [tenantId, employeeId])).rows[0];
  if (!e) throw notFound('Employee not found');
  return e;
}

/** The person acting must not be the person whose competence is being recorded or decided. */
function notSelf(a: TenantActor, employeeId: string, what: string) {
  if (a.user.employeeId === employeeId) throw forbidden(`You cannot ${what} for yourself`);
}

export async function competencyRoutes(app: FastifyInstance) {
  registerApprovalHandler('lab_authorization', {
    feature: 'lab.competency', label: 'Technical authorization', requesterLink: '/competency',
    async onApproved(db, tenantId, id, actorId) {
      const a = await loadAuthorization(db, tenantId, id, true);
      if (!a || a.status !== 'pending') throw conflict('This authorization is no longer pending');
      if (a.employee_user_id === actorId) throw forbidden('You cannot grant a technical authorization to yourself');
      const today = await orgToday(db, tenantId);
      const missing = await missingPrerequisites(db, tenantId, a.employee_id, a.method_id, today);
      if (missing.length) throw new AppError(409, 'prerequisites_missing', `Required training is not valid: ${missing.map((m) => m.code).join(', ')}`, { missing });
      // A renewal supersedes the authorization currently in force.
      const prev = await db.query<{ id: string }>(`UPDATE lab_authorizations SET status='superseded', ended_at=now(), end_reason='Renewed'
          WHERE tenant_id=$1 AND employee_id=$2 AND method_id=$3 AND activity=$4 AND status IN ('authorized','suspended') RETURNING id`,
        [tenantId, a.employee_id, a.method_id, a.activity]);
      for (const p of prev.rows) await addEvent(db, tenantId, p.id, 'superseded', actorId, 'Renewed');
      const r = (await db.query<{ review_due: string }>(`UPDATE lab_authorizations SET status='authorized', authorized_by=$3, authorized_at=now(), valid_from=$4::date,
          review_due=($4::date + make_interval(months => $5))::date WHERE tenant_id=$1 AND id=$2 RETURNING review_due::text`,
        [tenantId, id, actorId, today, a.review_months])).rows[0]!;
      await addEvent(db, tenantId, id, 'authorized', actorId);
      await notifyEmployee(db, tenantId, a, `You are authorized: ${describe(a)}`, `Valid from ${today}; periodic review due ${r.review_due}.`);
    },
    async onRejected(db, tenantId, id, actorId, status) {
      await db.query(`UPDATE lab_authorizations SET status=$3, ended_at=now() WHERE tenant_id=$1 AND id=$2 AND status='pending'`,
        [tenantId, id, status === 'cancelled' ? 'cancelled' : 'rejected']);
      await addEvent(db, tenantId, id, status, actorId);
    },
  });

  // ------------------------------------------------------------ courses (feature: training)
  app.get('/courses', async (req) => {
    const a = tenantActorAny(req, 'training.manage', 'competency.read', 'competency.manage', 'competency.self');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'training');
      return { items: (await db.query(`SELECT c.id, c.code, c.name, c.kind, c.description, c.validity_months, c.status,
          (SELECT count(*)::int FROM training_records t WHERE t.tenant_id=c.tenant_id AND t.course_id=c.id AND t.status='active') AS records
        FROM training_courses c WHERE c.tenant_id=$1 ORDER BY c.status, c.code`, [a.tenantId])).rows };
    });
  });
  const courseCols = (b: z.infer<typeof CourseBody>) => [b.code, b.name, b.kind, b.description, b.validityMonths, b.status];
  app.post('/courses', async (req, reply) => {
    const a = tenantActor(req, 'training.manage');
    const b = CourseBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'training');
      const id = (await db.query<{ id: string }>(`INSERT INTO training_courses (tenant_id, code, name, kind, description, validity_months, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [a.tenantId, ...courseCols(b)])).rows[0]!.id;
      await audit(db, { ...a.auditBase, action: 'training.course_created', category: 'configuration', targetType: 'training_course', targetId: id, metadata: b });
      reply.code(201); return { id };
    });
  });
  app.put('/courses/:id', async (req) => {
    const a = tenantActor(req, 'training.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const b = CourseBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'training');
      const r = await db.query(`UPDATE training_courses SET code=$3, name=$4, kind=$5, description=$6, validity_months=$7, status=$8 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, ...courseCols(b)]);
      if (!r.rowCount) throw notFound();
      // Validity changes apply to records made from now on; existing expiry dates are evidence and stay as recorded.
      await audit(db, { ...a.auditBase, action: 'training.course_updated', category: 'configuration', targetType: 'training_course', targetId: id, metadata: b });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ training records
  app.get('/training-records', async (req) => {
    const a = tenantActor(req);
    const q = PageQuery.extend({ employeeId: Uuid.optional(), courseId: Uuid.optional(), expiringWithinDays: z.coerce.number().int().min(0).max(365).optional(),
      includeRevoked: z.coerce.boolean().default(false) }).parse(req.query);
    const employeeId = scopeEmployee(a, q.employeeId, 'training.manage', 'competency.read');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'training');
      const today = await orgToday(db, a.tenantId);
      const where = `t.tenant_id=$1 AND ($2::uuid IS NULL OR t.employee_id=$2) AND ($3::uuid IS NULL OR t.course_id=$3) AND ($4 OR t.status='active')
        AND ($5::int IS NULL OR (t.expires_on IS NOT NULL AND t.expires_on <= $6::date + $5::int AND t.status='active'))`;
      const args = [a.tenantId, employeeId ?? null, q.courseId ?? null, q.includeRevoked, q.expiringWithinDays ?? null, today];
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM training_records t WHERE ${where}`, args)).rows[0]!.n);
      const rows = (await db.query(`SELECT t.id, t.employee_id, e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS employee_name, t.course_id, c.code AS course_code,
          c.name AS course_name, t.completed_on::text, t.expires_on::text, t.result, t.trainer, t.provider, t.hours, t.notes, t.status, t.revoked_reason, t.created_at,
          CASE WHEN t.status<>'active' THEN 'revoked' WHEN t.result='failed' THEN 'failed' WHEN t.expires_on IS NULL THEN 'valid'
               WHEN t.expires_on < $6::date THEN 'expired' WHEN t.expires_on <= $6::date + 30 THEN 'expiring' ELSE 'valid' END AS validity
        FROM training_records t JOIN employees e ON e.tenant_id=t.tenant_id AND e.id=t.employee_id JOIN training_courses c ON c.tenant_id=t.tenant_id AND c.id=t.course_id
        WHERE ${where} ORDER BY t.expires_on NULLS LAST, t.completed_on DESC LIMIT ${q.pageSize} OFFSET ${offsetOf(q)}`, args)).rows;
      return paged(rows, total, q);
    });
  });

  app.post('/training-records', async (req, reply) => {
    const a = tenantActor(req, 'training.manage');
    const b = z.object({
      employeeId: Uuid, courseId: Uuid, completedOn: IsoDate, result: z.enum(['completed', 'passed', 'failed']),
      trainer: Text(150), provider: Text(150), hours: z.number().positive().max(9999).multipleOf(0.1).nullable().default(null), notes: Text(1000),
    }).parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'training');
      await assertEmployee(db, a.tenantId, b.employeeId);
      if (b.completedOn > await orgToday(db, a.tenantId)) throw badRequest('Completion date cannot be in the future');
      const c = (await db.query<{ validity_months: number | null; status: string }>('SELECT validity_months, status FROM training_courses WHERE tenant_id=$1 AND id=$2', [a.tenantId, b.courseId])).rows[0];
      if (!c) throw notFound('Course not found');
      if (c.status !== 'active') throw conflict('This course is inactive');
      const r = (await db.query<{ id: string; expires_on: string | null }>(`INSERT INTO training_records (tenant_id, employee_id, course_id, completed_on, expires_on, result, trainer, provider, hours, notes, recorded_by)
          VALUES ($1,$2,$3,$4::date, CASE WHEN $5::int IS NULL OR $6='failed' THEN NULL ELSE ($4::date + make_interval(months => $5::int))::date END, $6,$7,$8,$9,$10,$11)
          RETURNING id, expires_on::text`,
        [a.tenantId, b.employeeId, b.courseId, b.completedOn, c.validity_months, b.result, b.trainer, b.provider, b.hours, b.notes, a.user.userId])).rows[0]!;
      await audit(db, { ...a.auditBase, action: 'training.recorded', category: 'data', targetType: 'training_record', targetId: r.id, metadata: { ...b, expiresOn: r.expires_on } });
      reply.code(201); return { id: r.id, expiresOn: r.expires_on };
    });
  });

  app.post('/training-records/:id/revoke', async (req) => {
    const a = tenantActor(req, 'training.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const { reason } = Reason.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'training');
      const r = await db.query(`UPDATE training_records SET status='revoked', revoked_reason=$3 WHERE tenant_id=$1 AND id=$2 AND status='active'`, [a.tenantId, id, reason]);
      if (!r.rowCount) throw notFound('Active training record not found');
      await audit(db, { ...a.auditBase, action: 'training.revoked', category: 'data', targetType: 'training_record', targetId: id, metadata: { reason } });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ methods (feature: lab.competency)
  app.get('/methods', async (req) => {
    const a = tenantActorAny(req, 'competency.read', 'competency.manage', 'competency.assess', 'competency.self');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'lab.competency');
      return { items: (await db.query(`SELECT m.id, m.code, m.name, m.standard_ref, m.discipline, m.matrix, m.branch_id, b.name AS branch_name, m.review_months, m.status,
          coalesce((SELECT json_agg(json_build_object('id', c.id, 'code', c.code, 'name', c.name) ORDER BY c.code) FROM lab_method_requirements r
            JOIN training_courses c ON c.tenant_id=r.tenant_id AND c.id=r.course_id WHERE r.tenant_id=m.tenant_id AND r.method_id=m.id), '[]') AS requirements
        FROM lab_methods m LEFT JOIN branches b ON b.tenant_id=m.tenant_id AND b.id=m.branch_id
        WHERE m.tenant_id=$1 ORDER BY m.status, m.discipline NULLS LAST, m.code`, [a.tenantId])).rows };
    });
  });
  async function saveMethod(db: Db, a: TenantActor, b: z.infer<typeof MethodBody>, id?: string) {
    if (b.requiredCourseIds.length) {
      const ok = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM training_courses WHERE tenant_id=$1 AND id = ANY($2::uuid[])`, [a.tenantId, b.requiredCourseIds])).rows[0]!.n);
      if (ok !== new Set(b.requiredCourseIds).size) throw badRequest('Unknown training course in requirements');
    }
    const cols = [b.code, b.name, b.standardRef, b.discipline, b.matrix, b.branchId, b.reviewMonths, b.status];
    if (id) {
      const r = await db.query(`UPDATE lab_methods SET code=$3, name=$4, standard_ref=$5, discipline=$6, matrix=$7, branch_id=$8, review_months=$9, status=$10
        WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, ...cols]);
      if (!r.rowCount) throw notFound();
      await db.query('DELETE FROM lab_method_requirements WHERE tenant_id=$1 AND method_id=$2', [a.tenantId, id]);
    } else {
      id = (await db.query<{ id: string }>(`INSERT INTO lab_methods (tenant_id, code, name, standard_ref, discipline, matrix, branch_id, review_months, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [a.tenantId, ...cols])).rows[0]!.id;
    }
    for (const c of new Set(b.requiredCourseIds)) await db.query('INSERT INTO lab_method_requirements (tenant_id, method_id, course_id) VALUES ($1,$2,$3)', [a.tenantId, id, c]);
    return id;
  }
  app.post('/methods', async (req, reply) => {
    const a = tenantActor(req, 'competency.manage');
    const b = MethodBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'lab.competency');
      const id = await saveMethod(db, a, b);
      await audit(db, { ...a.auditBase, action: 'competency.method_created', category: 'configuration', targetType: 'lab_method', targetId: id, metadata: b });
      reply.code(201); return { id };
    });
  });
  app.put('/methods/:id', async (req) => {
    const a = tenantActor(req, 'competency.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const b = MethodBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'lab.competency');
      await saveMethod(db, a, b, id);
      // New requirements take effect immediately: authorizations whose holders lack them stop being "in force" (see /check).
      await audit(db, { ...a.auditBase, action: 'competency.method_updated', category: 'configuration', targetType: 'lab_method', targetId: id, metadata: b });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ assessments
  app.get('/assessments', async (req) => {
    const a = tenantActor(req);
    const q = PageQuery.extend({ employeeId: Uuid.optional(), methodId: Uuid.optional() }).parse(req.query);
    const employeeId = scopeEmployee(a, q.employeeId, 'competency.read', 'competency.assess');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'lab.competency');
      const where = 's.tenant_id=$1 AND ($2::uuid IS NULL OR s.employee_id=$2) AND ($3::uuid IS NULL OR s.method_id=$3)';
      const args = [a.tenantId, employeeId ?? null, q.methodId ?? null];
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM competency_assessments s WHERE ${where}`, args)).rows[0]!.n);
      const rows = (await db.query(`SELECT s.id, s.employee_id, trim(e.first_name||' '||coalesce(e.last_name,'')) AS employee_name, e.employee_code, s.method_id, m.code AS method_code,
          m.name AS method_name, s.activity, s.approach, s.assessed_on::text, s.result, s.evidence, u.display_name AS assessor_name, s.created_at,
          EXISTS (SELECT 1 FROM lab_authorizations z WHERE z.tenant_id=s.tenant_id AND z.assessment_id=s.id) AS used
        FROM competency_assessments s JOIN employees e ON e.tenant_id=s.tenant_id AND e.id=s.employee_id JOIN lab_methods m ON m.tenant_id=s.tenant_id AND m.id=s.method_id
        JOIN users u ON u.id=s.assessor_id WHERE ${where} ORDER BY s.assessed_on DESC, s.created_at DESC LIMIT ${q.pageSize} OFFSET ${offsetOf(q)}`, args)).rows;
      return paged(rows, total, q);
    });
  });

  app.post('/assessments', async (req, reply) => {
    const a = tenantActor(req, 'competency.assess');
    const b = z.object({
      employeeId: Uuid, methodId: Uuid, activity: Activity, assessedOn: IsoDate,
      approach: z.enum(['witnessed', 'replicate', 'retained_sample', 'proficiency_test', 'interlab_comparison', 'written', 'other']),
      result: z.enum(['competent', 'not_yet_competent']), evidence: z.string().trim().min(3).max(2000),
    }).parse(req.body);
    notSelf(a, b.employeeId, 'record a competency assessment');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'lab.competency');
      await assertEmployee(db, a.tenantId, b.employeeId);
      if (b.assessedOn > await orgToday(db, a.tenantId)) throw badRequest('Assessment date cannot be in the future');
      const m = (await db.query<{ status: string }>('SELECT status FROM lab_methods WHERE tenant_id=$1 AND id=$2', [a.tenantId, b.methodId])).rows[0];
      if (!m) throw notFound('Method not found');
      if (m.status !== 'active') throw conflict('This method is inactive');
      const id = (await db.query<{ id: string }>(`INSERT INTO competency_assessments (tenant_id, employee_id, method_id, activity, approach, assessed_on, result, evidence, assessor_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [a.tenantId, b.employeeId, b.methodId, b.activity, b.approach, b.assessedOn, b.result, b.evidence, a.user.userId])).rows[0]!.id;
      await audit(db, { ...a.auditBase, action: 'competency.assessed', category: 'data', targetType: 'competency_assessment', targetId: id, metadata: b });
      reply.code(201); return { id };
    });
  });

  // ------------------------------------------------------------ authorizations
  app.post('/authorizations', async (req, reply) => {
    const a = tenantActor(req, 'competency.assess');
    const { assessmentId } = z.object({ assessmentId: Uuid }).parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'lab.competency');
      const s = (await db.query<{ employee_id: string; method_id: string; activity: (typeof ACTIVITIES)[number]; result: string; assessed_on: string; method_status: string; method_code: string; method_name: string }>(
        `SELECT s.employee_id, s.method_id, s.activity, s.result, s.assessed_on::text, m.status AS method_status, m.code AS method_code, m.name AS method_name
           FROM competency_assessments s JOIN lab_methods m ON m.tenant_id=s.tenant_id AND m.id=s.method_id WHERE s.tenant_id=$1 AND s.id=$2`, [a.tenantId, assessmentId])).rows[0];
      if (!s) throw notFound('Assessment not found');
      notSelf(a, s.employee_id, 'request a technical authorization');
      if (s.result !== 'competent') throw conflict('The assessment did not find the person competent');
      if (s.method_status !== 'active') throw conflict('This method is inactive');
      const today = await orgToday(db, a.tenantId);
      const maxAge = await getSettingValue<number>(db, a.tenantId, 'competency.assessment_validity_days');
      if (daysBetween(s.assessed_on, today) > maxAge) throw conflict(`The assessment is older than ${maxAge} days; record a new assessment`);
      const newer = await db.query(`SELECT 1 FROM competency_assessments WHERE tenant_id=$1 AND employee_id=$2 AND method_id=$3 AND activity=$4 AND assessed_on > $5::date AND result='not_yet_competent'`,
        [a.tenantId, s.employee_id, s.method_id, s.activity, s.assessed_on]);
      if (newer.rowCount) throw conflict('A later assessment found the person not yet competent');
      const missing = await missingPrerequisites(db, a.tenantId, s.employee_id, s.method_id, today);
      if (missing.length) throw new AppError(409, 'prerequisites_missing', `Required training is not valid: ${missing.map((m) => m.code).join(', ')}`, { missing });
      const emp = await assertEmployee(db, a.tenantId, s.employee_id);
      const id = (await db.query<{ id: string }>(`INSERT INTO lab_authorizations (tenant_id, employee_id, method_id, activity, assessment_id, requested_by)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [a.tenantId, s.employee_id, s.method_id, s.activity, assessmentId, a.user.userId])).rows[0]!.id;
      await addEvent(db, a.tenantId, id, 'requested', a.user.userId);
      const approvalId = await createApprovalRequest(db, a.tenantId, {
        entityType: 'lab_authorization', entityId: id, requesterId: a.user.userId,
        summary: `${emp.name}: ${ACTIVITY_LABEL[s.activity]} — ${s.method_code} ${s.method_name}`, steps: [{ kind: 'permission', permission: 'competency.authorize' }],
      });
      await audit(db, { ...a.auditBase, action: 'competency.authorization_requested', category: 'data', targetType: 'lab_authorization', targetId: id, metadata: { assessmentId, approvalId } });
      reply.code(201); return { id, approvalRequestId: approvalId };
    });
  });

  app.get('/authorizations', async (req) => {
    const a = tenantActor(req);
    const q = PageQuery.extend({ employeeId: Uuid.optional(), methodId: Uuid.optional(), status: z.enum(['pending', 'authorized', 'suspended', 'in_force', 'ended', 'review_due']).optional() }).parse(req.query);
    const employeeId = scopeEmployee(a, q.employeeId, 'competency.read', 'competency.authorize');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'lab.competency');
      const today = await orgToday(db, a.tenantId);
      const statusSql: Record<string, string> = {
        pending: "z.status='pending'", authorized: "z.status='authorized'", suspended: "z.status='suspended'", in_force: "z.status IN ('authorized','suspended')",
        ended: "z.status IN ('rejected','withdrawn','expired','superseded','cancelled')", review_due: "z.status='authorized' AND z.review_due <= $4::date + 30",
      };
      const where = `z.tenant_id=$1 AND ($2::uuid IS NULL OR z.employee_id=$2) AND ($3::uuid IS NULL OR z.method_id=$3) AND ${q.status ? statusSql[q.status] : 'true'} AND $4::date IS NOT NULL`;
      const args = [a.tenantId, employeeId ?? null, q.methodId ?? null, today];
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM lab_authorizations z WHERE ${where}`, args)).rows[0]!.n);
      const rows = (await db.query(`SELECT z.id, z.employee_id, e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS employee_name, z.method_id, m.code AS method_code,
          m.name AS method_name, m.standard_ref, z.activity, z.status, z.valid_from::text, z.review_due::text, z.authorized_at, z.ended_at, z.end_reason, z.created_at,
          ru.display_name AS requested_by_name, au.display_name AS authorized_by_name,
          (SELECT count(*)::int FROM lab_method_requirements r WHERE r.tenant_id=z.tenant_id AND r.method_id=z.method_id AND NOT EXISTS (
             SELECT 1 FROM training_records t WHERE t.tenant_id=r.tenant_id AND t.employee_id=z.employee_id AND t.course_id=r.course_id AND t.status='active'
               AND t.result IN ('completed','passed') AND t.completed_on <= $4::date AND (t.expires_on IS NULL OR t.expires_on >= $4::date))) AS missing_training
        FROM lab_authorizations z JOIN employees e ON e.tenant_id=z.tenant_id AND e.id=z.employee_id JOIN lab_methods m ON m.tenant_id=z.tenant_id AND m.id=z.method_id
        JOIN users ru ON ru.id=z.requested_by LEFT JOIN users au ON au.id=z.authorized_by
        WHERE ${where} ORDER BY e.first_name, m.code, z.activity, z.created_at DESC LIMIT ${q.pageSize} OFFSET ${offsetOf(q)}`, args)).rows;
      return paged(rows, total, q);
    });
  });

  app.get('/authorizations/:id', async (req) => {
    const a = tenantActor(req);
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'lab.competency');
      const z0 = await loadAuthorization(db, a.tenantId, id);
      if (!z0 || !(a.has('competency.read') || a.has('competency.authorize') || (a.has('competency.self') && z0.employee_id === a.user.employeeId))) throw notFound('Authorization not found');
      const events = (await db.query(`SELECT v.action, v.reason, v.at, u.display_name AS actor_name FROM lab_authorization_events v LEFT JOIN users u ON u.id=v.actor_id
        WHERE v.tenant_id=$1 AND v.authorization_id=$2 ORDER BY v.at, v.id`, [a.tenantId, id])).rows;
      const assessment = (await db.query(`SELECT s.approach, s.assessed_on::text, s.result, s.evidence, u.display_name AS assessor_name FROM lab_authorizations z
        JOIN competency_assessments s ON s.tenant_id=z.tenant_id AND s.id=z.assessment_id JOIN users u ON u.id=s.assessor_id WHERE z.tenant_id=$1 AND z.id=$2`, [a.tenantId, id])).rows[0];
      const check = ['authorized', 'suspended'].includes(z0.status) ? await checkAuthorization(db, a.tenantId, z0.employee_id, z0.method_id, z0.activity) : null;
      return { ...z0, employee_user_id: undefined, events, assessment, check };
    });
  });

  const transition = (action: 'suspend' | 'reinstate' | 'withdraw') => async (req: FastifyRequest) => {
    const a = tenantActor(req, 'competency.authorize');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const { reason } = Reason.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'lab.competency');
      const z0 = await loadAuthorization(db, a.tenantId, id, true);
      if (!z0) throw notFound('Authorization not found');
      notSelf(a, z0.employee_id, `${action} an authorization`);
      const from = { suspend: ['authorized'], reinstate: ['suspended'], withdraw: ['authorized', 'suspended'] }[action];
      if (!from.includes(z0.status)) throw conflict(`A ${z0.status} authorization cannot be ${action === 'withdraw' ? 'withdrawn' : action + 'ed'}`);
      if (action === 'reinstate') {
        const today = await orgToday(db, a.tenantId);
        if (z0.review_due && z0.review_due < today) throw conflict('The periodic review is overdue; renew the authorization with a new assessment instead');
        const missing = await missingPrerequisites(db, a.tenantId, z0.employee_id, z0.method_id, today);
        if (missing.length) throw new AppError(409, 'prerequisites_missing', `Required training is not valid: ${missing.map((m) => m.code).join(', ')}`, { missing });
      }
      const to = { suspend: 'suspended', reinstate: 'authorized', withdraw: 'withdrawn' }[action];
      await db.query(`UPDATE lab_authorizations SET status=$3, ended_at=CASE WHEN $3='withdrawn' THEN now() ELSE ended_at END,
          end_reason=CASE WHEN $3='withdrawn' THEN $4 ELSE end_reason END WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, to, reason]);
      const past = { suspend: 'suspended', reinstate: 'reinstated', withdraw: 'withdrawn' }[action];
      await addEvent(db, a.tenantId, id, past, a.user.userId, reason);
      await audit(db, { ...a.auditBase, action: `competency.authorization_${past}`, category: 'data', targetType: 'lab_authorization', targetId: id, metadata: { reason } });
      await notifyEmployee(db, a.tenantId, z0, `Your authorization was ${past}: ${describe(z0)}`, `Reason: ${reason.slice(0, 300)}`);
      return { ok: true, status: to };
    });
  };
  app.post('/authorizations/:id/suspend', transition('suspend'));
  app.post('/authorizations/:id/reinstate', transition('reinstate'));
  app.post('/authorizations/:id/withdraw', transition('withdraw'));

  app.post('/authorizations/:id/cancel', async (req) => {
    const a = tenantActor(req, 'competency.assess');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'lab.competency');
      const r = (await db.query<{ id: string }>(`SELECT id FROM approval_requests WHERE tenant_id=$1 AND entity_type='lab_authorization' AND entity_id=$2 AND status='pending'`, [a.tenantId, id])).rows[0];
      if (!r) throw notFound('No pending request for this authorization');
      await cancelRequest(db, a.tenantId, r.id, a.user.userId, { requestId: req.id, ip: req.ctx.ip });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ check & matrix
  /** For LIMS / report sign-off integration: is this person authorized for this method and activity today? */
  app.get('/check', async (req) => {
    const a = tenantActor(req);
    const q = z.object({ employeeId: Uuid.optional(), employeeCode: z.string().trim().max(50).optional(), methodId: Uuid.optional(), methodCode: z.string().trim().toUpperCase().max(40).optional(), activity: Activity })
      .refine((v) => (v.employeeId || v.employeeCode) && (v.methodId || v.methodCode), 'Give an employee and a method').parse(req.query);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'lab.competency');
      const emp = (await db.query<{ id: string }>('SELECT id FROM employees WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id=$2) AND ($3::text IS NULL OR employee_code=$3)',
        [a.tenantId, q.employeeId ?? null, q.employeeCode ?? null])).rows[0];
      if (!emp) throw notFound('Employee not found');
      scopeEmployee(a, emp.id, 'competency.read', 'competency.authorize');
      const m = (await db.query<{ id: string; code: string }>('SELECT id, code FROM lab_methods WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id=$2) AND ($3::text IS NULL OR code=$3)',
        [a.tenantId, q.methodId ?? null, q.methodCode ?? null])).rows[0];
      if (!m) throw notFound('Method not found');
      return { employeeId: emp.id, methodId: m.id, methodCode: m.code, activity: q.activity, ...(await checkAuthorization(db, a.tenantId, emp.id, m.id, q.activity)) };
    });
  });

  app.get('/matrix', async (req) => {
    const a = tenantActor(req, 'competency.read');
    const q = z.object({ discipline: z.string().trim().max(80).optional(), branchId: Uuid.optional() }).parse(req.query);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'lab.competency');
      const today = await orgToday(db, a.tenantId);
      const methods = (await db.query(`SELECT id, code, name, discipline, matrix FROM lab_methods WHERE tenant_id=$1 AND status='active'
          AND ($2::text IS NULL OR discipline=$2) AND ($3::uuid IS NULL OR branch_id IS NULL OR branch_id=$3) ORDER BY discipline NULLS LAST, code`,
        [a.tenantId, q.discipline ?? null, q.branchId ?? null])).rows as { id: string }[];
      const ids = methods.map((m) => m.id);
      const cells = (await db.query(`SELECT z.employee_id, e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS employee_name, z.method_id, z.activity, z.status, z.review_due::text,
          (SELECT count(*)::int FROM lab_method_requirements r WHERE r.tenant_id=z.tenant_id AND r.method_id=z.method_id AND NOT EXISTS (
             SELECT 1 FROM training_records t WHERE t.tenant_id=r.tenant_id AND t.employee_id=z.employee_id AND t.course_id=r.course_id AND t.status='active'
               AND t.result IN ('completed','passed') AND t.completed_on <= $3::date AND (t.expires_on IS NULL OR t.expires_on >= $3::date))) AS missing_training
        FROM lab_authorizations z JOIN employees e ON e.tenant_id=z.tenant_id AND e.id=z.employee_id
        WHERE z.tenant_id=$1 AND z.method_id = ANY($2::uuid[]) AND z.status IN ('pending','authorized','suspended') AND e.status <> 'exited'
          AND ($4::uuid IS NULL OR e.branch_id=$4)
        ORDER BY e.first_name, e.employee_code`, [a.tenantId, ids, today, q.branchId ?? null])).rows as any[];
      type Cell = { status: string; reviewDue: string | null; inForce: boolean };
      type Row = { employeeId: string; employeeCode: string; name: string; cells: Record<string, Record<string, Cell>> };
      const rows = new Map<string, Row>();
      for (const c of cells) {
        const row: Row = rows.get(c.employee_id) ?? { employeeId: c.employee_id, employeeCode: c.employee_code, name: c.employee_name, cells: {} };
        const inForce = c.status === 'authorized' && c.review_due >= today && c.missing_training === 0;
        // A pending renewal never hides the authorization in force.
        const existing = row.cells[c.method_id]?.[c.activity];
        if (!existing || existing.status === 'pending') (row.cells[c.method_id] ??= {})[c.activity] = { status: c.status, reviewDue: c.review_due, inForce };
        rows.set(c.employee_id, row);
      }
      return { date: today, activities: ACTIVITIES, methods, rows: [...rows.values()] };
    });
  });

  app.get('/me', async (req) => {
    const a = tenantActor(req, 'competency.self');
    if (!a.user.employeeId) throw badRequest('Your account is not linked to an employee record');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'training');
      const today = await orgToday(db, a.tenantId);
      const training = (await db.query(`SELECT t.id, c.code AS course_code, c.name AS course_name, t.completed_on::text, t.expires_on::text, t.result,
          CASE WHEN t.result='failed' THEN 'failed' WHEN t.expires_on IS NULL THEN 'valid' WHEN t.expires_on < $3::date THEN 'expired'
               WHEN t.expires_on <= $3::date + 30 THEN 'expiring' ELSE 'valid' END AS validity
        FROM training_records t JOIN training_courses c ON c.tenant_id=t.tenant_id AND c.id=t.course_id
        WHERE t.tenant_id=$1 AND t.employee_id=$2 AND t.status='active' ORDER BY t.completed_on DESC`, [a.tenantId, a.user.employeeId, today])).rows;
      let authorizations: unknown[] = [];
      try {
        await requireFeature(db, a.tenantId, 'lab.competency');
        authorizations = (await db.query(`SELECT z.id, m.code AS method_code, m.name AS method_name, m.standard_ref, z.activity, z.status, z.valid_from::text, z.review_due::text
          FROM lab_authorizations z JOIN lab_methods m ON m.tenant_id=z.tenant_id AND m.id=z.method_id
          WHERE z.tenant_id=$1 AND z.employee_id=$2 AND z.status IN ('pending','authorized','suspended') ORDER BY m.code, z.activity`, [a.tenantId, a.user.employeeId])).rows;
      } catch (e) { if (!(e instanceof AppError)) throw e; }
      return { date: today, training, authorizations };
    });
  });
}
