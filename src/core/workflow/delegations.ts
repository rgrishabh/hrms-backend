import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantActor, tenantActorAny } from '../http/context.js';
import { Uuid } from '../http/pagination.js';
import { badRequest, conflict, forbidden, notFound } from '../http/errors.js';
import { audit } from '../audit/audit.js';
import { notifyUsers } from '../notify/service.js';
import { addDays } from '../../modules/attendance/time.js';
import { orgToday } from './engine.js';

/**
 * Approval delegation: an approver hands the approvals addressed to them personally to a colleague for a period
 * (leave, travel). Requests already waiting move with it; the approver can still act. HR (`approvals.delegations`)
 * can set one up on someone's behalf, e.g. for an unplanned absence. Delegations do not chain: a delegate covering
 * for someone does not pass that on by delegating their own approvals.
 */
export const DELEGATE_PERMISSION = 'approvals.delegations';
const MAX_DAYS = 90;
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const SELECT = `SELECT d.id, d.delegator_id, gu.display_name AS delegator_name, d.delegate_id, du.display_name AS delegate_name,
    d.starts_on::text AS starts_on, d.ends_on::text AS ends_on, d.note, d.created_at, d.revoked_at, cu.display_name AS created_by_name,
    (d.created_by <> d.delegator_id) AS set_up_by_hr
  FROM approval_delegations d JOIN users gu ON gu.id=d.delegator_id JOIN users du ON du.id=d.delegate_id JOIN users cu ON cu.id=d.created_by`;

const state = (d: { revoked_at: string | null; starts_on: string; ends_on: string }, today: string) =>
  d.revoked_at ? 'revoked' : d.ends_on < today ? 'ended' : d.starts_on > today ? 'scheduled' : 'active';

const DelegatesQuery = z.object({ q: z.string().trim().max(60).optional() });
const DelegationsQuery = z.object({ scope: z.enum(['mine', 'all']).default('mine') });
const DelegationsBody = z.object({
  delegateId: Uuid,
  startsOn: Day,
  endsOn: Day,
  note: z.string().trim().max(300).optional(),
  delegatorId: Uuid.optional(), // HR on someone's behalf
});
const IdParams = z.object({ id: Uuid });
export async function delegationRoutes(app: FastifyInstance) {
  // People who can be chosen as a delegate (active accounts, never yourself).
  app.get('/delegates', { schema: { querystring: DelegatesQuery }, config: { permAny: ['employees.directory', 'employees.read'] } }, async (req) => {
    const a = tenantActorAny(req, 'employees.directory', 'employees.read', DELEGATE_PERMISSION);
    const q = DelegatesQuery.parse(req.query);
    return a.tx(async (db) => ({
      items: (
        await db.query(
          `SELECT u.id, u.display_name AS name, e.employee_code AS code, e.designation
        FROM users u LEFT JOIN employees e ON e.tenant_id=u.tenant_id AND e.user_id=u.id
       WHERE u.tenant_id=$1 AND u.status='active' AND u.id <> $2 AND ($3::text IS NULL OR u.display_name ILIKE '%'||$3||'%' OR e.employee_code ILIKE $3||'%')
       ORDER BY u.display_name LIMIT 20`,
          [a.tenantId, a.user.userId, q.q || null],
        )
      ).rows,
    }));
  });

  app.get('/delegations', { schema: { querystring: DelegationsQuery } }, async (req) => {
    const a = tenantActor(req);
    const { scope } = DelegationsQuery.parse(req.query);
    if (scope === 'all' && !a.has(DELEGATE_PERMISSION)) throw forbidden();
    return a.tx(async (db) => {
      const today = await orgToday(db, a.tenantId);
      const rows = (
        await db.query<{ delegator_id: string; delegate_id: string; revoked_at: string | null; starts_on: string; ends_on: string }>(
          `${SELECT} WHERE d.tenant_id=$1 AND ($2::uuid IS NULL OR d.delegator_id=$2 OR d.delegate_id=$2)
            AND (d.revoked_at IS NULL AND d.ends_on >= $3::date - 30 OR d.revoked_at > now() - interval '30 days')
          ORDER BY d.starts_on DESC, d.created_at DESC LIMIT 200`,
          [a.tenantId, scope === 'all' ? null : a.user.userId, today],
        )
      ).rows.map((d) => ({ ...d, state: state(d, today) }));
      return scope === 'all'
        ? { today, items: rows }
        : { today, given: rows.filter((d) => d.delegator_id === a.user.userId), received: rows.filter((d) => d.delegate_id === a.user.userId) };
    });
  });

  app.post('/delegations', { schema: { body: DelegationsBody } }, async (req, reply) => {
    const a = tenantActor(req);
    const b = DelegationsBody.parse(req.body);
    const delegatorId = b.delegatorId ?? a.user.userId;
    if (delegatorId !== a.user.userId && !a.has(DELEGATE_PERMISSION)) throw forbidden("Only HR can hand over someone else's approvals");
    if (b.delegateId === delegatorId) throw badRequest('Choose someone else to approve while you are away');
    const out = await a.tx(async (db) => {
      const today = await orgToday(db, a.tenantId);
      if (b.startsOn < today) throw badRequest('A delegation cannot start in the past');
      if (b.endsOn < b.startsOn) throw badRequest('The last day must be on or after the first day');
      if (addDays(b.startsOn, MAX_DAYS - 1) < b.endsOn) throw badRequest(`A delegation can last at most ${MAX_DAYS} days`);
      if (b.startsOn > addDays(today, 365)) throw badRequest('A delegation can be set up at most a year ahead');
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`delegation:${delegatorId}`]);
      const people = (
        await db.query<{ id: string; display_name: string; status: string }>('SELECT id, display_name, status FROM users WHERE tenant_id=$1 AND id = ANY($2)', [
          a.tenantId,
          [delegatorId, b.delegateId],
        ])
      ).rows;
      const delegator = people.find((p) => p.id === delegatorId);
      const delegate = people.find((p) => p.id === b.delegateId);
      if (!delegator) throw notFound('User not found');
      if (!delegate || delegate.status !== 'active') throw badRequest('The delegate must have an active account');
      const overlaps = `d.tenant_id=$1 AND d.revoked_at IS NULL AND d.starts_on <= $4::date AND d.ends_on >= $3::date`;
      const own = await db.query<{ delegate_name: string; starts_on: string; ends_on: string }>(`${SELECT} WHERE ${overlaps} AND d.delegator_id=$2 LIMIT 1`, [
        a.tenantId,
        delegatorId,
        b.startsOn,
        b.endsOn,
      ]);
      if (own.rows[0]) throw conflict(`Approvals are already handed to ${own.rows[0].delegate_name} from ${own.rows[0].starts_on} to ${own.rows[0].ends_on}; end that first`);
      const away = await db.query(`SELECT 1 FROM approval_delegations d WHERE ${overlaps} AND d.delegator_id=$2 LIMIT 1`, [a.tenantId, b.delegateId, b.startsOn, b.endsOn]);
      if (away.rowCount) throw conflict(`${delegate.display_name} is handing over their own approvals for part of that time; choose someone else`);
      const r = await db.query<{ id: string }>(
        `INSERT INTO approval_delegations (tenant_id, delegator_id, delegate_id, starts_on, ends_on, note, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [a.tenantId, delegatorId, b.delegateId, b.startsOn, b.endsOn, b.note ?? null, a.user.userId],
      );
      const id = r.rows[0]!.id;
      await audit(db, {
        ...a.auditBase,
        action: 'approval.delegation_created',
        targetType: 'approval_delegation',
        targetId: id,
        metadata: { delegatorId, delegateId: b.delegateId, startsOn: b.startsOn, endsOn: b.endsOn, onBehalf: delegatorId !== a.user.userId },
      });
      const when = b.startsOn === b.endsOn ? `on ${b.startsOn}` : `from ${b.startsOn} to ${b.endsOn}`;
      await notifyUsers(db, a.tenantId, [b.delegateId], {
        kind: 'approval.delegated',
        title: `You approve for ${delegator.display_name} ${when}`,
        body: b.note ?? `Requests addressed to ${delegator.display_name} appear in your approvals during this time.`,
        link: '/approvals',
        actionLabel: 'Open approvals',
      });
      if (delegatorId !== a.user.userId)
        await notifyUsers(db, a.tenantId, [delegatorId], {
          kind: 'approval.delegated',
          title: `HR handed your approvals to ${delegate.display_name} ${when}`,
          body: b.note ?? 'You can still approve requests yourself, and end the handover at any time.',
          link: '/approvals',
          actionLabel: 'Open approvals',
        });
      return { id };
    });
    reply.code(201);
    return out;
  });

  // End a delegation now (or cancel one not yet started): the delegator, whoever set it up, HR, or the delegate declining it.
  app.post('/delegations/:id/revoke', { schema: { params: IdParams } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      const today = await orgToday(db, a.tenantId);
      const d = (
        await db.query<{ delegator_id: string; delegate_id: string; delegator_name: string; created_by: string; revoked_at: string | null; ends_on: string }>(
          `SELECT d.delegator_id, d.delegate_id, u.display_name AS delegator_name, d.created_by, d.revoked_at, d.ends_on::text AS ends_on
           FROM approval_delegations d JOIN users u ON u.id=d.delegator_id WHERE d.tenant_id=$1 AND d.id=$2 FOR UPDATE OF d`,
          [a.tenantId, id],
        )
      ).rows[0];
      if (!d || (d.delegator_id !== a.user.userId && d.created_by !== a.user.userId && d.delegate_id !== a.user.userId && !a.has(DELEGATE_PERMISSION)))
        throw notFound('Delegation not found');
      if (d.revoked_at || d.ends_on < today) throw conflict('This delegation has already ended');
      await db.query('UPDATE approval_delegations SET revoked_at=now(), revoked_by=$3 WHERE tenant_id=$1 AND id=$2', [a.tenantId, id, a.user.userId]);
      await audit(db, {
        ...a.auditBase,
        action: 'approval.delegation_revoked',
        targetType: 'approval_delegation',
        targetId: id,
        metadata: { delegatorId: d.delegator_id, delegateId: d.delegate_id },
      });
      if (a.user.userId === d.delegate_id) {
        await notifyUsers(db, a.tenantId, [d.delegator_id], {
          kind: 'approval.delegated',
          title: `${a.user.displayName} can no longer approve for you`,
          body: 'Requests addressed to you are back with you only. Choose someone else if you will be away.',
          link: '/approvals',
          actionLabel: 'Open approvals',
        });
      } else {
        await notifyUsers(db, a.tenantId, [d.delegate_id], {
          kind: 'approval.delegated',
          title: `You no longer approve for ${d.delegator_name}`,
          body: 'Their requests have gone back to them.',
          link: '/approvals',
          actionLabel: 'Open approvals',
        });
      }
      return { ok: true };
    });
  });
}
