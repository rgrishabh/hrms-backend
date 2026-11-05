import type { FastifyInstance } from 'fastify';
import * as R from '../http/responses.js';
import { z } from 'zod';
import { tenantActor, tenantActorAny } from '../http/context.js';
import { PageQuery, Uuid } from '../http/pagination.js';
import { actOnRequest, cancelRequest, inbox, reassignRequest, requestHistory, stuckRequests, ESCALATION_PERMISSION, offEntityTypes } from './engine.js';
import { notFound, forbidden } from '../http/errors.js';
import { delegationRoutes } from './delegations.js';

const IdParams = z.object({ id: Uuid });
const ReassignBody = z.object({ userId: Uuid, reason: z.string().trim().min(5).max(500) });
const ActBody = z.object({ action: z.enum(['approve', 'reject', 'return']), comment: z.string().trim().max(1000).optional() });
export async function approvalRoutes(app: FastifyInstance) {
  await delegationRoutes(app);

  app.get('/inbox', { schema: { response: { 200: R.GetApprovalsInbox200 },} }, async (req) => {
    const a = tenantActor(req);
    return a.tx(async (db) => ({ items: await inbox(db, a.tenantId, { userId: a.user.userId, permissions: a.user.permissions }) }));
  });

  app.get('/mine', { schema: { response: { 200: R.GetApprovalsMine200 },} }, async (req) => {
    const a = tenantActor(req);
    return a.tx(async (db) => ({ items: (await db.query(`SELECT id, entity_type, entity_id, summary, status, created_at, decided_at
      FROM approval_requests WHERE tenant_id=$1 AND requester_id=$2 AND NOT (entity_type = ANY($3)) ORDER BY created_at DESC LIMIT 100`, [a.tenantId, a.user.userId, offEntityTypes()])).rows }));
  });

  /** For whoever can sort it out: reassigning a request nobody can decide is theirs already (POST /:id/reassign). */
  app.get('/stuck', { schema: { querystring: PageQuery }, config: { perm: ['users.manage'] } }, async (req) => {
    const a = tenantActor(req, 'users.manage');
    const q = PageQuery.parse(req.query);
    return a.tx((db) => stuckRequests(db, a.tenantId, q));
  });

  app.get('/:id', { schema: { response: { 200: R.GetApprovalsById200 }, params: IdParams } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      const r = await db.query<{ requester_id: string }>(`SELECT id, entity_type, entity_id, summary, status, requester_id, created_at, decided_at
        FROM approval_requests WHERE tenant_id=$1 AND id=$2 AND NOT (entity_type = ANY($3))`, [a.tenantId, id, offEntityTypes()]);
      const rq = r.rows[0];
      if (!rq) throw notFound();
      const steps = await requestHistory(db, a.tenantId, id);
      const mine = await inbox(db, a.tenantId, { userId: a.user.userId, permissions: a.user.permissions });
      const involved = rq.requester_id === a.user.userId || mine.some((m) => m.id === id) ||
        (await db.query('SELECT 1 FROM approval_steps WHERE tenant_id=$1 AND request_id=$2 AND (approver_user_id=$3 OR acted_by=$3 OR acted_for=$3 OR escalated_to=$3)', [a.tenantId, id, a.user.userId])).rowCount;
      if (!involved) throw forbidden();
      return { ...rq, steps };
    });
  });

  app.post('/:id/reassign', { schema: { params: IdParams, body: ReassignBody }, config: { permAny: ['users.manage'] } }, async (req) => {
    const a = tenantActorAny(req, ESCALATION_PERMISSION, 'users.manage');
    const { id } = IdParams.parse(req.params);
    const b = ReassignBody.parse(req.body);
    return a.tx(async (db) => {
      await reassignRequest(db, a.tenantId, id, a.user.userId, b.userId, b.reason, { requestId: req.id, ip: req.ip }, { onlyIfStuck: !a.has(ESCALATION_PERMISSION) });
      return { ok: true };
    });
  });

  app.post('/:id/act', { schema: { response: { 200: R.PostApprovalsByIdAct200 }, params: IdParams, body: ActBody } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    const body = ActBody.parse(req.body);
    return a.tx((db) => actOnRequest(db, a.tenantId, id, { userId: a.user.userId, permissions: a.user.permissions }, body.action, body.comment,
      { requestId: req.id, ip: req.ctx.ip }));
  });

  app.post('/:id/cancel', { schema: { params: IdParams } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    await a.tx((db) => cancelRequest(db, a.tenantId, id, a.user.userId, { requestId: req.id, ip: req.ctx.ip }));
    return { ok: true };
  });
}
