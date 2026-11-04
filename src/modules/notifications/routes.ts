import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantActor } from '../../core/http/context.js';
import { PageQuery, offsetOf, paged, Uuid, QueryBool } from '../../core/http/pagination.js';
import { notFound } from '../../core/http/errors.js';

/** A user's own in-app notifications. Every query is scoped to (organization, user). */
export async function notificationRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    const a = tenantActor(req);
    const q = PageQuery.extend({ unread: QueryBool.optional() }).parse(req.query);
    return a.tx(async (db) => {
      const params = [a.tenantId, a.user.userId, q.unread ?? false];
      const where = `tenant_id=$1 AND user_id=$2 AND (NOT $3 OR read_at IS NULL)`;
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM notifications WHERE ${where}`, params)).rows[0]!.n);
      const rows = await db.query(`SELECT id, kind, title, body, link, read_at, created_at FROM notifications WHERE ${where}
        ORDER BY created_at DESC LIMIT $4 OFFSET $5`, [...params, q.pageSize, offsetOf(q)]);
      return paged(rows.rows, total, q);
    });
  });

  app.get('/unread-count', async (req) => {
    const a = tenantActor(req);
    return a.tx(async (db) => ({ unread: Number((await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND read_at IS NULL`, [a.tenantId, a.user.userId])).rows[0]!.n) }));
  });

  app.post('/:id/read', async (req) => {
    const a = tenantActor(req);
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const r = await db.query(`UPDATE notifications SET read_at=coalesce(read_at, now()) WHERE tenant_id=$1 AND user_id=$2 AND id=$3`, [a.tenantId, a.user.userId, id]);
      if (!r.rowCount) throw notFound();
      return { ok: true };
    });
  });

  app.post('/read-all', async (req) => {
    const a = tenantActor(req);
    return a.tx(async (db) => ({ updated: (await db.query(`UPDATE notifications SET read_at=now() WHERE tenant_id=$1 AND user_id=$2 AND read_at IS NULL`,
      [a.tenantId, a.user.userId])).rowCount }));
  });
}
