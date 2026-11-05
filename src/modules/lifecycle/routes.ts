import type { FastifyInstance } from 'fastify';
import { only } from '../../core/features/routes.js';
import { z } from 'zod';
import { scrubAmounts } from '../../core/policy/text.js';
import { assertOutranks, l3RowFilter, maskFields, policyViewer, subjectVisible } from '../../core/policy/salary.js';
import { evaluateFeatures } from '../../core/features/state.js';
import { tenantActor, tenantActorAny, requireFeature, type TenantActor, gateFeatures } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { IsoDate, PageQuery, offsetOf, paged, Uuid } from '../../core/http/pagination.js';
import { buildSteps, createApprovalRequest, registerApprovalHandler, cancelRequest, type StepSpec } from '../../core/workflow/engine.js';
import { notifyUsers, usersWithPermission } from '../../core/notify/service.js';
import { getSettingValue } from '../../core/settings/service.js';
import { orgToday } from '../competency/service.js';
import { daysBetween } from '../attendance/time.js';
import type { Db } from '../../db/tx.js';
import { openAssets } from '../assets/routes.js';
import { balancesAt } from '../leave/service.js';
import { letterRoutes } from './letters.js';
import { endAccess, OWNERS, OWNER_PERMISSION, type Owner, canActOnTask, createChecklist, featureOn, loadEmp, maybeCompleteChecklist, taskAssignees } from './service.js';

const ON = 'core.onboarding';
const OFF = 'core.offboarding';
const KIND = z.enum(['onboarding', 'offboarding']);
const featureFor = (k: 'onboarding' | 'offboarding') => (k === 'onboarding' ? ON : OFF);
const Text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => v || null);
const TemplateBody = z.object({
  kind: KIND,
  name: z.string().trim().min(2).max(120),
  isDefault: z.boolean().default(false),
  status: z.enum(['active', 'inactive']).default('active'),
  tasks: z
    .array(z.object({ title: z.string().trim().min(2).max(200), description: Text(1000), owner: z.enum(OWNERS), offsetDays: z.number().int().min(-90).max(180).default(0) }))
    .min(1)
    .max(60),
});
const SEPARATION_KINDS = ['resignation', 'termination', 'retirement', 'contract_end', 'death', 'absconding', 'mutual'] as const;

/** Approval effects. Registered once at startup (core/runtime), whether or not the module's routes are. */
export function registerLifecycleApprovals() {
  registerApprovalHandler('separation', {
    feature: OFF,
    label: 'Separation',
    requesterLink: '/lifecycle?tab=separations',
    async onApproved(db, tenantId, id, actorId) {
      const s = (
        await db.query<{ employee_id: string; requested_lwd: string; approved_lwd: string | null; status: string }>(
          `SELECT employee_id, requested_lwd::text, approved_lwd::text, status FROM separations WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [tenantId, id],
        )
      ).rows[0];
      if (!s || s.status !== 'pending') throw conflict('Separation is no longer pending');
      const lwd = s.approved_lwd ?? s.requested_lwd;
      await db.query(`UPDATE separations SET status='approved', approved_lwd=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, id, lwd]);
      await db.query(
        `UPDATE employees SET status='on_notice', exit_date=$3, version=version+1, updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status IN ('active','pre_joining')`,
        [tenantId, s.employee_id, lwd],
      );
      await createChecklist(db, tenantId, { kind: 'offboarding', employeeId: s.employee_id, anchorDate: lwd, separationId: id, actorId });
    },
    async onRejected(db, tenantId, id, _a, status) {
      await db.query(`UPDATE separations SET status=$3 WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [tenantId, id, status === 'cancelled' ? 'withdrawn' : 'rejected']);
    },
  });
  registerApprovalHandler('probation_review', {
    feature: ON,
    label: 'Probation review',
    requesterLink: '/lifecycle?tab=probation',
    async onApproved(db, tenantId, id) {
      const r = (
        await db.query<{ employee_id: string; probation_end: string; recommendation: string; extend_months: number | null; status: string }>(
          `SELECT employee_id, probation_end::text, recommendation, extend_months, status FROM probation_reviews WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [tenantId, id],
        )
      ).rows[0];
      if (!r || r.status !== 'pending') throw conflict('Review is no longer pending');
      await db.query(`UPDATE probation_reviews SET status='approved', decided_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
      if (r.recommendation === 'confirm') {
        await db.query(
          `UPDATE employees SET confirmation_date=$3, employment_type=CASE WHEN employment_type='probation' THEN 'permanent' ELSE employment_type END,
          version=version+1, updated_at=now() WHERE tenant_id=$1 AND id=$2`,
          [tenantId, r.employee_id, r.probation_end],
        );
      } else if (r.recommendation === 'extend') {
        await db.query(`UPDATE employees SET probation_end_date=($3::date + make_interval(months => $4))::date, version=version+1, updated_at=now() WHERE tenant_id=$1 AND id=$2`, [
          tenantId,
          r.employee_id,
          r.probation_end,
          r.extend_months,
        ]);
      }
      // 'terminate' is recorded; HR then starts a termination separation (notice, clearance, approval).
    },
    async onRejected(db, tenantId, id, _a, status) {
      await db.query(`UPDATE probation_reviews SET status=$3 WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [
        tenantId,
        id,
        status === 'returned' ? 'open' : status === 'cancelled' ? 'open' : 'rejected',
      ]);
    },
  });
}

const TemplatesQuery = z.object({ kind: KIND.optional() });
const IdParams = z.object({ id: Uuid });
const ChecklistsQuery = PageQuery.extend({ kind: KIND.optional(), status: z.enum(['open', 'completed', 'cancelled']).optional() });
const ChecklistsBody = z.object({ employeeId: Uuid, templateId: Uuid.optional() });
const ChecklistsCancelBody = z.object({ reason: z.string().trim().min(3).max(500) });
const ProbationQuery = z.object({ status: z.enum(['open', 'pending', 'approved', 'rejected', 'cancelled']).optional() });
const ProbationSubmitBody = z
  .object({
    recommendation: z.enum(['confirm', 'extend', 'terminate']),
    extendMonths: z.number().int().min(1).max(6).nullable().default(null),
    comments: z.string().trim().min(10).max(4000),
  })
  .refine((v) => v.recommendation !== 'extend' || v.extendMonths, { message: 'Give the extension in months', path: ['extendMonths'] });
const SeparationsResignBody = z.object({ reason: z.string().trim().min(3).max(2000), requestedLwd: IsoDate });
const SeparationsBody = z.object({ employeeId: Uuid, kind: z.enum(SEPARATION_KINDS), reason: z.string().trim().min(3).max(2000), noticeDate: IsoDate, requestedLwd: IsoDate });
const SeparationsQuery = PageQuery.extend({ status: z.string().max(20).optional(), scope: z.enum(['mine', 'team', 'all']).default('all') });
const SeparationsLwdBody = z.object({ approvedLwd: IsoDate, waiveShortfall: z.boolean().default(false) });
const SeparationsExitInterviewBody = z.object({
  answers: z.record(z.string().max(80), z.string().trim().max(4000)).refine((o) => Object.keys(o).length > 0 && Object.keys(o).length <= 30, 'Give 1–30 answers'),
});
const SeparationsFnfBody = z.object({ status: z.enum(['not_started', 'in_progress', 'settled']), note: Text(2000) });
const SeparationsCompleteBody = z.object({ rehireEligible: z.boolean() });
export async function lifecycleRoutes(app: FastifyInstance) {
  gateFeatures(app, ON, OFF);
  letterRoutes(app);
  // ------------------------------------------------------------ templates
  app.get('/templates', { schema: { querystring: TemplatesQuery }, config: { permAny: ['lifecycle.manage', 'lifecycle.read'] } }, async (req) => {
    const a = tenantActorAny(req, 'lifecycle.manage', 'lifecycle.read');
    const q = TemplatesQuery.parse(req.query);
    return a.tx(async (db) => {
      const t = (
        await db.query(
          `SELECT t.id, t.kind, t.name, t.is_default, t.status,
          coalesce((SELECT json_agg(json_build_object('title', k.title, 'description', k.description, 'owner', k.owner, 'offsetDays', k.offset_days) ORDER BY k.position)
            FROM checklist_template_tasks k WHERE k.tenant_id=t.tenant_id AND k.template_id=t.id), '[]') AS tasks
        FROM checklist_templates t WHERE t.tenant_id=$1 AND ($2::text IS NULL OR t.kind=$2) ORDER BY t.kind, t.is_default DESC, t.name`,
          [a.tenantId, q.kind ?? null],
        )
      ).rows;
      return { items: t };
    });
  });
  async function saveTemplate(db: Db, a: TenantActor, b: z.infer<typeof TemplateBody>, id?: string) {
    await requireFeature(db, a.tenantId, featureFor(b.kind));
    if (b.isDefault)
      await db.query(`UPDATE checklist_templates SET is_default=false WHERE tenant_id=$1 AND kind=$2 AND ($3::uuid IS NULL OR id <> $3)`, [a.tenantId, b.kind, id ?? null]);
    if (id) {
      const r = await db.query(`UPDATE checklist_templates SET name=$3, is_default=$4, status=$5 WHERE tenant_id=$1 AND id=$2 AND kind=$6`, [
        a.tenantId,
        id,
        b.name,
        b.isDefault,
        b.status,
        b.kind,
      ]);
      if (!r.rowCount) throw notFound('Template not found');
      await db.query('DELETE FROM checklist_template_tasks WHERE tenant_id=$1 AND template_id=$2', [a.tenantId, id]);
    } else {
      id = (
        await db.query<{ id: string }>(`INSERT INTO checklist_templates (tenant_id, kind, name, is_default, status) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
          a.tenantId,
          b.kind,
          b.name,
          b.isDefault,
          b.status,
        ])
      ).rows[0]!.id;
    }
    for (const [i, t] of b.tasks.entries())
      await db.query(`INSERT INTO checklist_template_tasks (tenant_id, template_id, position, title, description, owner, offset_days) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
        a.tenantId,
        id,
        i,
        t.title,
        t.description,
        t.owner,
        t.offsetDays,
      ]);
    await audit(db, {
      ...a.auditBase,
      action: 'lifecycle.template_saved',
      category: 'configuration',
      targetType: 'checklist_template',
      targetId: id,
      metadata: { kind: b.kind, name: b.name, tasks: b.tasks.length },
    });
    return id;
  }
  app.post('/templates', { schema: { body: TemplateBody }, config: { perm: ['lifecycle.manage'] } }, async (req, reply) => {
    const a = tenantActor(req, 'lifecycle.manage');
    const b = TemplateBody.parse(req.body);
    return a.tx(async (db) => {
      const id = await saveTemplate(db, a, b);
      reply.code(201);
      return { id };
    });
  });
  app.put('/templates/:id', { schema: { params: IdParams, body: TemplateBody }, config: { perm: ['lifecycle.manage'] } }, async (req) => {
    const a = tenantActor(req, 'lifecycle.manage');
    const { id } = IdParams.parse(req.params);
    const b = TemplateBody.parse(req.body);
    return a.tx(async (db) => {
      await saveTemplate(db, a, b, id);
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ checklists
  app.get('/checklists', { schema: { querystring: ChecklistsQuery }, config: { permAny: ['lifecycle.manage', 'lifecycle.read'] } }, async (req) => {
    const a = tenantActorAny(req, 'lifecycle.manage', 'lifecycle.read');
    const q = ChecklistsQuery.parse(req.query);
    return a.tx(async (db) => {
      const where = `c.tenant_id=$1 AND ($2::text IS NULL OR c.kind=$2) AND ($3::text IS NULL OR c.status=$3)`;
      const args = [a.tenantId, q.kind ?? null, q.status ?? null];
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM checklists c WHERE ${where}`, args)).rows[0]!.n);
      const rows = (
        await db.query(
          `SELECT c.id, c.kind, c.status, c.anchor_date::text, c.created_at, c.employee_id, e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS employee_name,
          (SELECT count(*)::int FROM checklist_tasks t WHERE t.tenant_id=c.tenant_id AND t.checklist_id=c.id) AS tasks,
          (SELECT count(*)::int FROM checklist_tasks t WHERE t.tenant_id=c.tenant_id AND t.checklist_id=c.id AND t.status<>'pending') AS done,
          (SELECT count(*)::int FROM checklist_tasks t WHERE t.tenant_id=c.tenant_id AND t.checklist_id=c.id AND t.status='pending' AND t.due_date < $4::date) AS overdue
        FROM checklists c JOIN employees e ON e.tenant_id=c.tenant_id AND e.id=c.employee_id WHERE ${where}
        ORDER BY (c.status='open') DESC, c.anchor_date LIMIT ${q.pageSize} OFFSET ${offsetOf(q)}`,
          [...args, await orgToday(db, a.tenantId)],
        )
      ).rows;
      return paged(rows, total, q);
    });
  });

  only(app, 'core.onboarding').post('/checklists', { schema: { body: ChecklistsBody }, config: { perm: ['lifecycle.manage'], feature: [ON] } }, async (req, reply) => {
    const a = tenantActor(req, 'lifecycle.manage');
    const b = ChecklistsBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, ON);
      const e = await loadEmp(db, a.tenantId, b.employeeId);
      if (!e) throw notFound('Employee not found');
      if (['exited', 'inactive'].includes(e.status)) throw conflict('This employee has left');
      const id = await createChecklist(db, a.tenantId, {
        kind: 'onboarding',
        employeeId: b.employeeId,
        anchorDate: e.date_of_joining,
        templateId: b.templateId,
        actorId: a.user.userId,
      });
      if (!id) throw badRequest('No active onboarding template (set a default template first)');
      await audit(db, { ...a.auditBase, action: 'lifecycle.checklist_started', targetType: 'checklist', targetId: id, metadata: { kind: 'onboarding', employeeId: b.employeeId } });
      reply.code(201);
      return { id };
    });
  });

  async function checklistDetail(db: Db, a: TenantActor, id: string) {
    const c = (
      await db.query<{ id: string; kind: 'onboarding' | 'offboarding'; employee_id: string; status: string; anchor_date: string; separation_id: string | null }>(
        `SELECT id, kind, employee_id, status, anchor_date::text, separation_id FROM checklists WHERE tenant_id=$1 AND id=$2`,
        [a.tenantId, id],
      )
    ).rows[0];
    if (!c) throw notFound('Checklist not found');
    await requireFeature(db, a.tenantId, featureFor(c.kind));
    const emp = (await loadEmp(db, a.tenantId, c.employee_id))!;
    const reader = a.has('lifecycle.manage') || a.has('lifecycle.read');
    const self = emp.user_id === a.user.userId;
    const mgr = emp.manager_user_id === a.user.userId;
    if (!reader && !self && !mgr) throw notFound('Checklist not found');
    const tasks = (
      await db.query<{ owner: Owner }>(
        `SELECT t.id, t.position, t.title, t.description, t.owner, t.due_date::text, t.status, t.note, t.done_at, u.display_name AS done_by_name
      FROM checklist_tasks t LEFT JOIN users u ON u.id=t.done_by WHERE t.tenant_id=$1 AND t.checklist_id=$2 ORDER BY t.due_date, t.position`,
        [a.tenantId, id],
      )
    ).rows.map((t) => ({ ...t, canAct: canActOnTask(t.owner, emp, { userId: a.user.userId, permissions: a.user.permissions }) }));
    return { ...c, employee: { id: emp.id, name: emp.name, status: emp.status }, tasks };
  }
  app.get('/checklists/:id', { schema: { params: IdParams } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    return a.tx((db) => checklistDetail(db, a, id));
  });
  only(app, 'core.onboarding').post(
    '/checklists/:id/cancel',
    { schema: { params: IdParams, body: ChecklistsCancelBody }, config: { perm: ['lifecycle.manage'], feature: [ON] } },
    async (req) => {
      const a = tenantActor(req, 'lifecycle.manage');
      const { id } = IdParams.parse(req.params);
      const { reason } = ChecklistsCancelBody.parse(req.body);
      return a.tx(async (db) => {
        await requireFeature(db, a.tenantId, ON);
        const r = await db.query(`UPDATE checklists SET status='cancelled' WHERE tenant_id=$1 AND id=$2 AND status='open' AND separation_id IS NULL`, [a.tenantId, id]);
        if (!r.rowCount) throw conflict('Only open onboarding checklists can be cancelled (exit clearance follows its separation)');
        await audit(db, { ...a.auditBase, action: 'lifecycle.checklist_cancelled', targetType: 'checklist', targetId: id, metadata: { reason } });
        return { ok: true };
      });
    },
  );

  // ------------------------------------------------------------ tasks
  app.get('/tasks/mine', { schema: {} }, async (req) => {
    const a = tenantActor(req);
    return a.tx(async (db) => {
      const rows = (
        await db.query<{ owner: Owner; user_id: string | null; manager_user_id: string | null; kind: 'onboarding' | 'offboarding' }>(
          `SELECT t.id, t.title, t.description, t.owner, t.due_date::text, t.checklist_id, c.kind,
          e.id AS employee_id, trim(e.first_name||' '||coalesce(e.last_name,'')) AS employee_name, e.user_id, m.user_id AS manager_user_id
        FROM checklist_tasks t JOIN checklists c ON c.tenant_id=t.tenant_id AND c.id=t.checklist_id AND c.status='open'
        JOIN employees e ON e.tenant_id=c.tenant_id AND e.id=c.employee_id LEFT JOIN employees m ON m.tenant_id=e.tenant_id AND m.id=e.reporting_manager_id
        WHERE t.tenant_id=$1 AND t.status='pending' ORDER BY t.due_date LIMIT 500`,
          [a.tenantId],
        )
      ).rows;
      // "Mine" = tasks of my group (not everything lifecycle.manage could technically complete).
      const features = await evaluateFeatures(db, a.tenantId);
      const mine = rows
        .filter((t) => features.get(featureFor(t.kind))?.usable)
        .filter((t) => (t.owner === 'employee' ? t.user_id === a.user.userId : t.owner === 'manager' ? t.manager_user_id === a.user.userId : a.has(OWNER_PERMISSION[t.owner]!)));
      return { date: await orgToday(db, a.tenantId), items: mine.map(({ user_id: _u, manager_user_id: _m, ...t }) => t) };
    });
  });

  const TasksBody = (action: 'done' | 'skip' | 'reopen') => z.object({ note: action === 'skip' ? z.string().trim().min(3).max(500) : Text(500) });
  const taskAction = (action: 'done' | 'skip' | 'reopen', Body = TasksBody(action)) =>
    app.post(`/tasks/:id/${action}`, { schema: { params: IdParams, body: Body }, config: { perm: action === 'done' ? [] : ['lifecycle.manage'] } }, async (req) => {
      const a = action === 'done' ? tenantActor(req) : tenantActor(req, 'lifecycle.manage');
      const { id } = IdParams.parse(req.params);
      const { note } = Body.parse(req.body ?? {});
      return a.tx(async (db) => {
        const t = (
          await db.query<{ owner: Owner; status: string; checklist_id: string; employee_id: string; cstatus: string; kind: 'onboarding' | 'offboarding' }>(
            `SELECT t.owner, t.status, t.checklist_id, c.employee_id, c.status AS cstatus, c.kind
        FROM checklist_tasks t JOIN checklists c ON c.tenant_id=t.tenant_id AND c.id=t.checklist_id WHERE t.tenant_id=$1 AND t.id=$2 FOR UPDATE OF t`,
            [a.tenantId, id],
          )
        ).rows[0];
        if (!t) throw notFound('Task not found');
        await requireFeature(db, a.tenantId, featureFor(t.kind));
        const emp = (await loadEmp(db, a.tenantId, t.employee_id))!;
        if (!canActOnTask(t.owner, emp, { userId: a.user.userId, permissions: a.user.permissions })) throw notFound('Task not found');
        if (t.cstatus !== 'open' && action !== 'reopen') throw conflict(`This checklist is ${t.cstatus}`);
        if (action === 'reopen') {
          if (t.status === 'pending') throw conflict('Task is already pending');
          await db.query(`UPDATE checklist_tasks SET status='pending', done_by=NULL, done_at=NULL, note=$3 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, note]);
          await db.query(`UPDATE checklists SET status='open', completed_at=NULL WHERE tenant_id=$1 AND id=$2 AND status='completed'`, [a.tenantId, t.checklist_id]);
        } else {
          if (t.status !== 'pending') throw conflict(`Task is already ${t.status}`);
          await db.query(`UPDATE checklist_tasks SET status=$3, note=$4, done_by=$5, done_at=now() WHERE tenant_id=$1 AND id=$2`, [
            a.tenantId,
            id,
            action === 'done' ? 'done' : 'skipped',
            note,
            a.user.userId,
          ]);
          await maybeCompleteChecklist(db, a.tenantId, t.checklist_id);
        }
        await audit(db, { ...a.auditBase, action: `lifecycle.task_${action}`, targetType: 'checklist_task', targetId: id, metadata: { note } });
        return { ok: true };
      });
    });
  taskAction('done');
  taskAction('skip');
  taskAction('reopen');

  /** Pre-joining → active on (or after) the joining date. */
  only(app, 'core.onboarding').post('/employees/:id/joined', { schema: { params: IdParams }, config: { perm: ['lifecycle.manage'], feature: [ON] } }, async (req) => {
    const a = tenantActor(req, 'lifecycle.manage');
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, ON);
      const e = await loadEmp(db, a.tenantId, id);
      if (!e) throw notFound('Employee not found');
      if (e.status !== 'pre_joining') throw conflict(`Employee is ${e.status}`);
      if (e.date_of_joining > (await orgToday(db, a.tenantId))) throw conflict(`Joining date is ${e.date_of_joining}; confirm on or after that day`);
      await db.query(`UPDATE employees SET status='active', version=version+1, updated_at=now() WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      await audit(db, { ...a.auditBase, action: 'lifecycle.joined', targetType: 'employee', targetId: id, metadata: { dateOfJoining: e.date_of_joining } });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ probation
  only(app, 'core.onboarding').get('/probation', { schema: { querystring: ProbationQuery }, config: { feature: [ON] } }, async (req) => {
    const a = tenantActor(req);
    const q = ProbationQuery.parse(req.query);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, ON);
      const all = a.has('lifecycle.manage') || a.has('lifecycle.read');
      return {
        items: (
          await db.query(
            `SELECT r.id, r.employee_id, e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS employee_name, e.designation, e.date_of_joining::text,
          r.probation_end::text, r.status, r.recommendation, r.extend_months, r.comments, r.submitted_at, r.decided_at, u.display_name AS submitted_by_name
        FROM probation_reviews r JOIN employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id LEFT JOIN employees m ON m.tenant_id=e.tenant_id AND m.id=e.reporting_manager_id
        LEFT JOIN users u ON u.id=r.submitted_by
        WHERE r.tenant_id=$1 AND ($2::text IS NULL OR r.status=$2) AND ($3 OR m.user_id=$4) ORDER BY r.probation_end`,
            [a.tenantId, q.status ?? null, all, a.user.userId],
          )
        ).rows,
      };
    });
  });

  only(app, 'core.onboarding').post('/probation/:id/submit', { schema: { params: IdParams, body: ProbationSubmitBody }, config: { feature: [ON] } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    const b = ProbationSubmitBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, ON);
      const r = (
        await db.query<{ employee_id: string; status: string; probation_end: string }>(
          `SELECT employee_id, status, probation_end::text FROM probation_reviews WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [a.tenantId, id],
        )
      ).rows[0];
      if (!r) throw notFound('Review not found');
      const emp = (await loadEmp(db, a.tenantId, r.employee_id))!;
      if (emp.manager_user_id !== a.user.userId && !a.has('lifecycle.manage')) throw notFound('Review not found');
      if (emp.user_id === a.user.userId) throw forbidden('You cannot review your own probation');
      if (r.status !== 'open') throw conflict(`This review is ${r.status}`);
      await db.query(
        `UPDATE probation_reviews SET status='pending', recommendation=$3, extend_months=$4, comments=$5, submitted_by=$6, submitted_at=now() WHERE tenant_id=$1 AND id=$2`,
        [a.tenantId, id, b.recommendation, b.recommendation === 'extend' ? b.extendMonths : null, b.comments, a.user.userId],
      );
      const steps: StepSpec[] = [{ kind: 'permission', permission: 'lifecycle.manage' }];
      const approvalId = await createApprovalRequest(db, a.tenantId, {
        entityType: 'probation_review',
        entityId: id,
        requesterId: a.user.userId,
        summary: `${emp.name}: ${b.recommendation}${b.recommendation === 'extend' ? ` by ${b.extendMonths} month(s)` : ''} (probation ends ${r.probation_end})`,
        steps,
        excludeUserIds: [emp.user_id],
      });
      await audit(db, {
        ...a.auditBase,
        action: 'lifecycle.probation_submitted',
        targetType: 'probation_review',
        targetId: id,
        metadata: { recommendation: b.recommendation, approvalId },
      });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ separations
  async function noticeShortfall(db: Db, tenantId: string, noticeDate: string, lwd: string) {
    const required = await getSettingValue<number>(db, tenantId, 'offboarding.notice_days');
    return { required, shortfall: Math.max(0, required - daysBetween(noticeDate, lwd)) };
  }
  async function startSeparation(
    db: Db,
    a: TenantActor,
    p: { employeeId: string; kind: (typeof SEPARATION_KINDS)[number]; reason: string; noticeDate: string; requestedLwd: string },
  ) {
    await requireFeature(db, a.tenantId, OFF);
    const emp = await loadEmp(db, a.tenantId, p.employeeId);
    if (!emp) throw notFound('Employee not found');
    if (!['active', 'pre_joining', 'on_notice'].includes(emp.status)) throw conflict(`Employee is ${emp.status}`);
    if (p.requestedLwd < p.noticeDate) throw badRequest('Last working day cannot be before the notice date');
    if (p.requestedLwd < emp.date_of_joining)
      throw badRequest(`Last working day cannot be before the joining date (${emp.date_of_joining}); for someone who never joined, mark the employee inactive instead`);
    const n = await noticeShortfall(db, a.tenantId, p.noticeDate, p.requestedLwd);
    const id = (
      await db.query<{ id: string }>(
        `INSERT INTO separations (tenant_id, employee_id, kind, reason, notice_date, requested_lwd, notice_days_required, shortfall_days, initiated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [a.tenantId, p.employeeId, p.kind, p.reason, p.noticeDate, p.requestedLwd, n.required, n.shortfall, a.user.userId],
      )
    ).rows[0]!.id;
    // Resignations: reporting manager, then HR. HR-initiated: a second HR approver (maker-checker).
    const steps = buildSteps({ requesterId: a.user.userId, managerUserId: p.kind === 'resignation' ? emp.manager_user_id : null, then: ['lifecycle.manage'] });
    const approvalId = await createApprovalRequest(db, a.tenantId, {
      entityType: 'separation',
      entityId: id,
      requesterId: a.user.userId,
      summary: `${emp.name}: ${p.kind.replace('_', ' ')}, last day ${p.requestedLwd}${n.shortfall ? ` (notice short by ${n.shortfall} days)` : ''}`,
      steps,
      excludeUserIds: [emp.user_id],
    }); // nobody approves their own separation
    await audit(db, {
      ...a.auditBase,
      action: 'lifecycle.separation_started',
      targetType: 'separation',
      targetId: id,
      metadata: { kind: p.kind, requestedLwd: p.requestedLwd, shortfall: n.shortfall, approvalId },
    });
    return { id, shortfallDays: n.shortfall, noticeDaysRequired: n.required };
  }

  only(app, 'core.offboarding').post('/separations/resign', { schema: { body: SeparationsResignBody }, config: { perm: ['lifecycle.self'] } }, async (req, reply) => {
    const a = tenantActor(req, 'lifecycle.self');
    const b = SeparationsResignBody.parse(req.body);
    if (!a.user.employeeId) throw badRequest('Your account is not linked to an employee record');
    return a.tx(async (db) => {
      const r = await startSeparation(db, a, {
        employeeId: a.user.employeeId!,
        kind: 'resignation',
        reason: b.reason,
        noticeDate: await orgToday(db, a.tenantId),
        requestedLwd: b.requestedLwd,
      });
      reply.code(201);
      return r;
    });
  });
  only(app, 'core.offboarding').post('/separations', { schema: { body: SeparationsBody }, config: { perm: ['lifecycle.manage'] } }, async (req, reply) => {
    const a = tenantActor(req, 'lifecycle.manage');
    const b = SeparationsBody.parse(req.body);
    if (b.employeeId === a.user.employeeId) throw forbidden('Use "Resign" for your own separation');
    return a.tx(async (db) => {
      await assertOutranks(db, a.tenantId, { level: a.user.salaryLevel }, b.employeeId);
      const r = await startSeparation(db, a, b);
      reply.code(201);
      return r;
    });
  });

  async function loadSeparation(db: Db, a: TenantActor, id: string, lock = false) {
    await requireFeature(db, a.tenantId, OFF);
    const s = (
      await db.query<{
        id: string;
        employee_id: string;
        status: string;
        initiated_by: string;
        approved_lwd: string | null;
        requested_lwd: string;
        notice_date: string;
        kind: string;
      }>(
        `SELECT id, employee_id, status, initiated_by, approved_lwd::text, requested_lwd::text, notice_date::text, kind FROM separations WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
        [a.tenantId, id],
      )
    ).rows[0];
    if (!s) throw notFound('Separation not found');
    const emp = (await loadEmp(db, a.tenantId, s.employee_id))!;
    const hr = a.has('lifecycle.manage') || a.has('lifecycle.read');
    if (!hr && emp.user_id !== a.user.userId && emp.manager_user_id !== a.user.userId) throw notFound('Separation not found');
    return { s, emp, hr };
  }

  only(app, 'core.offboarding').get('/separations', { schema: { querystring: SeparationsQuery }, config: { feature: [OFF] } }, async (req) => {
    const a = tenantActor(req);
    const q = SeparationsQuery.parse(req.query);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, OFF);
      const all = (a.has('lifecycle.manage') || a.has('lifecycle.read')) && q.scope === 'all';
      const where = `s.tenant_id=$1 AND ($2::text IS NULL OR s.status=$2) AND ($3 OR ($4='mine' AND e.user_id=$5) OR ($4='team' AND m.user_id=$5))`;
      const args = [a.tenantId, q.status ?? null, all, q.scope, a.user.userId];
      const from = `FROM separations s JOIN employees e ON e.tenant_id=s.tenant_id AND e.id=s.employee_id LEFT JOIN employees m ON m.tenant_id=e.tenant_id AND m.id=e.reporting_manager_id`;
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n ${from} WHERE ${where}`, args)).rows[0]!.n);
      const rows = (
        await db.query(
          `SELECT s.id, s.kind, s.status, s.notice_date::text, s.requested_lwd::text, s.approved_lwd::text, s.shortfall_days, s.waive_shortfall, s.fnf_status, s.created_at,
          e.id AS employee_id, e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS employee_name, e.designation
        ${from} WHERE ${where} ORDER BY s.created_at DESC LIMIT ${q.pageSize} OFFSET ${offsetOf(q)}`,
          args,
        )
      ).rows;
      return paged(rows, total, q);
    });
  });

  only(app, 'core.offboarding').get('/separations/:id', { schema: { params: IdParams }, config: { feature: [OFF] } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, OFF);
      const { emp, hr } = await loadSeparation(db, a, id);
      const s = (
        await db.query(
          `SELECT s.*, s.notice_date::text, s.requested_lwd::text, s.approved_lwd::text, u.display_name AS initiated_by_name FROM separations s JOIN users u ON u.id=s.initiated_by
        WHERE s.tenant_id=$1 AND s.id=$2`,
          [a.tenantId, id],
        )
      ).rows[0]!;
      const checklist = (await db.query<{ id: string }>(`SELECT id FROM checklists WHERE tenant_id=$1 AND separation_id=$2 ORDER BY created_at DESC LIMIT 1`, [a.tenantId, id]))
        .rows[0];
      // Leave balances at exit (input to F&F; encashment rules are decided in payroll).
      // L3 (D39): the person, HR above them, and whoever decides while it is pending.
      const l3 = await subjectVisible(db, a.tenantId, await policyViewer(db, a.tenantId, a.user), emp.id, l3RowFilter);
      const decides = s.status === 'pending' && (a.has('lifecycle.manage') || emp.manager_user_id === a.user.userId);
      const leave = hr && l3 ? (await balancesAt(db, a.tenantId, emp.id, s.approved_lwd ?? s.requested_lwd)).items : [];
      return {
        ...(l3 || decides ? s : maskFields(s, ['reason', 'fnf_note'])),
        exit_interview: hr && l3 ? s.exit_interview : undefined,
        employee: { id: emp.id, name: emp.name, status: emp.status },
        checklist: checklist ? await checklistDetail(db, a, checklist.id) : null,
        leaveBalances: leave,
      };
    });
  });

  only(app, 'core.offboarding').put('/separations/:id/lwd', { schema: { params: IdParams, body: SeparationsLwdBody }, config: { perm: ['lifecycle.manage'] } }, async (req) => {
    const a = tenantActor(req, 'lifecycle.manage');
    const { id } = IdParams.parse(req.params);
    const b = SeparationsLwdBody.parse(req.body);
    return a.tx(async (db) => {
      const { s } = await loadSeparation(db, a, id, true);
      if (s.status !== 'pending') throw conflict('The last working day can be changed only before approval');
      if (b.approvedLwd < s.notice_date) throw badRequest('Last working day cannot be before the notice date');
      const doj = (await db.query<{ d: string }>('SELECT date_of_joining::text AS d FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, s.employee_id])).rows[0]!.d;
      if (b.approvedLwd < doj) throw badRequest(`Last working day cannot be before the joining date (${doj})`);
      const n = await noticeShortfall(db, a.tenantId, s.notice_date, b.approvedLwd);
      await db.query(`UPDATE separations SET approved_lwd=$3, shortfall_days=$4, waive_shortfall=$5 WHERE tenant_id=$1 AND id=$2`, [
        a.tenantId,
        id,
        b.approvedLwd,
        n.shortfall,
        b.waiveShortfall,
      ]);
      await audit(db, { ...a.auditBase, action: 'lifecycle.separation_lwd_set', targetType: 'separation', targetId: id, metadata: { ...b, shortfall: n.shortfall } });
      return { ok: true, shortfallDays: n.shortfall };
    });
  });

  only(app, 'core.offboarding').post('/separations/:id/withdraw', { schema: { params: IdParams } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      const { s } = await loadSeparation(db, a, id, true);
      if (s.status !== 'pending') throw conflict('Only a pending separation can be withdrawn; after approval HR cancels it');
      const ar = (
        await db.query<{ id: string }>(`SELECT id FROM approval_requests WHERE tenant_id=$1 AND entity_type='separation' AND entity_id=$2 AND status='pending'`, [a.tenantId, id])
      ).rows[0];
      if (!ar) throw conflict('No pending approval');
      await cancelRequest(db, a.tenantId, ar.id, a.user.userId, { requestId: req.id, ip: req.ctx.ip }); // requester only
      return { ok: true };
    });
  });

  /** HR cancels an approved separation before the last working day (resignation withdrawn by agreement). */
  only(app, 'core.offboarding').post(
    '/separations/:id/cancel',
    { schema: { params: IdParams, body: ChecklistsCancelBody }, config: { perm: ['lifecycle.manage'] } },
    async (req) => {
      const a = tenantActor(req, 'lifecycle.manage');
      const { id } = IdParams.parse(req.params);
      const { reason } = ChecklistsCancelBody.parse(req.body);
      return a.tx(async (db) => {
        const { s } = await loadSeparation(db, a, id, true);
        if (s.status !== 'approved') throw conflict(`A ${s.status} separation cannot be cancelled here`);
        if ((s.approved_lwd ?? s.requested_lwd) < (await orgToday(db, a.tenantId))) throw conflict('The last working day has passed');
        await db.query(`UPDATE separations SET status='cancelled' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
        await db.query(`UPDATE employees SET status='active', exit_date=NULL, version=version+1, updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='on_notice'`, [
          a.tenantId,
          s.employee_id,
        ]);
        await db.query(`UPDATE checklists SET status='cancelled' WHERE tenant_id=$1 AND separation_id=$2 AND status='open'`, [a.tenantId, id]);
        await audit(db, { ...a.auditBase, action: 'lifecycle.separation_cancelled', targetType: 'separation', targetId: id, metadata: { reason } });
        return { ok: true };
      });
    },
  );

  only(app, 'core.offboarding').post('/separations/:id/exit-interview', { schema: { params: IdParams, body: SeparationsExitInterviewBody } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    const b = SeparationsExitInterviewBody.parse(req.body);
    return a.tx(async (db) => {
      const { s, emp } = await loadSeparation(db, a, id, true);
      if (!a.has('lifecycle.manage') && emp.user_id !== a.user.userId) throw forbidden('Only the employee or HR can record the exit interview');
      if (!['approved', 'completed'].includes(s.status)) throw conflict('The exit interview is recorded after the separation is approved');
      await db.query(`UPDATE separations SET exit_interview=$3 WHERE tenant_id=$1 AND id=$2`, [
        a.tenantId,
        id,
        JSON.stringify({ ...b.answers, _recorded_by: a.user.userId, _at: new Date().toISOString() }),
      ]);
      await audit(db, { ...a.auditBase, action: 'lifecycle.exit_interview', targetType: 'separation', targetId: id, metadata: { questions: Object.keys(b.answers).length } });
      return { ok: true };
    });
  });

  only(app, 'core.offboarding').post('/separations/:id/fnf', { schema: { params: IdParams, body: SeparationsFnfBody }, config: { perm: ['lifecycle.manage'] } }, async (req) => {
    const a = tenantActor(req, 'lifecycle.manage');
    const { id } = IdParams.parse(req.params);
    const b = SeparationsFnfBody.parse(req.body);
    return a.tx(async (db) => {
      await loadSeparation(db, a, id, true);
      await db.query(`UPDATE separations SET fnf_status=$3, fnf_note=$4 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, b.status, b.note === null ? null : scrubAmounts(b.note)]);
      await audit(db, { ...a.auditBase, action: 'lifecycle.fnf_updated', targetType: 'separation', targetId: id, metadata: { status: b.status, fields: ['note'] } });
      return { ok: true };
    });
  });

  only(app, 'core.offboarding').post(
    '/separations/:id/complete',
    { schema: { params: IdParams, body: SeparationsCompleteBody }, config: { perm: ['lifecycle.manage'] } },
    async (req) => {
      const a = tenantActor(req, 'lifecycle.manage');
      const { id } = IdParams.parse(req.params);
      const b = SeparationsCompleteBody.parse(req.body);
      return a.tx(async (db) => {
        const { s } = await loadSeparation(db, a, id, true);
        if (s.status !== 'approved') throw conflict(`A ${s.status} separation cannot be completed`);
        const lwd = s.approved_lwd ?? s.requested_lwd;
        if (lwd > (await orgToday(db, a.tenantId))) throw conflict(`The last working day is ${lwd}`);
        const open = (
          await db.query<{ n: string }>(
            `SELECT count(*) AS n FROM checklist_tasks t JOIN checklists c ON c.tenant_id=t.tenant_id AND c.id=t.checklist_id
        WHERE t.tenant_id=$1 AND c.separation_id=$2 AND c.status <> 'cancelled' AND t.status='pending'`,
            [a.tenantId, id],
          )
        ).rows[0]!.n;
        if (Number(open) > 0) throw conflict(`${open} clearance task(s) are still pending`);
        if (await featureOn(db, a.tenantId, 'assets')) {
          const held = await openAssets(db, a.tenantId, s.employee_id);
          if (held.length) throw conflict(`Assets not returned: ${held.map((h) => `${h.tag} ${h.name}`).join(', ')}. Receive them (or record them as lost) first.`);
        }
        await db.query(`UPDATE separations SET status='completed', rehire_eligible=$3, completed_at=now() WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, b.rehireEligible]);
        await db.query(`UPDATE employees SET status='exited', exit_date=$3, version=version+1, updated_at=now() WHERE tenant_id=$1 AND id=$2`, [a.tenantId, s.employee_id, lwd]);
        await endAccess(db, a.tenantId, s.employee_id);
        await audit(db, { ...a.auditBase, action: 'lifecycle.separation_completed', targetType: 'separation', targetId: id, metadata: { rehireEligible: b.rehireEligible } });
        return { ok: true };
      });
    },
  );
}

/**
 * Daily job: (1) remind task assignees (due today / overdue, weekly), (2) open probation reviews ahead of
 * the end date, (3) end system access for people whose last working day has passed.
 */
export async function lifecycleDaily(db: Db, tenantId: string, today: string) {
  let reminders = 0;
  let reviews = 0;
  let accessEnded = 0;
  const tasks = (
    await db.query<{ id: string; kind: 'onboarding' | 'offboarding'; title: string; owner: Owner; due_date: string; employee_id: string; overdue: number }>(
      `SELECT c.kind, t.id, t.title, t.owner, t.due_date::text, c.employee_id, ($2::date - t.due_date) AS overdue
    FROM checklist_tasks t JOIN checklists c ON c.tenant_id=t.tenant_id AND c.id=t.checklist_id AND c.status='open'
    WHERE t.tenant_id=$1 AND t.status='pending' AND t.due_date <= $2::date AND ($2::date - t.due_date) % 7 = 0`,
      [tenantId, today],
    )
  ).rows;
  for (const t of tasks) {
    const emp = (await loadEmp(db, tenantId, t.employee_id))!;
    const r = await notifyUsers(db, tenantId, await taskAssignees(db, tenantId, t.owner, emp), {
      kind: 'lifecycle.task_due',
      feature: featureFor(t.kind),
      title: `${t.overdue ? 'Overdue' : 'Due today'}: ${t.title} (${emp.name})`,
      body: `Due ${t.due_date}.`,
      link: '/lifecycle?tab=tasks',
      actionLabel: 'Open tasks',
      dedupeKey: `task:${t.id}:${t.overdue}`,
    });
    reminders += r.inApp;
  }
  if (await featureOn(db, tenantId, 'core.onboarding')) {
    const lead = await getSettingValue<number>(db, tenantId, 'probation.review_lead_days');
    const due = (
      await db.query<{ id: string; probation_end_date: string }>(
        `SELECT e.id, e.probation_end_date::text FROM employees e WHERE e.tenant_id=$1 AND e.status IN ('active','on_notice')
      AND e.probation_end_date IS NOT NULL AND e.confirmation_date IS NULL AND e.probation_end_date <= $2::date + $3::int AND e.probation_end_date >= $2::date
      AND NOT EXISTS (SELECT 1 FROM probation_reviews r WHERE r.tenant_id=e.tenant_id AND r.employee_id=e.id AND r.probation_end=e.probation_end_date)`,
        [tenantId, today, lead],
      )
    ).rows;
    for (const e of due) {
      await db.query(`INSERT INTO probation_reviews (tenant_id, employee_id, probation_end) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId, e.id, e.probation_end_date]);
      const emp = (await loadEmp(db, tenantId, e.id))!;
      const to = emp.manager_user_id ? [emp.manager_user_id] : await usersWithPermission(db, tenantId, 'lifecycle.manage');
      await notifyUsers(db, tenantId, to, {
        kind: 'lifecycle.probation',
        title: `Probation review: ${emp.name}`,
        body: `Probation ends ${e.probation_end_date}. Recommend confirm, extend or terminate.`,
        link: '/lifecycle?tab=probation',
        actionLabel: 'Review',
        dedupeKey: `probation:${e.id}:${e.probation_end_date}`,
      });
      reviews++;
    }
  }
  if (!(await featureOn(db, tenantId, 'core.offboarding'))) return { reminders, probationReviewsOpened: reviews, accessEnded };
  const leaving = (
    await db.query<{ employee_id: string }>(
      `SELECT s.employee_id FROM separations s JOIN employees e ON e.tenant_id=s.tenant_id AND e.id=s.employee_id
    JOIN users u ON u.id=e.user_id WHERE s.tenant_id=$1 AND s.status='approved' AND coalesce(s.approved_lwd, s.requested_lwd) < $2::date AND u.status <> 'disabled'`,
      [tenantId, today],
    )
  ).rows;
  for (const l of leaving) {
    if (await endAccess(db, tenantId, l.employee_id)) accessEnded++;
  }
  return { reminders, probationReviewsOpened: reviews, accessEnded };
}
