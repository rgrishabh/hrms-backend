import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantActor, requireFeature, type TenantActor } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { IsoDate, Uuid } from '../../core/http/pagination.js';
import { notifyUsers } from '../../core/notify/service.js';
import type { Db } from '../../db/tx.js';

const F = 'performance';
const Rating = z.number().int().min(1).max(5);

interface Rev { id: string; cycle_id: string; employee_id: string; reviewer_id: string | null; status: string; version: number; emp_user: string | null; reviewer_user: string | null; cycle_status: string; self_review: boolean }
async function loadReview(db: Db, a: TenantActor, id: string, lock = false) {
  const r = (await db.query<Rev>(`SELECT r.id, r.cycle_id, r.employee_id, r.reviewer_id, r.status, r.version, e.user_id AS emp_user, m.user_id AS reviewer_user, c.status AS cycle_status, c.self_review
    FROM performance_reviews r JOIN employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id LEFT JOIN employees m ON m.tenant_id=r.tenant_id AND m.id=r.reviewer_id
    JOIN review_cycles c ON c.tenant_id=r.tenant_id AND c.id=r.cycle_id WHERE r.tenant_id=$1 AND r.id=$2${lock ? ' FOR UPDATE OF r' : ''}`, [a.tenantId, id])).rows[0];
  if (!r) throw notFound('Review not found');
  const role = r.emp_user === a.user.userId ? 'employee' : r.reviewer_user === a.user.userId ? 'manager' : a.has('performance.manage') ? 'hr' : null;
  if (!role) throw notFound('Review not found');
  return { r, role: role as 'employee' | 'manager' | 'hr' };
}
async function goalAccess(db: Db, a: TenantActor, cycleId: string, employeeId: string) {
  const e = (await db.query<{ user_id: string | null; mgr_user: string | null }>(`SELECT e.user_id, m.user_id AS mgr_user FROM employees e LEFT JOIN employees m ON m.tenant_id=e.tenant_id AND m.id=e.reporting_manager_id
    WHERE e.tenant_id=$1 AND e.id=$2`, [a.tenantId, employeeId])).rows[0];
  if (!e) throw notFound('Employee not found');
  const role = e.user_id === a.user.userId ? 'employee' : e.mgr_user === a.user.userId ? 'manager' : a.has('performance.manage') ? 'hr' : null;
  if (!role) throw notFound('Employee not found');
  const c = (await db.query<{ status: string }>('SELECT status FROM review_cycles WHERE tenant_id=$1 AND id=$2', [a.tenantId, cycleId])).rows[0];
  if (!c) throw notFound('Cycle not found');
  return { role, cycleStatus: c.status, empUser: e.user_id, mgrUser: e.mgr_user };
}

export async function performanceRoutes(app: FastifyInstance) {
  app.get('/cycles', async (req) => {
    const a = tenantActor(req);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, F);
      return { items: (await db.query(`SELECT c.id, c.name, c.period_start::text, c.period_end::text, c.self_review, c.status,
          (SELECT count(*)::int FROM performance_reviews r WHERE r.tenant_id=c.tenant_id AND r.cycle_id=c.id) AS reviews,
          (SELECT count(*)::int FROM performance_reviews r WHERE r.tenant_id=c.tenant_id AND r.cycle_id=c.id AND r.status IN ('finalized','acknowledged')) AS finalized
        FROM review_cycles c WHERE c.tenant_id=$1 AND ($2 OR c.status <> 'draft') ORDER BY c.period_end DESC`, [a.tenantId, a.has('performance.manage')])).rows };
    });
  });
  app.post('/cycles', async (req, reply) => {
    const a = tenantActor(req, 'performance.manage');
    const b = z.object({ name: z.string().trim().min(2).max(120), periodStart: IsoDate, periodEnd: IsoDate, selfReview: z.boolean().default(true) }).refine((x) => x.periodEnd > x.periodStart, { message: 'End must be after start', path: ['periodEnd'] }).parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, F);
      const id = (await db.query<{ id: string }>(`INSERT INTO review_cycles (tenant_id, name, period_start, period_end, self_review, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [a.tenantId, b.name, b.periodStart, b.periodEnd, b.selfReview, a.user.userId])).rows[0]!.id;
      await audit(db, { ...a.auditBase, action: 'performance.cycle_created', category: 'configuration', targetType: 'review_cycle', targetId: id, metadata: b });
      reply.code(201); return { id };
    });
  });
  /** Activating creates a review for every active employee who joined before the period ended; their manager reviews. */
  app.post('/cycles/:id/activate', async (req) => {
    const a = tenantActor(req, 'performance.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, F);
      const c = (await db.query<{ status: string; period_end: string; name: string }>(`SELECT status, period_end::text, name FROM review_cycles WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [a.tenantId, id])).rows[0];
      if (!c) throw notFound();
      if (c.status !== 'draft') throw conflict(`Cycle is ${c.status}`);
      const r = await db.query(`INSERT INTO performance_reviews (tenant_id, cycle_id, employee_id, reviewer_id)
        SELECT $1, $2, e.id, e.reporting_manager_id FROM employees e WHERE e.tenant_id=$1 AND e.status IN ('active','on_notice') AND e.date_of_joining < $3::date
        ON CONFLICT DO NOTHING`, [a.tenantId, id, c.period_end]);
      await db.query(`UPDATE review_cycles SET status='active' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      const users = (await db.query<{ user_id: string }>(`SELECT e.user_id FROM performance_reviews r JOIN employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id WHERE r.tenant_id=$1 AND r.cycle_id=$2 AND e.user_id IS NOT NULL`, [a.tenantId, id])).rows.map((x) => x.user_id);
      await notifyUsers(db, a.tenantId, users, { kind: 'performance.cycle', title: `Performance review: ${c.name}`, body: 'Set your goals with your manager and complete your self-review.', link: '/performance', actionLabel: 'Open', dedupeKey: `cycle:${id}` });
      await audit(db, { ...a.auditBase, action: 'performance.cycle_activated', category: 'configuration', targetType: 'review_cycle', targetId: id, metadata: { reviews: r.rowCount } });
      return { ok: true, reviews: r.rowCount };
    });
  });
  app.post('/cycles/:id/close', async (req) => {
    const a = tenantActor(req, 'performance.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const open = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM performance_reviews WHERE tenant_id=$1 AND cycle_id=$2 AND status NOT IN ('finalized','acknowledged')`, [a.tenantId, id])).rows[0]!.n);
      if (open) throw conflict(`${open} review(s) are not finalized`);
      const r = await db.query(`UPDATE review_cycles SET status='closed' WHERE tenant_id=$1 AND id=$2 AND status='active'`, [a.tenantId, id]);
      if (!r.rowCount) throw conflict('Only an active cycle can be closed');
      await audit(db, { ...a.auditBase, action: 'performance.cycle_closed', category: 'configuration', targetType: 'review_cycle', targetId: id });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ goals
  app.get('/cycles/:id/goals/:employeeId', async (req) => {
    const a = tenantActor(req);
    const p = z.object({ id: Uuid, employeeId: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, F);
      await goalAccess(db, a, p.id, p.employeeId);
      const goals = (await db.query(`SELECT id, title, description, measure, weight, status, progress FROM goals WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3 AND status<>'dropped' ORDER BY created_at`, [a.tenantId, p.id, p.employeeId])).rows;
      return { items: goals, totalWeight: goals.reduce((s, g) => s + (g.weight as number), 0) };
    });
  });
  app.post('/cycles/:id/goals/:employeeId', async (req, reply) => {
    const a = tenantActor(req);
    const p = z.object({ id: Uuid, employeeId: Uuid }).parse(req.params);
    const b = z.object({ title: z.string().trim().min(3).max(200), description: z.string().trim().max(2000).nullable().default(null), measure: z.string().trim().max(500).nullable().default(null), weight: z.number().int().min(1).max(100) }).parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, F);
      const g = await goalAccess(db, a, p.id, p.employeeId);
      if (g.cycleStatus !== 'active') throw conflict('Goals are set while the cycle is active');
      const total = Number((await db.query<{ n: string }>(`SELECT coalesce(sum(weight),0) AS n FROM goals WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3 AND status<>'dropped'`, [a.tenantId, p.id, p.employeeId])).rows[0]!.n);
      if (total + b.weight > 100) throw badRequest(`Weights would total ${total + b.weight}%; the maximum is 100%`);
      // A goal set by the manager is agreed at once; one the employee proposes needs the manager's agreement.
      const id = (await db.query<{ id: string }>(`INSERT INTO goals (tenant_id, cycle_id, employee_id, title, description, measure, weight, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [a.tenantId, p.id, p.employeeId, b.title, b.description, b.measure, b.weight, g.role === 'employee' ? 'proposed' : 'agreed', a.user.userId])).rows[0]!.id;
      if (g.role === 'employee' && g.mgrUser) await notifyUsers(db, a.tenantId, [g.mgrUser], { kind: 'performance.goal', title: 'A goal is waiting for your agreement', body: b.title, link: '/performance?tab=team', actionLabel: 'Review' });
      reply.code(201); return { id };
    });
  });
  app.post('/goals/:id/:action', async (req) => {
    const a = tenantActor(req);
    const p = z.object({ id: Uuid, action: z.enum(['agree', 'drop', 'progress']) }).parse(req.params);
    const b = z.object({ progress: z.number().int().min(0).max(100).optional() }).parse(req.body ?? {});
    return a.tx(async (db) => {
      const gl = (await db.query<{ cycle_id: string; employee_id: string; status: string }>('SELECT cycle_id, employee_id, status FROM goals WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, p.id])).rows[0];
      if (!gl) throw notFound('Goal not found');
      const g = await goalAccess(db, a, gl.cycle_id, gl.employee_id);
      if (g.cycleStatus !== 'active') throw conflict('The cycle is not active');
      if (p.action === 'agree') { if (g.role === 'employee') throw forbidden('Your manager agrees your goals'); await db.query(`UPDATE goals SET status='agreed' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, p.id]); }
      else if (p.action === 'drop') { if (g.role === 'employee' && gl.status !== 'proposed') throw forbidden('Ask your manager to drop an agreed goal'); await db.query(`UPDATE goals SET status='dropped' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, p.id]); }
      else { if (b.progress == null) throw badRequest('Give progress 0–100'); await db.query(`UPDATE goals SET progress=$3 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, p.id, b.progress]); }
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ reviews
  app.get('/reviews', async (req) => {
    const a = tenantActor(req);
    const q = z.object({ cycleId: Uuid, scope: z.enum(['mine', 'team', 'all']).default('mine') }).parse(req.query);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, F);
      if (q.scope === 'all' && !a.has('performance.manage')) throw forbidden();
      const rows = (await db.query(`SELECT r.id, r.employee_id, e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS employee_name, e.designation, r.status,
          trim(m.first_name||' '||coalesce(m.last_name,'')) AS reviewer_name, r.self_rating, r.manager_rating, r.final_rating
        FROM performance_reviews r JOIN employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id LEFT JOIN employees m ON m.tenant_id=r.tenant_id AND m.id=r.reviewer_id
        WHERE r.tenant_id=$1 AND r.cycle_id=$2 AND (($3='mine' AND e.user_id=$4) OR ($3='team' AND m.user_id=$4) OR $3='all') ORDER BY e.first_name`, [a.tenantId, q.cycleId, q.scope, a.user.userId])).rows;
      // The employee sees ratings only once finalized.
      return { items: rows.map((r) => (q.scope === 'mine' && !['finalized', 'acknowledged'].includes(r.status as string) ? { ...r, manager_rating: null, final_rating: null } : r)) };
    });
  });
  app.get('/reviews/:id', async (req) => {
    const a = tenantActor(req);
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const { r, role } = await loadReview(db, a, id);
      const d = (await db.query(`SELECT r.*, trim(e.first_name||' '||coalesce(e.last_name,'')) AS employee_name, c.name AS cycle_name, c.period_start::text, c.period_end::text
        FROM performance_reviews r JOIN employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id JOIN review_cycles c ON c.tenant_id=r.tenant_id AND c.id=r.cycle_id WHERE r.tenant_id=$1 AND r.id=$2`, [a.tenantId, id])).rows[0]!;
      const goals = (await db.query(`SELECT id, title, measure, weight, status, progress FROM goals WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3 AND status='agreed' ORDER BY created_at`, [a.tenantId, r.cycle_id, r.employee_id])).rows;
      const hideManager = role === 'employee' && !['finalized', 'acknowledged'].includes(r.status);
      return { ...d, role, goals, manager_rating: hideManager ? null : d.manager_rating, manager_comments: hideManager ? null : d.manager_comments, goal_ratings: hideManager ? {} : d.goal_ratings,
        final_rating: hideManager ? null : d.final_rating, final_comments: hideManager ? null : d.final_comments };
    });
  });
  app.post('/reviews/:id/:step', async (req) => {
    const a = tenantActor(req);
    const p = z.object({ id: Uuid, step: z.enum(['self', 'manager', 'finalize', 'acknowledge']) }).parse(req.params);
    const body = z.object({ rating: Rating.optional(), comments: z.string().trim().max(5000).optional(), goalRatings: z.record(Uuid, Rating).optional(), expectedVersion: z.number().int() }).parse(req.body);
    return a.tx(async (db) => {
      const { r, role } = await loadReview(db, a, p.id, true);
      if (r.version !== body.expectedVersion) throw conflict('The review changed meanwhile. Reload and try again.');
      if (r.cycle_status !== 'active') throw conflict('The cycle is not active');
      const need = (ok: boolean, msg: string) => { if (!ok) throw forbidden(msg); };
      if (p.step === 'self') {
        need(role === 'employee', 'Only the employee writes the self-review');
        if (!r.self_review) throw conflict('This cycle has no self-review');
        if (r.status !== 'not_started') throw conflict('The self-review was already submitted');
        if (!body.rating || !body.comments || body.comments.length < 20) throw badRequest('Give a rating and at least 20 characters of comments');
        await db.query(`UPDATE performance_reviews SET self_rating=$3, self_comments=$4, status='self_submitted', version=version+1 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, p.id, body.rating, body.comments]);
        if (r.reviewer_user) await notifyUsers(db, a.tenantId, [r.reviewer_user], { kind: 'performance.review', title: 'A self-review is ready for you', body: 'Write the manager review.', link: '/performance?tab=team', actionLabel: 'Review' });
      } else if (p.step === 'manager') {
        need(role === 'manager' || (role === 'hr' && !r.reviewer_id), 'Only the reviewing manager writes this review');
        if (!(r.status === 'self_submitted' || (!r.self_review && r.status === 'not_started'))) throw conflict(r.self_review && r.status === 'not_started' ? 'Waiting for the self-review' : 'The manager review was already submitted');
        if (!body.rating || !body.comments || body.comments.length < 20) throw badRequest('Give a rating and at least 20 characters of comments');
        await db.query(`UPDATE performance_reviews SET manager_rating=$3, manager_comments=$4, goal_ratings=$5, status='manager_submitted', version=version+1 WHERE tenant_id=$1 AND id=$2`,
          [a.tenantId, p.id, body.rating, body.comments, JSON.stringify(body.goalRatings ?? {})]);
      } else if (p.step === 'finalize') {
        need(a.has('performance.manage') && role !== 'employee', 'HR finalizes ratings (not on your own review)');
        if (r.status !== 'manager_submitted') throw conflict('The manager review is not submitted yet');
        if (!body.rating) throw badRequest('Give the final rating');
        await db.query(`UPDATE performance_reviews SET final_rating=$3, final_comments=$4, finalized_by=$5, status='finalized', version=version+1 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, p.id, body.rating, body.comments ?? null, a.user.userId]);
        if (r.emp_user) await notifyUsers(db, a.tenantId, [r.emp_user], { kind: 'performance.finalized', title: 'Your performance review is final', body: 'Read it and acknowledge.', link: '/performance', actionLabel: 'Open' });
      } else {
        need(role === 'employee', 'Only the employee acknowledges');
        if (r.status !== 'finalized') throw conflict('The review is not finalized');
        await db.query(`UPDATE performance_reviews SET status='acknowledged', employee_ack_at=now(), employee_ack_note=$3, version=version+1 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, p.id, body.comments ?? null]);
      }
      await audit(db, { ...a.auditBase, action: `performance.review_${p.step}`, category: 'data', targetType: 'performance_review', targetId: p.id, metadata: { rating: body.rating ?? null } });
      return { ok: true };
    });
  });
}
