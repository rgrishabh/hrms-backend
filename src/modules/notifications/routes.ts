import type { FastifyInstance } from 'fastify';
import { only } from '../../core/features/routes.js';
import { z } from 'zod';
import { tenantActor, requireFeature } from '../../core/http/context.js';
import { getPushSender, isAllowedEndpoint } from '../../core/notify/push.js';
import { audit } from '../../core/audit/audit.js';
import { currentFeatures } from '../../core/features/state.js';
import { PageQuery, offsetOf, paged, Uuid, QueryBool } from '../../core/http/pagination.js';
import { badRequest, notFound } from '../../core/http/errors.js';

const enabledFeatures = () => [...currentFeatures()];

const GetRootQuery = PageQuery.extend({ unread: QueryBool.optional() });
const IdParams = z.object({ id: Uuid });
const PushUnsubscribeBody = z.object({ endpoint: z.string().max(1000) });
/** A user's own in-app notifications. Every query is scoped to (organization, user). */
export async function notificationRoutes(app: FastifyInstance) {
  app.get('/', { schema: { querystring: GetRootQuery } }, async (req) => {
    const a = tenantActor(req);
    const q = GetRootQuery.parse(req.query);
    return a.tx(async (db) => {
      const params = [a.tenantId, a.user.userId, q.unread ?? false, enabledFeatures()];
      const where = `tenant_id=$1 AND user_id=$2 AND (NOT $3 OR read_at IS NULL) AND (feature IS NULL OR feature = ANY($4))`;
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM notifications WHERE ${where}`, params)).rows[0]!.n);
      const rows = await db.query(`SELECT id, kind, title, body, link, read_at, created_at FROM notifications WHERE ${where}
        ORDER BY created_at DESC LIMIT $5 OFFSET $6`, [...params, q.pageSize, offsetOf(q)]);
      return paged(rows.rows, total, q);
    });
  });

  app.get('/unread-count', { schema: {} }, async (req) => {
    const a = tenantActor(req);
    return a.tx(async (db) => ({ unread: Number((await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND read_at IS NULL AND (feature IS NULL OR feature = ANY($3))`, [a.tenantId, a.user.userId, enabledFeatures()])).rows[0]!.n) }));
  });

  app.post('/:id/read', { schema: { params: IdParams } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      const r = await db.query(`UPDATE notifications SET read_at=coalesce(read_at, now()) WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND (feature IS NULL OR feature = ANY($4))`, [a.tenantId, a.user.userId, id, enabledFeatures()]);
      if (!r.rowCount) throw notFound();
      return { ok: true };
    });
  });

  app.post('/read-all', { schema: {} }, async (req) => {
    const a = tenantActor(req);
    return a.tx(async (db) => ({ updated: (await db.query(`UPDATE notifications SET read_at=now() WHERE tenant_id=$1 AND user_id=$2 AND read_at IS NULL AND (feature IS NULL OR feature = ANY($3))`,
      [a.tenantId, a.user.userId, enabledFeatures()])).rowCount }));
  });

  // ------------------------------------------------------------ web push (feature notifications.push)
  const PushKey = z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/);
  const Subscribe = z.object({ endpoint: z.url().max(1000), keys: z.object({ p256dh: PushKey.max(200), auth: PushKey.max(100) }) });

  /** The application server key a browser needs to subscribe. */
  only(app, 'notifications.push').get('/push/public-key', { schema: {}, config: { feature: ['notifications.push'] } }, async (req) => {
    const a = tenantActor(req);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'notifications.push');
      return { publicKey: getPushSender()!.publicKey };
    });
  });

  only(app, 'notifications.push').post('/push/subscribe', { schema: { body: Subscribe }, config: { feature: ['notifications.push'] } }, async (req, reply) => {
    const a = tenantActor(req);
    const b = Subscribe.parse(req.body);
    if (!isAllowedEndpoint(b.endpoint)) throw badRequest('This is not a browser push service');
    if (Buffer.from(b.keys.p256dh, 'base64url').length !== 65 || Buffer.from(b.keys.auth, 'base64url').length !== 16) throw badRequest('Invalid subscription keys');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'notifications.push');
      // A browser has one subscription: whoever signed in last on it gets its notifications.
      await db.query(`INSERT INTO push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (tenant_id, endpoint) DO UPDATE SET user_id=$2, p256dh=$4, auth=$5`, [a.tenantId, a.user.userId, b.endpoint, b.keys.p256dh, b.keys.auth]);
      await audit(db, { ...a.auditBase, action: 'notifications.push_subscribed', targetType: 'user', targetId: a.user.userId });
      reply.code(201);
      return { ok: true };
    });
  });

  only(app, 'notifications.push').post('/push/unsubscribe', { schema: { body: PushUnsubscribeBody } }, async (req) => {
    const a = tenantActor(req);
    const b = PushUnsubscribeBody.parse(req.body);
    return a.tx(async (db) => {
      await db.query('DELETE FROM push_subscriptions WHERE tenant_id=$1 AND user_id=$2 AND endpoint=$3', [a.tenantId, a.user.userId, b.endpoint]);
      return { ok: true };
    });
  });
}
