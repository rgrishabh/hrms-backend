import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantActor } from '../http/context.js';
import { Uuid } from '../http/pagination.js';
import { actOnRequest, cancelRequest, inbox, requestHistory } from './engine.js';
import { notFound, forbidden } from '../http/errors.js';
import { delegationRoutes } from './delegations.js';

export async function approvalRoutes(app: FastifyInstance) {
  await delegationRoutes(app);

  app.get('/inbox', async (req) => {
    const a = tenantActor(req);
    return a.tx(async (db) => ({ items: await inbox(db, a.tenantId, { userId: a.user.userId, permissions: a.user.permissions }) }));
  });

  app.get('/mine', async (req) => {
    const a = tenantActor(req);
    return a.tx(async (db) => ({ items: (await db.query(`SELECT id, entity_type, entity_id, summary, status, created_at, decided_at
      FROM approval_requests WHERE tenant_id=$1 AND requester_id=$2 ORDER BY created_at DESC LIMIT 100`, [a.tenantId, a.user.userId])).rows }));
  });

  app.get('/:id', async (req) => {
    const a = tenantActor(req);
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const r = await db.query<{ requester_id: string }>(`SELECT id, entity_type, entity_id, summary, status, requester_id, created_at, decided_at
        FROM approval_requests WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
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

  app.post('/:id/act', async (req) => {
    const a = tenantActor(req);
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const body = z.object({ action: z.enum(['approve', 'reject', 'return']), comment: z.string().trim().max(1000).optional() }).parse(req.body);
    return a.tx((db) => actOnRequest(db, a.tenantId, id, { userId: a.user.userId, permissions: a.user.permissions }, body.action, body.comment,
      { requestId: req.id, ip: req.ctx.ip }));
  });

  app.post('/:id/cancel', async (req) => {
    const a = tenantActor(req);
    const { id } = z.object({ id: Uuid }).parse(req.params);
    await a.tx((db) => cancelRequest(db, a.tenantId, id, a.user.userId, { requestId: req.id, ip: req.ctx.ip }));
    return { ok: true };
  });
}
