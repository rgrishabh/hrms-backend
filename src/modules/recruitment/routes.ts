import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { maskFields } from '../../core/policy/salary.js';
import { createHash } from 'node:crypto';
import { tenantActor, tenantActorAny, requireFeature, type TenantActor, gateFeatures } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { IsoDate, PageQuery, offsetOf, paged, Uuid } from '../../core/http/pagination.js';
import { createApprovalRequest, registerApprovalHandler, cancelRequest } from '../../core/workflow/engine.js';
import { getStore, newKey } from '../../core/storage/index.js';
import { safeFileName } from '../../core/storage/sniff.js';
import { prepareUpload, type PreparedUpload } from '../../core/storage/upload.js';
import { notifyUsers } from '../../core/notify/service.js';
import { getSettingValue } from '../../core/settings/service.js';
import { insertEmployee, EmployeeInput, EMPLOYMENT_TYPES } from '../employees/service.js';
import { orgToday } from '../competency/service.js';
import { createChecklist, featureOn } from '../lifecycle/service.js';
import type { Db } from '../../db/tx.js';

const FEATURE = 'recruitment';
const STAGES = ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'] as const;
type Stage = (typeof STAGES)[number];
/** Allowed manual moves. "hired" happens only through an accepted offer (POST /offers/:id/hire). */
const MOVES: Record<Stage, Stage[]> = {
  applied: ['screening', 'rejected', 'withdrawn'],
  screening: ['interview', 'rejected', 'withdrawn'],
  interview: ['offer', 'rejected', 'withdrawn'],
  offer: ['interview', 'rejected', 'withdrawn'],
  hired: [], rejected: ['screening'], withdrawn: ['screening'],
};
const OPEN_STAGES: Stage[] = ['applied', 'screening', 'interview', 'offer'];
// Not .multipleOf(0.01): floating point makes ordinary amounts fail it. At most two decimals, checked on the text form.
const Money = z.number().positive().max(9_99_99_999).refine((v) => /^\d+(\.\d{1,2})?$/.test(String(v)), 'At most two decimals');
const Text = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v || null);
const RequisitionBody = z.object({
  title: z.string().trim().min(3).max(150), legalEntityId: Uuid, branchId: Uuid, departmentId: Uuid.nullable().default(null),
  designation: Text(120), employmentType: z.enum(EMPLOYMENT_TYPES).default('permanent'), positions: z.number().int().min(1).max(100).default(1),
  justification: z.string().trim().min(3).max(2000), budgetCtcMax: Money.nullable().default(null), hiringManagerId: Uuid.nullable().default(null),
  targetDate: IsoDate.nullable().default(null),
});
const OfferBody = z.object({
  designation: z.string().trim().min(2).max(120), legalEntityId: Uuid, branchId: Uuid, departmentId: Uuid.nullable().default(null),
  employmentType: z.enum(EMPLOYMENT_TYPES), annualCtc: Money, joiningDate: IsoDate, probationMonths: z.number().int().min(0).max(24).nullable().default(null),
  contractEndDate: IsoDate.nullable().default(null), notes: Text(2000),
}).refine((o) => o.employmentType !== 'contract' || !!o.contractEndDate, { message: 'Contract offers need a contract end date', path: ['contractEndDate'] });

const reqNo = (n: number) => `REQ-${String(n).padStart(4, '0')}`;
const fullName = (c: { first_name: string; last_name: string | null }) => [c.first_name, c.last_name].filter(Boolean).join(' ');
const isReader = (a: TenantActor) => a.has('recruitment.read') || a.has('recruitment.manage') || a.has('recruitment.approve');
/** Remove restricted compensation fields unless the actor may see them. */
/** Compensation: the permission to see it at all, then the same mask as all L4, lifted by `?reveal=1`. Candidates have no salary level. */
function redact<T extends Record<string, unknown>>(a: TenantActor, row: T, fields: string[]): T {
  if (a.has('recruitment.compensation') && a.reveal) return row;
  return maskFields(row, fields);
}
const auditCompensation = async (db: Db, a: TenantActor, path: string, targetId?: string) => {
  if (a.has('recruitment.compensation') && a.reveal) await audit(db, { ...a.auditBase, userAgent: a.userAgent, action: 'l4.reveal', category: 'access', targetType: 'recruitment', targetId, metadata: { path } });
};

interface ReqRow { id: string; number: number; title: string; status: string; positions: number; filled: number; created_by: string; hiring_manager_id: string | null; budget_ctc_max: string | null; version: number }
async function loadRequisition(db: Db, a: TenantActor, id: string, lock = false) {
  const r = (await db.query<ReqRow>(`SELECT id, number, title, status, positions, filled, created_by, hiring_manager_id, budget_ctc_max, version
    FROM job_requisitions WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [a.tenantId, id])).rows[0];
  if (!r) throw notFound('Requisition not found');
  const mine = r.created_by === a.user.userId || (!!a.user.employeeId && r.hiring_manager_id === a.user.employeeId);
  if (!isReader(a) && !mine) throw notFound('Requisition not found');
  return { ...r, mine };
}

interface AppRow { id: string; requisition_id: string; candidate_id: string; stage: Stage; version: number; hiring_manager_id: string | null; req_status: string; req_title: string; req_number: number }
/** Readers, the requisition's hiring manager, or a panel member of one of its interviews. */
async function loadApplication(db: Db, a: TenantActor, id: string, lock = false) {
  const r = (await db.query<AppRow>(`SELECT ap.id, ap.requisition_id, ap.candidate_id, ap.stage, ap.version, q.hiring_manager_id, q.status AS req_status, q.title AS req_title, q.number AS req_number
      FROM job_applications ap JOIN job_requisitions q ON q.tenant_id=ap.tenant_id AND q.id=ap.requisition_id
     WHERE ap.tenant_id=$1 AND ap.id=$2${lock ? ' FOR UPDATE OF ap' : ''}`, [a.tenantId, id])).rows[0];
  if (!r) throw notFound('Application not found');
  if (isReader(a)) return { ...r, access: 'full' as const };
  if (a.user.employeeId && r.hiring_manager_id === a.user.employeeId) return { ...r, access: 'manager' as const };
  const panel = await db.query(`SELECT 1 FROM interviews i JOIN interview_panel p ON p.tenant_id=i.tenant_id AND p.interview_id=i.id
    WHERE i.tenant_id=$1 AND i.application_id=$2 AND p.user_id=$3`, [a.tenantId, id, a.user.userId]);
  if (panel.rowCount) return { ...r, access: 'panel' as const };
  throw notFound('Application not found');
}

async function canSeeCandidate(db: Db, a: TenantActor, candidateId: string) {
  if (isReader(a)) return true;
  const r = await db.query(`SELECT 1 FROM job_applications ap JOIN job_requisitions q ON q.tenant_id=ap.tenant_id AND q.id=ap.requisition_id
      LEFT JOIN interviews i ON i.tenant_id=ap.tenant_id AND i.application_id=ap.id
      LEFT JOIN interview_panel p ON p.tenant_id=i.tenant_id AND p.interview_id=i.id AND p.user_id=$4
     WHERE ap.tenant_id=$1 AND ap.candidate_id=$2 AND ((q.hiring_manager_id IS NOT NULL AND q.hiring_manager_id=$3) OR p.user_id IS NOT NULL) LIMIT 1`,
    [a.tenantId, candidateId, a.user.employeeId ?? null, a.user.userId]);
  return (r.rowCount ?? 0) > 0;
}

async function moveStage(db: Db, a: TenantActor, app: { id: string; stage: Stage }, to: Stage, note: string | null, reason?: string | null) {
  await db.query(`UPDATE job_applications SET stage=$3, rejection_reason=CASE WHEN $3='rejected' THEN $4 ELSE NULL END, version=version+1, updated_at=now()
    WHERE tenant_id=$1 AND id=$2`, [a.tenantId, app.id, to, reason ?? null]);
  await db.query(`INSERT INTO job_application_events (tenant_id, application_id, from_stage, to_stage, note, actor_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [a.tenantId, app.id, app.stage, to, note ?? reason ?? null, a.user.userId]);
}

async function readMultipart(req: FastifyRequest, maxBytes: number) {
  let file: { buf: Buffer; name: string } | null = null;
  const fields: Record<string, string> = {};
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      if (file) throw badRequest('One resume per candidate');
      const buf = await part.toBuffer().catch((e: { code?: string }) => {
        if (e.code === 'FST_REQ_FILE_TOO_LARGE') throw new AppError(413, 'file_too_large', `Files are limited to ${maxBytes / 1048576} MB`);
        throw e;
      });
      if (buf.length) file = { buf, name: part.filename || 'resume.pdf' };
    } else fields[part.fieldname] = String(part.value);
  }
  return { file, fields };
}

/** Approval effects. Registered once at startup (core/runtime), whether or not the module's routes are. */
export function registerRecruitmentApprovals() {
  registerApprovalHandler('job_requisition', {
    feature: FEATURE, label: 'Job requisition', requesterLink: '/recruitment',
    async onApproved(db, tenantId, id) {
      const r = await db.query(`UPDATE job_requisitions SET status='approved', approved_at=now(), version=version+1 WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [tenantId, id]);
      if (!r.rowCount) throw conflict('Requisition is no longer pending');
    },
    async onRejected(db, tenantId, id, _actor, status) {
      await db.query(`UPDATE job_requisitions SET status=$3, version=version+1 WHERE tenant_id=$1 AND id=$2 AND status='pending'`,
        [tenantId, id, status === 'rejected' ? 'rejected' : 'draft']);
    },
  });
  registerApprovalHandler('job_offer', {
    feature: FEATURE, label: 'Job offer', requesterLink: '/recruitment',
    async onApproved(db, tenantId, id) {
      const r = await db.query(`UPDATE job_offers SET status='approved', approved_at=now() WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [tenantId, id]);
      if (!r.rowCount) throw conflict('Offer is no longer pending');
    },
    async onRejected(db, tenantId, id, _actor, status) {
      await db.query(`UPDATE job_offers SET status=$3 WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [tenantId, id, status === 'rejected' ? 'rejected' : 'draft']);
    },
  });
}

const RequisitionsQuery = PageQuery.extend({ status: z.string().max(20).optional(), scope: z.enum(['mine', 'all']).optional() });
const IdParams = z.object({ id: Uuid });
const RequisitionsBody = RequisitionBody.extend({ expectedVersion: z.number().int() });
const RequisitionsParams = z.object({ id: Uuid, action: z.enum(['hold', 'reopen', 'close', 'cancel']) });
const PostRequisitionsBody = z.object({ reason: z.string().trim().min(3).max(500) });
const CandidatesQuery = PageQuery.extend({ search: z.string().trim().max(100).optional() });
const ApplicationsBody = z.object({ requisitionId: Uuid, candidateId: Uuid, note: Text(500) });
const ApplicationsMoveBody = z.object({ stage: z.enum(STAGES), note: Text(1000), reason: Text(500), expectedVersion: z.number().int() });
const ApplicationsInterviewsBody = z.object({ round: z.number().int().min(1).max(20), kind: z.enum(['phone', 'technical', 'practical_lab', 'hr', 'panel', 'other']),
      scheduledAt: z.iso.datetime({ offset: true }), durationMin: z.number().int().min(10).max(480).default(45), location: Text(300),
      panelUserIds: z.array(Uuid).min(1).max(10) });
const PanelUsersQuery = z.object({ search: z.string().trim().max(100).optional() });
const InterviewsFeedbackBody = z.object({ rating: z.number().int().min(1).max(5), recommendation: z.enum(['strong_yes', 'yes', 'no', 'strong_no']), notes: z.string().trim().min(10).max(4000) });
const OffersParams = z.object({ id: Uuid, action: z.enum(['sent', 'accepted', 'declined', 'withdraw']) });
const OffersBody = z.object({ note: Text(500) });
const OffersHireBody = z.object({ employeeCode: z.string().trim(), workEmail: z.string().trim().optional().transform((v) => v || undefined), confirmDuplicate: z.boolean().default(false) });
const candidateNum = (max: number) => z.string().optional().transform((v) => (v ? Number(v) : null)).pipe(z.number().int().min(0).max(max).nullable());
const CandidateFields = z.object({
  firstName: z.string().trim().min(1).max(100), lastName: Text(100), email: z.string().trim().toLowerCase().pipe(z.email()).optional().or(z.literal('')).transform((v) => v || null),
  phone: z.string().trim().regex(/^\+?[0-9 -]{10,15}$/, 'Enter a valid phone number').optional().or(z.literal('')).transform((v) => v || null),
  source: z.enum(['referral', 'job_portal', 'website', 'agency', 'campus', 'walk_in', 'other']), referredBy: Uuid.optional().or(z.literal('')).transform((v) => v || null),
  currentCompany: Text(150), currentDesignation: Text(120), experienceMonths: candidateNum(720), noticeDays: candidateNum(365),
  expectedCtc: z.string().optional().transform((v) => (v ? Number(v) : null)).pipe(Money.nullable()),
  location: Text(100), qualification: Text(200), consent: z.literal('true', { message: 'Record the candidate\'s consent to process their data for recruitment' }),
  consentNote: z.string().trim().min(3).max(300), confirmDuplicate: z.enum(['true', 'false']).default('false'),
    }).refine((c) => c.email || c.phone, { message: 'Give an email or a phone number', path: ['email'] });

export async function recruitmentRoutes(app: FastifyInstance) {
  gateFeatures(app, 'recruitment');
  const maxBytes = app.deps.env.STORAGE_MAX_FILE_MB * 1024 * 1024;

  // ------------------------------------------------------------ requisitions
  app.get('/requisitions', { schema: { querystring: RequisitionsQuery }, config: { permAny: ['recruitment.requisition', 'recruitment.read', 'recruitment.manage', 'recruitment.approve'], feature: [FEATURE] } }, async (req) => {
    const a = tenantActorAny(req, 'recruitment.requisition', 'recruitment.read', 'recruitment.manage', 'recruitment.approve');
    const q = RequisitionsQuery.parse(req.query);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const all = isReader(a) && q.scope !== 'mine';
      const where = `q.tenant_id=$1 AND ($2::text IS NULL OR q.status=$2) AND ($3 OR q.created_by=$4 OR q.hiring_manager_id=$5)`;
      const args = [a.tenantId, q.status ?? null, all, a.user.userId, a.user.employeeId ?? null];
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM job_requisitions q WHERE ${where}`, args)).rows[0]!.n);
      const rows = (await db.query(`SELECT q.id, q.number, q.title, q.designation, q.employment_type, q.positions, q.filled, q.status, q.target_date::text, q.created_at, q.budget_ctc_max,
          b.name AS branch_name, d.name AS department_name, trim(m.first_name||' '||coalesce(m.last_name,'')) AS hiring_manager_name,
          (SELECT json_object_agg(stage, n) FROM (SELECT stage, count(*)::int AS n FROM job_applications ap WHERE ap.tenant_id=q.tenant_id AND ap.requisition_id=q.id GROUP BY stage) s) AS pipeline
        FROM job_requisitions q JOIN branches b ON b.tenant_id=q.tenant_id AND b.id=q.branch_id
        LEFT JOIN departments d ON d.tenant_id=q.tenant_id AND d.id=q.department_id LEFT JOIN employees m ON m.tenant_id=q.tenant_id AND m.id=q.hiring_manager_id
        WHERE ${where} ORDER BY q.number DESC LIMIT ${q.pageSize} OFFSET ${offsetOf(q)}`, args)).rows;
      await auditCompensation(db, a, 'recruitment.requisitions');
      return paged(rows.map((r) => ({ ...redact(a, r, ['budget_ctc_max']), code: reqNo(r.number as number) })), total, q);
    });
  });

  async function checkOrgRefs(db: Db, tenantId: string, b: { legalEntityId: string; branchId: string; departmentId: string | null; hiringManagerId?: string | null }) {
    const br = (await db.query<{ legal_entity_id: string }>('SELECT legal_entity_id FROM branches WHERE tenant_id=$1 AND id=$2', [tenantId, b.branchId])).rows[0];
    if (!br) throw badRequest('Unknown branch');
    if (br.legal_entity_id !== b.legalEntityId) throw badRequest('The branch belongs to a different legal entity');
    if (b.departmentId && !(await db.query('SELECT 1 FROM departments WHERE tenant_id=$1 AND id=$2', [tenantId, b.departmentId])).rowCount) throw badRequest('Unknown department');
    if (b.hiringManagerId && !(await db.query(`SELECT 1 FROM employees WHERE tenant_id=$1 AND id=$2 AND status IN ('active','on_notice')`, [tenantId, b.hiringManagerId])).rowCount) throw badRequest('Hiring manager must be an active employee');
  }
  const reqCols = (b: z.infer<typeof RequisitionBody>) => [b.title, b.legalEntityId, b.branchId, b.departmentId, b.designation, b.employmentType, b.positions, b.justification, b.budgetCtcMax, b.hiringManagerId, b.targetDate];

  app.post('/requisitions', { schema: { body: RequisitionBody }, config: { permAny: ['recruitment.requisition', 'recruitment.manage'], feature: [FEATURE] } }, async (req, reply) => {
    const a = tenantActorAny(req, 'recruitment.requisition', 'recruitment.manage');
    const b = RequisitionBody.parse(req.body);
    if (b.budgetCtcMax != null && !a.has('recruitment.compensation')) throw forbidden('Only users with compensation access can set a budget');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      await checkOrgRefs(db, a.tenantId, b);
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`req-number:${a.tenantId}`]);
      const n = (await db.query<{ n: number }>('SELECT coalesce(max(number),0)+1 AS n FROM job_requisitions WHERE tenant_id=$1', [a.tenantId])).rows[0]!.n;
      const id = (await db.query<{ id: string }>(`INSERT INTO job_requisitions (tenant_id, number, title, legal_entity_id, branch_id, department_id, designation, employment_type,
          positions, justification, budget_ctc_max, hiring_manager_id, target_date, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [a.tenantId, n, ...reqCols(b), a.user.userId])).rows[0]!.id;
      await audit(db, { ...a.auditBase, action: 'recruitment.requisition_created', targetType: 'job_requisition', targetId: id, metadata: { number: n, title: b.title, positions: b.positions } });
      reply.code(201); return { id, code: reqNo(n) };
    });
  });

  app.put('/requisitions/:id', { schema: { params: IdParams, body: RequisitionsBody }, config: { permAny: ['recruitment.requisition', 'recruitment.manage'], feature: [FEATURE] } }, async (req) => {
    const a = tenantActorAny(req, 'recruitment.requisition', 'recruitment.manage');
    const { id } = IdParams.parse(req.params);
    const b = RequisitionsBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const r = await loadRequisition(db, a, id, true);
      if (!a.has('recruitment.manage') && r.created_by !== a.user.userId) throw forbidden('Only the requester or HR can change this requisition');
      if (!['draft', 'rejected'].includes(r.status)) throw conflict(`A ${r.status} requisition cannot be edited`);
      if (r.version !== b.expectedVersion) throw conflict('This requisition was changed by someone else. Reload and try again.');
      const budget = a.has('recruitment.compensation') ? b.budgetCtcMax : r.budget_ctc_max;
      await checkOrgRefs(db, a.tenantId, b);
      await db.query(`UPDATE job_requisitions SET title=$3, legal_entity_id=$4, branch_id=$5, department_id=$6, designation=$7, employment_type=$8, positions=$9,
          justification=$10, budget_ctc_max=$11, hiring_manager_id=$12, target_date=$13, status='draft', version=version+1 WHERE tenant_id=$1 AND id=$2`,
        [a.tenantId, id, ...reqCols({ ...b, budgetCtcMax: budget == null ? null : Number(budget) })]);
      await audit(db, { ...a.auditBase, action: 'recruitment.requisition_updated', targetType: 'job_requisition', targetId: id, metadata: { title: b.title, positions: b.positions } });
      return { ok: true };
    });
  });

  app.post('/requisitions/:id/submit', { schema: { params: IdParams }, config: { permAny: ['recruitment.requisition', 'recruitment.manage'], feature: [FEATURE] } }, async (req) => {
    const a = tenantActorAny(req, 'recruitment.requisition', 'recruitment.manage');
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const r = await loadRequisition(db, a, id, true);
      if (!a.has('recruitment.manage') && r.created_by !== a.user.userId) throw forbidden('Only the requester or HR can submit this requisition');
      if (!['draft', 'rejected'].includes(r.status)) throw conflict(`A ${r.status} requisition cannot be submitted`);
      await db.query(`UPDATE job_requisitions SET status='pending', version=version+1 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      const approvalId = await createApprovalRequest(db, a.tenantId, { entityType: 'job_requisition', entityId: id, requesterId: a.user.userId,
        summary: `${reqNo(r.number)} ${r.title} — ${r.positions} position(s)`, steps: [{ kind: 'permission', permission: 'recruitment.approve' }],
        excludeUserIds: [r.created_by] }); // whoever drafted it never approves it, even if someone else submits
      await audit(db, { ...a.auditBase, action: 'recruitment.requisition_submitted', targetType: 'job_requisition', targetId: id, metadata: { approvalId } });
      return { ok: true, approvalRequestId: approvalId };
    });
  });

  app.post('/requisitions/:id/:action', { schema: { params: RequisitionsParams, body: PostRequisitionsBody }, config: { perm: ['recruitment.manage'], feature: [FEATURE] } }, async (req) => {
    const a = tenantActor(req, 'recruitment.manage');
    const p = RequisitionsParams.parse(req.params);
    const { reason } = PostRequisitionsBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const r = await loadRequisition(db, a, p.id, true);
      const from: Record<string, string[]> = { hold: ['approved'], reopen: ['on_hold', 'closed'], close: ['approved', 'on_hold'], cancel: ['draft', 'pending', 'approved', 'on_hold', 'rejected'] };
      if (!from[p.action]!.includes(r.status)) throw conflict(`Cannot ${p.action} a ${r.status} requisition`);
      if (p.action === 'reopen' && r.filled >= r.positions) throw conflict('All positions are filled; increase the positions instead');
      if (r.status === 'pending') {
        const ar = (await db.query<{ id: string; requester_id: string }>(`SELECT id, requester_id FROM approval_requests WHERE tenant_id=$1 AND entity_type='job_requisition' AND entity_id=$2 AND status='pending'`, [a.tenantId, p.id])).rows[0];
        if (ar) {
          if (ar.requester_id !== a.user.userId) throw conflict('Pending approval: only the requester can withdraw it');
          await cancelRequest(db, a.tenantId, ar.id, a.user.userId, { requestId: req.id, ip: req.ctx.ip });
        }
      }
      const to = { hold: 'on_hold', reopen: 'approved', close: 'closed', cancel: 'cancelled' }[p.action];
      await db.query(`UPDATE job_requisitions SET status=$3, closed_at=CASE WHEN $3 IN ('closed','cancelled') THEN now() ELSE NULL END, version=version+1 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, p.id, to]);
      await audit(db, { ...a.auditBase, action: `recruitment.requisition_${p.action}`, targetType: 'job_requisition', targetId: p.id, metadata: { reason } });
      return { ok: true, status: to };
    });
  });

  app.get('/requisitions/:id', { schema: { params: IdParams }, config: { permAny: ['recruitment.requisition', 'recruitment.read', 'recruitment.manage', 'recruitment.approve'], feature: [FEATURE] } }, async (req) => {
    const a = tenantActorAny(req, 'recruitment.requisition', 'recruitment.read', 'recruitment.manage', 'recruitment.approve');
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      await loadRequisition(db, a, id);
      const r = (await db.query(`SELECT q.*, q.target_date::text AS target_date, b.name AS branch_name, d.name AS department_name, le.name AS legal_entity_name,
          trim(m.first_name||' '||coalesce(m.last_name,'')) AS hiring_manager_name, u.display_name AS created_by_name
        FROM job_requisitions q JOIN branches b ON b.tenant_id=q.tenant_id AND b.id=q.branch_id JOIN legal_entities le ON le.tenant_id=q.tenant_id AND le.id=q.legal_entity_id
        LEFT JOIN departments d ON d.tenant_id=q.tenant_id AND d.id=q.department_id LEFT JOIN employees m ON m.tenant_id=q.tenant_id AND m.id=q.hiring_manager_id
        JOIN users u ON u.id=q.created_by WHERE q.tenant_id=$1 AND q.id=$2`, [a.tenantId, id])).rows[0]!;
      const applications = (await db.query(`SELECT ap.id, ap.stage, ap.rejection_reason, ap.updated_at, c.id AS candidate_id, c.first_name, c.last_name, c.current_company,
          c.experience_months, c.source, c.status AS candidate_status,
          (SELECT round(avg(p.rating)::numeric, 1) FROM interviews i JOIN interview_panel p ON p.tenant_id=i.tenant_id AND p.interview_id=i.id
            WHERE i.tenant_id=ap.tenant_id AND i.application_id=ap.id AND p.submitted_at IS NOT NULL) AS avg_rating
        FROM job_applications ap JOIN candidates c ON c.tenant_id=ap.tenant_id AND c.id=ap.candidate_id
        WHERE ap.tenant_id=$1 AND ap.requisition_id=$2 ORDER BY array_position(ARRAY['offer','interview','screening','applied','hired','rejected','withdrawn'], ap.stage), ap.updated_at DESC`, [a.tenantId, id])).rows;
      await auditCompensation(db, a, 'recruitment.requisition', r.id as string);
      return { ...redact(a, r, ['budget_ctc_max']), code: reqNo(r.number), applications };
    });
  });

  // ------------------------------------------------------------ candidates
  app.get('/candidates', { schema: { querystring: CandidatesQuery }, config: { permAny: ['recruitment.read', 'recruitment.manage'], feature: [FEATURE] } }, async (req) => {
    const a = tenantActorAny(req, 'recruitment.read', 'recruitment.manage');
    const q = CandidatesQuery.parse(req.query);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const where = `c.tenant_id=$1 AND c.status='active' AND ($2::text IS NULL OR lower(c.first_name||' '||coalesce(c.last_name,'')) LIKE '%'||lower($2)||'%'
        OR lower(c.email) LIKE '%'||lower($2)||'%' OR c.phone LIKE '%'||$2||'%' OR lower(coalesce(c.current_company,'')) LIKE '%'||lower($2)||'%')`;
      const args = [a.tenantId, q.search || null];
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM candidates c WHERE ${where}`, args)).rows[0]!.n);
      const rows = (await db.query(`SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.source, c.current_company, c.current_designation, c.experience_months,
          c.qualification, c.location, c.resume_key IS NOT NULL AS has_resume, c.retain_until::text, c.employee_id, c.created_at,
          (SELECT count(*)::int FROM job_applications ap WHERE ap.tenant_id=c.tenant_id AND ap.candidate_id=c.id) AS applications
        FROM candidates c WHERE ${where} ORDER BY c.created_at DESC LIMIT ${q.pageSize} OFFSET ${offsetOf(q)}`, args)).rows;
      return paged(rows, total, q);
    });
  });

  /** multipart: firstName, lastName?, email?, phone?, source, referredBy?, currentCompany?, currentDesignation?, experienceMonths?,
   *  noticeDays?, expectedCtc?, location?, qualification?, consent=true, consentNote, confirmDuplicate?, resume (PDF/DOCX) */
  app.post('/candidates', { schema: { body: CandidateFields, consumes: ['multipart/form-data'] }, config: { perm: ['recruitment.manage'], feature: [FEATURE], rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const a = tenantActor(req, 'recruitment.manage');
    if (!req.isMultipart()) throw badRequest('Upload as multipart/form-data');
    const { file, fields } = await readMultipart(req, maxBytes);
    const b = CandidateFields.parse(fields);
    if (b.expectedCtc != null && !a.has('recruitment.compensation')) throw forbidden('Only users with compensation access can record expected CTC');
    let detected: { contentType: string; ext: string } | null = null;
    if (file) {
      if (file.buf.length > maxBytes) throw new AppError(413, 'file_too_large', `Files are limited to ${app.deps.env.STORAGE_MAX_FILE_MB} MB`);
      detected = await prepareUpload(req, a, file.buf, file.name);
      file.buf = (detected as PreparedUpload).bytes;
    }
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      if (b.referredBy && !(await db.query('SELECT 1 FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, b.referredBy])).rowCount) throw badRequest('Unknown referring employee');
      const dup = (await db.query<{ id: string; first_name: string; last_name: string | null }>(`SELECT id, first_name, last_name FROM candidates
        WHERE tenant_id=$1 AND status='active' AND ((email IS NOT NULL AND lower(email)=lower($2)) OR (phone IS NOT NULL AND regexp_replace(phone,'[^0-9]','','g')=regexp_replace($3,'[^0-9]','','g')))`,
        [a.tenantId, b.email, b.phone ?? ''])).rows;
      if (dup.length) {
        const sameEmail = !!b.email && (await db.query(`SELECT 1 FROM candidates WHERE tenant_id=$1 AND status='active' AND lower(email)=lower($2)`, [a.tenantId, b.email])).rowCount;
        // Same email is always the same person; a shared phone can be confirmed as a different person.
        if (sameEmail || b.confirmDuplicate !== 'true') throw conflict('A candidate with this email or phone already exists', { duplicates: dup.map((d) => ({ id: d.id, name: fullName(d) })) });
      }
      let key: string | null = null; let sha: string | null = null;
      if (file) {
        const store = getStore();
        if (!store) throw new AppError(503, 'storage_unavailable', 'File storage is not configured');
        key = newKey(a.tenantId, null, 'recruitment');
        await store.put(key, file.buf, detected!.contentType);
        sha = createHash('sha256').update(file.buf).digest('hex');
      }
      const months = await getSettingValue<number>(db, a.tenantId, 'recruitment.retention_months');
      const today = await orgToday(db, a.tenantId);
      const id = (await db.query<{ id: string }>(`INSERT INTO candidates (tenant_id, first_name, last_name, email, phone, source, referred_by, current_company, current_designation,
          experience_months, notice_days, expected_ctc, location, qualification, resume_key, resume_name, resume_type, resume_sha256, consent_at, consent_note, retain_until, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now(),$19,($20::date + make_interval(months => $21))::date,$22) RETURNING id`,
        [a.tenantId, b.firstName, b.lastName, b.email, b.phone, b.source, b.referredBy, b.currentCompany, b.currentDesignation, b.experienceMonths, b.noticeDays,
          b.expectedCtc, b.location, b.qualification, key, file ? safeFileName(file.name, detected!.ext) : null, detected?.contentType ?? null, sha, b.consentNote, today, months, a.user.userId])).rows[0]!.id;
      await audit(db, { ...a.auditBase, action: 'recruitment.candidate_created', category: 'data', targetType: 'candidate', targetId: id,
        metadata: { source: b.source, hasResume: !!file, consentNote: b.consentNote, confirmedDuplicate: dup.length > 0 } });
      reply.code(201); return { id };
    });
  });

  app.get('/candidates/:id', { schema: { params: IdParams }, config: { feature: [FEATURE] } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      if (!(await canSeeCandidate(db, a, id))) throw notFound('Candidate not found');
      const c = (await db.query(`SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.source, c.current_company, c.current_designation, c.experience_months, c.notice_days,
          c.expected_ctc, c.location, c.qualification, c.resume_name, c.resume_key IS NOT NULL AS has_resume, c.consent_at, c.consent_note, c.retain_until::text, c.status, c.employee_id,
          c.created_at, trim(r.first_name||' '||coalesce(r.last_name,'')) AS referred_by_name
        FROM candidates c LEFT JOIN employees r ON r.tenant_id=c.tenant_id AND r.id=c.referred_by WHERE c.tenant_id=$1 AND c.id=$2`, [a.tenantId, id])).rows[0];
      if (!c) throw notFound('Candidate not found');
      const applications = (await db.query(`SELECT ap.id, ap.stage, ap.updated_at, q.id AS requisition_id, q.number, q.title FROM job_applications ap
        JOIN job_requisitions q ON q.tenant_id=ap.tenant_id AND q.id=ap.requisition_id WHERE ap.tenant_id=$1 AND ap.candidate_id=$2 ORDER BY ap.created_at DESC`, [a.tenantId, id])).rows
        .map((r) => ({ ...r, requisition_code: reqNo(r.number) }));
      await auditCompensation(db, a, 'recruitment.candidate', c.id as string);
      return { ...redact(a, c, ['expected_ctc']), applications: isReader(a) ? applications : [] };
    });
  });

  app.get('/candidates/:id/resume', { schema: { params: IdParams }, config: { feature: [FEATURE] } }, async (req, reply) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    const c = await a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      if (!(await canSeeCandidate(db, a, id))) throw notFound('Candidate not found');
      const c = (await db.query<{ resume_key: string | null; resume_name: string; resume_type: string; resume_sha256: string }>(
        'SELECT resume_key, resume_name, resume_type, resume_sha256 FROM candidates WHERE tenant_id=$1 AND id=$2', [a.tenantId, id])).rows[0];
      if (!c?.resume_key) throw notFound('No resume on file');
      await audit(db, { ...a.auditBase, action: 'recruitment.resume_downloaded', category: 'access', targetType: 'candidate', targetId: id });
      return c;
    });
    const store = getStore();
    if (!store) throw new AppError(503, 'storage_unavailable', 'File storage is not configured');
    const buf = await store.get(c.resume_key!);
    if (createHash('sha256').update(buf).digest('hex') !== c.resume_sha256) throw new AppError(500, 'integrity_failed', 'The stored file failed its integrity check');
    return reply.header('content-type', c.resume_type).header('content-disposition', `attachment; filename="${c.resume_name.replace(/"/g, '')}"`)
      .header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').send(buf);
  });

  /** Erasure on the candidate's request (or before retention ends). Hired candidates keep their employee record. */
  app.post('/candidates/:id/anonymize', { schema: { params: IdParams, body: PostRequisitionsBody }, config: { perm: ['recruitment.manage'], feature: [FEATURE] } }, async (req) => {
    const a = tenantActor(req, 'recruitment.manage');
    const { id } = IdParams.parse(req.params);
    const { reason } = PostRequisitionsBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const live = await db.query(`SELECT 1 FROM job_offers o JOIN job_applications ap ON ap.tenant_id=o.tenant_id AND ap.id=o.application_id
        WHERE o.tenant_id=$1 AND ap.candidate_id=$2 AND o.status IN ('pending','approved','sent','accepted') AND o.employee_id IS NULL`, [a.tenantId, id]);
      if (live.rowCount) throw conflict('This candidate has a live offer; withdraw it first');
      if (!(await anonymizeCandidate(db, a.tenantId, id))) throw notFound('Active candidate not found');
      await audit(db, { ...a.auditBase, action: 'recruitment.candidate_anonymized', category: 'data', targetType: 'candidate', targetId: id, metadata: { reason } });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ applications
  app.post('/applications', { schema: { body: ApplicationsBody }, config: { perm: ['recruitment.manage'], feature: [FEATURE] } }, async (req, reply) => {
    const a = tenantActor(req, 'recruitment.manage');
    const b = ApplicationsBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const r = await loadRequisition(db, a, b.requisitionId, true);
      if (r.status !== 'approved') throw conflict('Candidates can only be added to an approved, open requisition');
      const c = (await db.query<{ status: string }>('SELECT status FROM candidates WHERE tenant_id=$1 AND id=$2', [a.tenantId, b.candidateId])).rows[0];
      if (!c || c.status !== 'active') throw notFound('Candidate not found');
      const id = (await db.query<{ id: string }>(`INSERT INTO job_applications (tenant_id, requisition_id, candidate_id, created_by) VALUES ($1,$2,$3,$4)
        ON CONFLICT (tenant_id, requisition_id, candidate_id) DO NOTHING RETURNING id`, [a.tenantId, b.requisitionId, b.candidateId, a.user.userId])).rows[0]?.id;
      if (!id) throw conflict('This candidate is already in this requisition');
      await db.query(`INSERT INTO job_application_events (tenant_id, application_id, from_stage, to_stage, note, actor_id) VALUES ($1,$2,NULL,'applied',$3,$4)`, [a.tenantId, id, b.note, a.user.userId]);
      await audit(db, { ...a.auditBase, action: 'recruitment.application_created', targetType: 'job_application', targetId: id, metadata: b });
      reply.code(201); return { id };
    });
  });

  app.get('/applications/:id', { schema: { params: IdParams }, config: { feature: [FEATURE] } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const ap = await loadApplication(db, a, id);
      const c = (await db.query(`SELECT id, first_name, last_name, email, phone, current_company, current_designation, experience_months, notice_days, qualification, location,
          resume_key IS NOT NULL AS has_resume, status FROM candidates WHERE tenant_id=$1 AND id=$2`, [a.tenantId, ap.candidate_id])).rows[0];
      const events = ap.access === 'panel' ? [] : (await db.query(`SELECT e.from_stage, e.to_stage, e.note, e.at, u.display_name AS actor_name FROM job_application_events e
        LEFT JOIN users u ON u.id=e.actor_id WHERE e.tenant_id=$1 AND e.application_id=$2 ORDER BY e.at`, [a.tenantId, id])).rows;
      const ivs = (await db.query<{ id: string }>(`SELECT i.id, i.round, i.kind, i.scheduled_at, i.duration_min, i.location, i.status FROM interviews i
        WHERE i.tenant_id=$1 AND i.application_id=$2 ORDER BY i.round, i.scheduled_at`, [a.tenantId, id])).rows;
      // Blind feedback: a panel member sees colleagues' feedback only after submitting their own.
      const interviews = [];
      for (const iv of ivs) {
        const panel = (await db.query<{ user_id: string; submitted_at: string | null }>(`SELECT p.user_id, u.display_name AS name, p.rating, p.recommendation, p.notes, p.submitted_at
          FROM interview_panel p JOIN users u ON u.id=p.user_id WHERE p.tenant_id=$1 AND p.interview_id=$2 ORDER BY u.display_name`, [a.tenantId, iv.id])).rows;
        const mine = panel.find((p) => p.user_id === a.user.userId);
        // Anyone on this panel (even HR or the hiring manager) waits for their own submission; others with access see it all.
        const showAll = mine ? !!mine.submitted_at : ap.access !== 'panel';
        interviews.push({ ...iv, panel: panel.map((p) => (showAll || p.user_id === a.user.userId ? p : { ...p, rating: null, recommendation: null, notes: null, hidden: !!p.submitted_at })) });
      }
      const offers = ap.access === 'panel' ? [] : (await db.query(`SELECT o.id, o.designation, o.employment_type, o.annual_ctc, o.joining_date::text, o.probation_months, o.status,
          o.above_budget, o.notes, o.created_at, o.approved_at, o.sent_at, o.responded_at, o.employee_id, b.name AS branch_name
        FROM job_offers o JOIN branches b ON b.tenant_id=o.tenant_id AND b.id=o.branch_id WHERE o.tenant_id=$1 AND o.application_id=$2 ORDER BY o.created_at DESC`, [a.tenantId, id])).rows
        .map((o) => redact(a, o, ['annual_ctc']));
      if (offers.length) await auditCompensation(db, a, 'recruitment.application', ap.id);
      return { id: ap.id, stage: ap.stage, version: ap.version, access: ap.access, requisition: { id: ap.requisition_id, code: reqNo(ap.req_number), title: ap.req_title, status: ap.req_status },
        candidate: c, events, interviews, offers, allowedMoves: ap.access === 'full' && a.has('recruitment.manage') ? MOVES[ap.stage] : [] };
    });
  });

  app.post('/applications/:id/move', { schema: { params: IdParams, body: ApplicationsMoveBody }, config: { perm: ['recruitment.manage'], feature: [FEATURE] } }, async (req) => {
    const a = tenantActor(req, 'recruitment.manage');
    const { id } = IdParams.parse(req.params);
    const b = ApplicationsMoveBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const ap = await loadApplication(db, a, id, true);
      if (ap.version !== b.expectedVersion) throw conflict('This application was changed by someone else. Reload and try again.');
      if (!MOVES[ap.stage].includes(b.stage)) throw conflict(`Cannot move from ${ap.stage} to ${b.stage}${b.stage === 'hired' ? ' (hire through an accepted offer)' : ''}`);
      if (b.stage === 'rejected' && !b.reason) throw badRequest('Give a reason for rejecting');
      if (OPEN_STAGES.includes(b.stage) && ap.req_status !== 'approved') throw conflict('The requisition is not open');
      if (['rejected', 'withdrawn'].includes(b.stage) || (ap.stage === 'offer' && b.stage === 'interview')) {
        const live = await db.query(`SELECT 1 FROM job_offers WHERE tenant_id=$1 AND application_id=$2 AND status IN ('draft','pending','approved','sent','accepted')`, [a.tenantId, id]);
        if (live.rowCount) throw conflict('Withdraw the open offer first');
      }
      await moveStage(db, a, ap, b.stage, b.note, b.reason);
      await audit(db, { ...a.auditBase, action: 'recruitment.application_moved', targetType: 'job_application', targetId: id, metadata: { from: ap.stage, to: b.stage, reason: b.reason } });
      return { ok: true, stage: b.stage };
    });
  });

  // ------------------------------------------------------------ interviews
  app.post('/applications/:id/interviews', { schema: { params: IdParams, body: ApplicationsInterviewsBody }, config: { perm: ['recruitment.manage'], feature: [FEATURE] } }, async (req, reply) => {
    const a = tenantActor(req, 'recruitment.manage');
    const { id } = IdParams.parse(req.params);
    const b = ApplicationsInterviewsBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const ap = await loadApplication(db, a, id);
      if (ap.stage !== 'interview') throw conflict('Move the application to the interview stage first');
      const users = (await db.query<{ id: string }>(`SELECT id FROM users WHERE tenant_id=$1 AND id = ANY($2::uuid[]) AND status='active'`, [a.tenantId, [...new Set(b.panelUserIds)]])).rows;
      if (users.length !== new Set(b.panelUserIds).size) throw badRequest('Every panel member must be an active user');
      const iid = (await db.query<{ id: string }>(`INSERT INTO interviews (tenant_id, application_id, round, kind, scheduled_at, duration_min, location, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [a.tenantId, id, b.round, b.kind, b.scheduledAt, b.durationMin, b.location, a.user.userId])).rows[0]!.id;
      for (const u of users) await db.query('INSERT INTO interview_panel (tenant_id, interview_id, user_id) VALUES ($1,$2,$3)', [a.tenantId, iid, u.id]);
      const cand = (await db.query<{ first_name: string; last_name: string | null }>('SELECT first_name, last_name FROM candidates WHERE tenant_id=$1 AND id=$2', [a.tenantId, ap.candidate_id])).rows[0]!;
      await notifyUsers(db, a.tenantId, users.map((u) => u.id), { kind: 'recruitment.interview', title: `Interview: ${fullName(cand)} for ${ap.req_title}`,
        body: `Round ${b.round} (${b.kind.replace('_', ' ')}) on ${new Date(b.scheduledAt).toISOString().slice(0, 16).replace('T', ' ')} UTC${b.location ? ` — ${b.location}` : ''}. Submit your feedback afterwards.`,
        link: '/recruitment?tab=interviews', actionLabel: 'Open' });
      await audit(db, { ...a.auditBase, action: 'recruitment.interview_scheduled', targetType: 'interview', targetId: iid, metadata: { applicationId: id, round: b.round, panel: users.length } });
      reply.code(201); return { id: iid };
    });
  });

  /** Active users to pick an interview panel from (name only; no roles or contact details). */
  app.get('/panel-users', { schema: { querystring: PanelUsersQuery }, config: { perm: ['recruitment.manage'], feature: [FEATURE] } }, async (req) => {
    const a = tenantActor(req, 'recruitment.manage');
    const q = PanelUsersQuery.parse(req.query);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      return { items: (await db.query(`SELECT u.id, u.display_name, e.designation FROM users u LEFT JOIN employees e ON e.tenant_id=u.tenant_id AND e.user_id=u.id
        WHERE u.tenant_id=$1 AND u.status='active' AND ($2::text IS NULL OR lower(u.display_name) LIKE '%'||lower($2)||'%')
        ORDER BY u.display_name LIMIT 25`, [a.tenantId, q.search || null])).rows };
    });
  });

  app.get('/interviews/mine', { schema: {}, config: { feature: [FEATURE] } }, async (req) => {
    const a = tenantActor(req);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      return { items: (await db.query(`SELECT i.id, i.application_id, i.round, i.kind, i.scheduled_at, i.duration_min, i.location, i.status, p.submitted_at,
          c.first_name, c.last_name, q.title AS requisition_title, q.number
        FROM interview_panel p JOIN interviews i ON i.tenant_id=p.tenant_id AND i.id=p.interview_id
        JOIN job_applications ap ON ap.tenant_id=i.tenant_id AND ap.id=i.application_id JOIN candidates c ON c.tenant_id=ap.tenant_id AND c.id=ap.candidate_id
        JOIN job_requisitions q ON q.tenant_id=ap.tenant_id AND q.id=ap.requisition_id
        WHERE p.tenant_id=$1 AND p.user_id=$2 AND i.status <> 'cancelled' ORDER BY (p.submitted_at IS NULL) DESC, i.scheduled_at DESC LIMIT 100`, [a.tenantId, a.user.userId])).rows
        .map((r) => ({ ...r, requisition_code: reqNo(r.number) })) };
    });
  });

  app.post('/interviews/:id/feedback', { schema: { params: IdParams, body: InterviewsFeedbackBody }, config: { feature: [FEATURE] } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    const b = InterviewsFeedbackBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const iv = (await db.query<{ status: string; scheduled_at: Date }>(`SELECT i.status, i.scheduled_at FROM interviews i JOIN interview_panel p ON p.tenant_id=i.tenant_id AND p.interview_id=i.id
        WHERE i.tenant_id=$1 AND i.id=$2 AND p.user_id=$3`, [a.tenantId, id, a.user.userId])).rows[0];
      if (!iv) throw notFound('Interview not found');
      if (iv.status === 'cancelled') throw conflict('This interview was cancelled');
      if (iv.scheduled_at.getTime() > Date.now()) throw conflict('Feedback opens when the interview starts');
      const r = await db.query(`UPDATE interview_panel SET rating=$4, recommendation=$5, notes=$6, submitted_at=now()
        WHERE tenant_id=$1 AND interview_id=$2 AND user_id=$3 AND submitted_at IS NULL`, [a.tenantId, id, a.user.userId, b.rating, b.recommendation, b.notes]);
      if (!r.rowCount) throw conflict('You already submitted feedback for this interview');
      const left = Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM interview_panel WHERE tenant_id=$1 AND interview_id=$2 AND submitted_at IS NULL', [a.tenantId, id])).rows[0]!.n);
      if (left === 0) await db.query(`UPDATE interviews SET status='completed' WHERE tenant_id=$1 AND id=$2 AND status='scheduled'`, [a.tenantId, id]);
      await audit(db, { ...a.auditBase, action: 'recruitment.feedback_submitted', targetType: 'interview', targetId: id });  // no rating in the audit log: feedback stays blind to panel members who read audit history
      return { ok: true, interviewCompleted: left === 0 };
    });
  });

  app.post('/interviews/:id/cancel', { schema: { params: IdParams }, config: { perm: ['recruitment.manage'], feature: [FEATURE] } }, async (req) => {
    const a = tenantActor(req, 'recruitment.manage');
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const r = await db.query(`UPDATE interviews SET status='cancelled' WHERE tenant_id=$1 AND id=$2 AND status='scheduled'`, [a.tenantId, id]);
      if (!r.rowCount) throw notFound('Scheduled interview not found');
      await audit(db, { ...a.auditBase, action: 'recruitment.interview_cancelled', targetType: 'interview', targetId: id });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ offers
  async function offerBudgetFlag(db: Db, tenantId: string, requisitionId: string, ctc: number) {
    const b = (await db.query<{ budget_ctc_max: string | null }>('SELECT budget_ctc_max FROM job_requisitions WHERE tenant_id=$1 AND id=$2', [tenantId, requisitionId])).rows[0]!.budget_ctc_max;
    return b != null && ctc > Number(b);
  }
  app.post('/applications/:id/offers', { schema: { params: IdParams, body: OfferBody }, config: { perm: ['recruitment.manage', 'recruitment.compensation'], feature: [FEATURE] } }, async (req, reply) => {
    const a = tenantActor(req, 'recruitment.manage', 'recruitment.compensation');
    const { id } = IdParams.parse(req.params);
    const b = OfferBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const ap = await loadApplication(db, a, id, true);
      if (ap.stage !== 'offer') throw conflict('Move the application to the offer stage first');
      if (ap.req_status !== 'approved') throw conflict('The requisition is not open');
      if (b.joiningDate < await orgToday(db, a.tenantId)) throw badRequest('Joining date cannot be in the past');
      await checkOrgRefs(db, a.tenantId, b);
      const above = await offerBudgetFlag(db, a.tenantId, ap.requisition_id, b.annualCtc);
      const oid = (await db.query<{ id: string }>(`INSERT INTO job_offers (tenant_id, application_id, designation, legal_entity_id, branch_id, department_id, employment_type, annual_ctc,
          joining_date, probation_months, contract_end_date, above_budget, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [a.tenantId, id, b.designation, b.legalEntityId, b.branchId, b.departmentId, b.employmentType, b.annualCtc, b.joiningDate, b.probationMonths, b.contractEndDate, above, b.notes, a.user.userId])).rows[0]!.id;
      await audit(db, { ...a.auditBase, action: 'recruitment.offer_drafted', targetType: 'job_offer', targetId: oid, metadata: { applicationId: id, aboveBudget: above } });
      reply.code(201); return { id: oid, aboveBudget: above };
    });
  });

  async function loadOffer(db: Db, a: TenantActor, id: string) {
    const o = (await db.query<{ id: string; application_id: string; status: string; created_by: string; designation: string; employee_id: string | null; above_budget: boolean }>(
      'SELECT id, application_id, status, created_by, designation, employee_id, above_budget FROM job_offers WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id])).rows[0];
    if (!o) throw notFound('Offer not found');
    const ap = await loadApplication(db, a, o.application_id, true);
    if (ap.access !== 'full') throw notFound('Offer not found');
    return { o, ap };
  }

  app.put('/offers/:id', { schema: { params: IdParams, body: OfferBody }, config: { perm: ['recruitment.manage', 'recruitment.compensation'], feature: [FEATURE] } }, async (req) => {
    const a = tenantActor(req, 'recruitment.manage', 'recruitment.compensation');
    const { id } = IdParams.parse(req.params);
    const b = OfferBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const { o, ap } = await loadOffer(db, a, id);
      if (!['draft', 'rejected'].includes(o.status)) throw conflict(`A ${o.status} offer cannot be edited`);
      await checkOrgRefs(db, a.tenantId, b);
      const above = await offerBudgetFlag(db, a.tenantId, ap.requisition_id, b.annualCtc);
      await db.query(`UPDATE job_offers SET designation=$3, legal_entity_id=$4, branch_id=$5, department_id=$6, employment_type=$7, annual_ctc=$8, joining_date=$9, probation_months=$10,
          contract_end_date=$11, above_budget=$12, notes=$13, status='draft' WHERE tenant_id=$1 AND id=$2`,
        [a.tenantId, id, b.designation, b.legalEntityId, b.branchId, b.departmentId, b.employmentType, b.annualCtc, b.joiningDate, b.probationMonths, b.contractEndDate, above, b.notes]);
      await audit(db, { ...a.auditBase, action: 'recruitment.offer_updated', targetType: 'job_offer', targetId: id, metadata: { aboveBudget: above } });
      return { ok: true, aboveBudget: above };
    });
  });

  app.post('/offers/:id/submit', { schema: { params: IdParams }, config: { perm: ['recruitment.manage'], feature: [FEATURE] } }, async (req) => {
    const a = tenantActor(req, 'recruitment.manage');
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const { o, ap } = await loadOffer(db, a, id);
      if (!['draft', 'rejected'].includes(o.status)) throw conflict(`A ${o.status} offer cannot be submitted`);
      if (ap.req_status !== 'approved') throw conflict('The requisition is not open');
      const cand = (await db.query<{ first_name: string; last_name: string | null }>('SELECT first_name, last_name FROM candidates WHERE tenant_id=$1 AND id=$2', [a.tenantId, ap.candidate_id])).rows[0]!;
      await db.query(`UPDATE job_offers SET status='pending' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      // The summary goes into notifications and email: no compensation figures in it.
      const approvalId = await createApprovalRequest(db, a.tenantId, { entityType: 'job_offer', entityId: id, requesterId: a.user.userId,
        summary: `${fullName(cand)} — ${o.designation} (${reqNo(ap.req_number)})${o.above_budget ? ' · above budget' : ''}`, steps: [{ kind: 'permission', permission: 'recruitment.approve' }],
        excludeUserIds: [o.created_by] }); // whoever drafted the offer never approves it, even if someone else submits
      await audit(db, { ...a.auditBase, action: 'recruitment.offer_submitted', targetType: 'job_offer', targetId: id, metadata: { approvalId } });
      return { ok: true, approvalRequestId: approvalId };
    });
  });

  app.post('/offers/:id/:action', { schema: { params: OffersParams, body: OffersBody }, config: { perm: ['recruitment.manage'], feature: [FEATURE] } }, async (req) => {
    const a = tenantActor(req, 'recruitment.manage');
    const p = OffersParams.parse(req.params);
    const b = OffersBody.parse(req.body ?? {});
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const { o } = await loadOffer(db, a, p.id);
      const from: Record<string, string[]> = { sent: ['approved'], accepted: ['sent'], declined: ['sent'], withdraw: ['draft', 'approved', 'sent', 'rejected'] };
      if (!from[p.action]!.includes(o.status)) throw conflict(`Cannot mark a ${o.status} offer as ${p.action}`);
      const to = { sent: 'sent', accepted: 'accepted', declined: 'declined', withdraw: 'withdrawn' }[p.action];
      await db.query(`UPDATE job_offers SET status=$3, sent_at=CASE WHEN $3='sent' THEN now() ELSE sent_at END,
          responded_at=CASE WHEN $3 IN ('accepted','declined') THEN now() ELSE responded_at END WHERE tenant_id=$1 AND id=$2`, [a.tenantId, p.id, to]);
      await audit(db, { ...a.auditBase, action: `recruitment.offer_${to}`, targetType: 'job_offer', targetId: p.id, metadata: { note: b.note } });
      return { ok: true, status: to };
    });
  });

  /** Accepted offer → employee record (pre_joining), application hired, requisition filled (closed when full). */
  app.post('/offers/:id/hire', { schema: { params: IdParams, body: OffersHireBody }, config: { perm: ['recruitment.manage', 'employees.manage'], feature: [FEATURE] } }, async (req, reply) => {
    const a = tenantActor(req, 'recruitment.manage', 'employees.manage');
    const { id } = IdParams.parse(req.params);
    const b = OffersHireBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const { o, ap } = await loadOffer(db, a, id);
      if (o.status !== 'accepted') throw conflict('Only an accepted offer can be hired');
      if (o.employee_id) throw conflict('This offer was already converted into an employee');
      const off = (await db.query<{ legal_entity_id: string; branch_id: string; department_id: string | null; employment_type: string; joining_date: string; probation_months: number | null; contract_end_date: string | null }>(
        `SELECT legal_entity_id, branch_id, department_id, employment_type, joining_date::text, probation_months, contract_end_date::text FROM job_offers WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id])).rows[0]!;
      const cand = (await db.query<{ first_name: string; last_name: string | null; phone: string | null }>('SELECT first_name, last_name, phone FROM candidates WHERE tenant_id=$1 AND id=$2', [a.tenantId, ap.candidate_id])).rows[0]!;
      const req0 = (await db.query<{ hiring_manager_id: string | null; positions: number; filled: number; status: string }>('SELECT hiring_manager_id, positions, filled, status FROM job_requisitions WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, ap.requisition_id])).rows[0]!;
      if (req0.status !== 'approved') throw conflict('The requisition is not open');
      if (req0.filled >= req0.positions) throw conflict('All positions of this requisition are already filled');
      const probationEnd = off.probation_months ? (await db.query<{ d: string }>(`SELECT ($1::date + make_interval(months => $2))::date::text AS d`, [off.joining_date, off.probation_months])).rows[0]!.d : undefined;
      const input = EmployeeInput.parse({
        employeeCode: b.employeeCode, firstName: cand.first_name, lastName: cand.last_name ?? undefined, workEmail: b.workEmail, phone: cand.phone ?? undefined,
        legalEntityId: off.legal_entity_id, branchId: off.branch_id, departmentId: off.department_id ?? undefined, designation: o.designation,
        employmentType: off.employment_type, status: 'pre_joining', reportingManagerId: req0.hiring_manager_id ?? undefined, dateOfJoining: off.joining_date,
        probationEndDate: probationEnd, contractEndDate: off.contract_end_date ?? undefined,
      });
      const employeeId = await insertEmployee(db, a.tenantId, input, b.confirmDuplicate);
      await db.query('UPDATE job_offers SET employee_id=$3 WHERE tenant_id=$1 AND id=$2', [a.tenantId, id, employeeId]);
      await db.query('UPDATE candidates SET employee_id=$3 WHERE tenant_id=$1 AND id=$2', [a.tenantId, ap.candidate_id, employeeId]);
      await moveStage(db, a, ap, 'hired', `Hired as ${b.employeeCode}`);
      const filled = req0.filled + 1;
      await db.query(`UPDATE job_requisitions SET filled=$3, status=CASE WHEN $3 >= positions THEN 'closed' ELSE status END,
          closed_at=CASE WHEN $3 >= positions THEN now() ELSE closed_at END, version=version+1 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, ap.requisition_id, filled]);
      // Onboarding checklist from the default template, when that module is on.
      const onboardingId = (await featureOn(db, a.tenantId, 'core.onboarding'))
        ? await createChecklist(db, a.tenantId, { kind: 'onboarding', employeeId, anchorDate: off.joining_date, actorId: null }) : null;
      await audit(db, { ...a.auditBase, action: 'recruitment.hired', targetType: 'employee', targetId: employeeId, metadata: { offerId: id, applicationId: ap.id, employeeCode: b.employeeCode, onboardingId } });
      reply.code(201); return { employeeId, requisitionClosed: filled >= req0.positions, onboardingChecklistId: onboardingId };
    });
  });
}

/** Clears personal data and deletes the resume; keeps the row (and pipeline history) for reporting. */
export async function anonymizeCandidate(db: Db, tenantId: string, id: string): Promise<boolean> {
  const c = (await db.query<{ resume_key: string | null }>(`SELECT resume_key FROM candidates WHERE tenant_id=$1 AND id=$2 AND status='active' FOR UPDATE`, [tenantId, id])).rows[0];
  if (!c) return false;
  if (c.resume_key) await getStore()?.delete(c.resume_key);
  await db.query(`UPDATE candidates SET first_name='Anonymized', last_name=NULL, email=NULL, phone=NULL, referred_by=NULL, current_company=NULL, current_designation=NULL,
      expected_ctc=NULL, location=NULL, qualification=NULL, resume_key=NULL, resume_name=NULL, resume_type=NULL, resume_sha256=NULL, status='anonymized' WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  await db.query(`UPDATE interview_panel p SET notes=NULL FROM interviews i JOIN job_applications ap ON ap.tenant_id=i.tenant_id AND ap.id=i.application_id
    WHERE p.tenant_id=$1 AND p.interview_id=i.id AND ap.candidate_id=$2`, [tenantId, id]);
  return true;
}

/** Retention: candidates past retain_until, not hired and not in an open process. */
export async function recruitmentRetention(db: Db, tenantId: string, today: string) {
  const due = (await db.query<{ id: string }>(`SELECT c.id FROM candidates c WHERE c.tenant_id=$1 AND c.status='active' AND c.employee_id IS NULL AND c.retain_until < $2::date
      AND NOT EXISTS (SELECT 1 FROM job_applications ap JOIN job_requisitions q ON q.tenant_id=ap.tenant_id AND q.id=ap.requisition_id
        WHERE ap.tenant_id=c.tenant_id AND ap.candidate_id=c.id AND ap.stage IN ('applied','screening','interview','offer') AND q.status IN ('approved','on_hold','pending'))`, [tenantId, today])).rows;
  for (const { id } of due) {
    await anonymizeCandidate(db, tenantId, id);
    await audit(db, { tenantId, actorId: null, actorType: 'system', action: 'recruitment.candidate_anonymized', category: 'data', targetType: 'candidate', targetId: id, metadata: { reason: 'retention period ended' } });
  }
  return { anonymized: due.length };
}
