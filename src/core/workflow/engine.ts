import type { Db } from '../../db/tx.js';
import { badRequest, conflict, forbidden, notFound } from '../http/errors.js';
import { audit } from '../audit/audit.js';
import { notifyUsers, usersWithPermission } from '../notify/service.js';

/**
 * Reusable approval engine. Modules register a handler per entity type and
 * create requests with an ordered list of steps; the engine owns state
 * transitions, authorization of approvers and maker-checker separation.
 *
 * States: pending → approved | rejected | returned | cancelled  (terminal)
 * Steps:  waiting → active → approved | rejected | returned ; skipped
 *
 * Implemented: sequential steps, user- or permission-based approvers,
 * requester-cannot-approve, comments, history. Not yet implemented:
 * parallel steps, delegation, time-based escalation (see IMPLEMENTATION_PLAN.md).
 */

export type StepSpec = { kind: 'user'; userId: string } | { kind: 'permission'; permission: string };

export interface ApprovalHandler {
  onApproved(db: Db, tenantId: string, entityId: string, actorId: string): Promise<void>;
  onRejected(db: Db, tenantId: string, entityId: string, actorId: string, status: 'rejected' | 'returned' | 'cancelled'): Promise<void>;
  /** Module feature that must be enabled to act (approvals already pending may still be rejected/cancelled). */
  feature?: string;
  /** Human label and in-app link for notifications, e.g. 'Leave request', '/leave'. */
  label?: string;
  requesterLink?: string;
}

/** Notify whoever can act on the request's active step (never the requester). */
async function notifyActiveApprovers(db: Db, tenantId: string, requestId: string) {
  const r = await db.query<{ summary: string; requester_id: string; entity_type: string; requester_name: string; approver_kind: string; approver_user_id: string | null; approver_permission: string | null }>(
    `SELECT r.summary, r.requester_id, r.entity_type, u.display_name AS requester_name, s.approver_kind, s.approver_user_id, s.approver_permission
       FROM approval_requests r JOIN approval_steps s ON s.tenant_id=r.tenant_id AND s.request_id=r.id AND s.status='active'
       JOIN users u ON u.id=r.requester_id WHERE r.tenant_id=$1 AND r.id=$2 AND r.status='pending'`, [tenantId, requestId]);
  const step = r.rows[0];
  if (!step) return;
  const users = step.approver_kind === 'user' ? [step.approver_user_id!] : await usersWithPermission(db, tenantId, step.approver_permission!);
  const label = handlers.get(step.entity_type)?.label ?? 'Request';
  await notifyUsers(db, tenantId, users.filter((u) => u !== step.requester_id), {
    kind: 'approval.requested', title: `${label} from ${step.requester_name} needs your approval`, body: step.summary, link: '/approvals', actionLabel: 'Review',
  });
}

const handlers = new Map<string, ApprovalHandler>();
export function registerApprovalHandler(entityType: string, h: ApprovalHandler) { handlers.set(entityType, h); }

export interface Actor { userId: string; permissions: Set<string> }

export async function createApprovalRequest(db: Db, tenantId: string, p: {
  entityType: string; entityId: string; requesterId: string; summary: string; steps: StepSpec[];
}) {
  if (!handlers.has(p.entityType)) throw new Error(`No approval handler for ${p.entityType}`);
  // Maker-checker: the requester is never an approver of their own request.
  const steps = p.steps.filter((s) => !(s.kind === 'user' && s.userId === p.requesterId));
  if (!steps.length) throw badRequest('No eligible approver is configured for this request');
  const r = await db.query<{ id: string }>(`INSERT INTO approval_requests (tenant_id, entity_type, entity_id, requester_id, summary)
    VALUES ($1,$2,$3,$4,$5) RETURNING id`, [tenantId, p.entityType, p.entityId, p.requesterId, p.summary]);
  const id = r.rows[0]!.id;
  for (const [i, s] of steps.entries()) {
    await db.query(`INSERT INTO approval_steps (tenant_id, request_id, step_index, approver_kind, approver_user_id, approver_permission, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tenantId, id, i, s.kind, s.kind === 'user' ? s.userId : null, s.kind === 'permission' ? s.permission : null, i === 0 ? 'active' : 'waiting']);
  }
  await notifyActiveApprovers(db, tenantId, id);
  return id;
}

function canActOnStep(step: { approver_kind: string; approver_user_id: string | null; approver_permission: string | null }, actor: Actor) {
  return step.approver_kind === 'user' ? step.approver_user_id === actor.userId : actor.permissions.has(step.approver_permission!);
}

export async function actOnRequest(db: Db, tenantId: string, requestId: string, actor: Actor,
  action: 'approve' | 'reject' | 'return', comment: string | undefined, audBase: { requestId: string; ip: string }) {
  const rq = await db.query<{ id: string; entity_type: string; entity_id: string; requester_id: string; status: string; current_step: number }>(
    'SELECT id, entity_type, entity_id, requester_id, status, current_step FROM approval_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, requestId]);
  const req = rq.rows[0];
  if (!req) throw notFound('Approval request not found');
  if (req.status !== 'pending') throw conflict(`This request is already ${req.status}`);
  if (req.requester_id === actor.userId) throw forbidden('You cannot approve or reject your own request');
  if (action !== 'approve' && !comment?.trim()) throw badRequest('A comment is required when rejecting or returning a request');
  const st = await db.query<{ id: string; step_index: number; approver_kind: string; approver_user_id: string | null; approver_permission: string | null }>(
    `SELECT id, step_index, approver_kind, approver_user_id, approver_permission FROM approval_steps
      WHERE tenant_id=$1 AND request_id=$2 AND status='active' FOR UPDATE`, [tenantId, requestId]);
  const step = st.rows[0];
  if (!step || !canActOnStep(step, actor)) throw forbidden('You are not the approver for the current step');
  const h = handlers.get(req.entity_type)!;

  const stepStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'returned';
  await db.query(`UPDATE approval_steps SET status=$3, acted_by=$4, acted_at=now(), comment=$5 WHERE tenant_id=$1 AND id=$2`,
    [tenantId, step.id, stepStatus, actor.userId, comment ?? null]);

  let final: string | null = null;
  if (action === 'approve') {
    const next = await db.query<{ id: string }>(`UPDATE approval_steps SET status='active' WHERE tenant_id=$1 AND request_id=$2 AND step_index=$3 RETURNING id`,
      [tenantId, requestId, step.step_index + 1]);
    if (next.rowCount) {
      await db.query('UPDATE approval_requests SET current_step=$3 WHERE tenant_id=$1 AND id=$2', [tenantId, requestId, step.step_index + 1]);
      await notifyActiveApprovers(db, tenantId, requestId);
    } else {
      final = 'approved';
      await h.onApproved(db, tenantId, req.entity_id, actor.userId);
    }
  } else {
    final = stepStatus;
    await db.query(`UPDATE approval_steps SET status='skipped' WHERE tenant_id=$1 AND request_id=$2 AND status='waiting'`, [tenantId, requestId]);
    await h.onRejected(db, tenantId, req.entity_id, actor.userId, stepStatus as 'rejected' | 'returned');
  }
  if (final) {
    await db.query('UPDATE approval_requests SET status=$3, decided_at=now() WHERE tenant_id=$1 AND id=$2', [tenantId, requestId, final]);
    const summary = (await db.query<{ summary: string }>('SELECT summary FROM approval_requests WHERE tenant_id=$1 AND id=$2', [tenantId, requestId])).rows[0]!.summary;
    const verb = final === 'approved' ? 'approved' : final === 'rejected' ? 'rejected' : 'returned for changes';
    await notifyUsers(db, tenantId, [req.requester_id], {
      kind: `approval.${final}`, title: `Your ${(h.label ?? 'request').toLowerCase()} was ${verb}`,
      body: comment ? `${summary} — “${comment.slice(0, 300)}”` : summary, link: h.requesterLink ?? '/approvals', actionLabel: 'View',
    });
  }
  await audit(db, { tenantId, actorId: actor.userId, action: `approval.${stepStatus}`, targetType: req.entity_type, targetId: req.entity_id,
    metadata: { approvalRequestId: requestId, step: step.step_index, final, comment }, ...audBase });
  return { status: final ?? 'pending' };
}

export async function cancelRequest(db: Db, tenantId: string, requestId: string, actorId: string, audBase: { requestId: string; ip: string }) {
  const rq = await db.query<{ entity_type: string; entity_id: string; requester_id: string; status: string }>(
    'SELECT entity_type, entity_id, requester_id, status FROM approval_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, requestId]);
  const req = rq.rows[0];
  if (!req) throw notFound('Approval request not found');
  if (req.requester_id !== actorId) throw forbidden('Only the requester can cancel this request');
  if (req.status !== 'pending') throw conflict(`This request is already ${req.status}`);
  await db.query(`UPDATE approval_requests SET status='cancelled', decided_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, requestId]);
  await db.query(`UPDATE approval_steps SET status='skipped' WHERE tenant_id=$1 AND request_id=$2 AND status IN ('waiting','active')`, [tenantId, requestId]);
  await handlers.get(req.entity_type)!.onRejected(db, tenantId, req.entity_id, actorId, 'cancelled');
  await audit(db, { tenantId, actorId, action: 'approval.cancelled', targetType: req.entity_type, targetId: req.entity_id, metadata: { approvalRequestId: requestId }, ...audBase });
}

/** Pending requests whose ACTIVE step this actor can act on (never their own). */
export async function inbox(db: Db, tenantId: string, actor: Actor) {
  const r = await db.query(`SELECT r.id, r.entity_type, r.entity_id, r.summary, r.created_at, r.current_step, u.display_name AS requester_name,
      s.approver_kind, s.approver_permission
    FROM approval_requests r JOIN approval_steps s ON s.tenant_id=r.tenant_id AND s.request_id=r.id AND s.status='active'
    JOIN users u ON u.id=r.requester_id
    WHERE r.tenant_id=$1 AND r.status='pending' AND r.requester_id <> $2
      AND ((s.approver_kind='user' AND s.approver_user_id=$2) OR (s.approver_kind='permission' AND s.approver_permission = ANY($3)))
    ORDER BY r.created_at LIMIT 200`, [tenantId, actor.userId, [...actor.permissions]]);
  return r.rows;
}

export async function requestHistory(db: Db, tenantId: string, requestId: string) {
  const r = await db.query(`SELECT s.step_index, s.approver_kind, s.approver_permission, au.display_name AS approver_name, s.status,
      s.acted_at, s.comment, ac.display_name AS acted_by_name
    FROM approval_steps s LEFT JOIN users au ON au.id=s.approver_user_id LEFT JOIN users ac ON ac.id=s.acted_by
    WHERE s.tenant_id=$1 AND s.request_id=$2 ORDER BY s.step_index`, [tenantId, requestId]);
  return r.rows;
}
