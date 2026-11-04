import type { Db } from '../../db/tx.js';
import { badRequest, conflict, forbidden, notFound } from '../http/errors.js';
import { audit } from '../audit/audit.js';
import { notifyUsers, usersWithPermission } from '../notify/service.js';
import { localDate } from '../../modules/attendance/time.js';

/**
 * Reusable approval engine. Modules register a handler per entity type and
 * create requests with an ordered list of steps; the engine owns state
 * transitions, authorization of approvers and maker-checker separation.
 *
 * States: pending → approved | rejected | returned | cancelled  (terminal)
 * Steps:  waiting → active → approved | rejected | returned ; skipped
 *
 * Implemented: sequential steps, user- or permission-based approvers,
 * requester-cannot-approve, comments, history; delegation of steps addressed to a person
 * (approval_delegations) and time-based escalation of those steps to the approver's manager,
 * or to holders of `approvals.escalations` (escalateOverdue). Not implemented: parallel steps,
 * amount-based routing (see IMPLEMENTATION_PLAN.md).
 *
 * Who may act on the active step:
 *   - a user step: the named approver; the person it was escalated to; an active delegate of either;
 *   - a permission step: anyone holding the permission (group steps are never delegated or escalated);
 * never the requester, an excluded party, or someone who (or whose delegate) decided an earlier step.
 *
 * Nothing waits forever on someone who cannot act. A step for a disabled person, or a group step with no eligible holder,
 * goes to the fallback owner: holders of `approvals.escalations`. If nobody there can act either, the request is still
 * created and administrators are warned, and can reassign it; holders of `approvals.escalations` can reassign any request.
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

export async function orgToday(db: Db, tenantId: string): Promise<string> {
  const tz = (await db.query<{ timezone: string }>('SELECT timezone FROM tenants WHERE id=$1', [tenantId])).rows[0]!.timezone;
  return localDate(new Date(), tz);
}

interface ActiveStep {
  approver_kind: string; approver_user_id: string | null; approver_permission: string | null;
  escalated_to: string | null; escalated_permission: string | null;
}

/**
 * Everyone who could act on an active step today, split into those it is addressed to and the delegates covering
 * for them (keyed by the person they cover for). The caller removes the requester and other blocked people.
 */
export async function stepRecipients(db: Db, tenantId: string, step: ActiveStep, today: string) {
  const direct = new Set<string>();
  if (step.approver_kind === 'user') { if (step.approver_user_id) direct.add(step.approver_user_id); }
  else if (step.approver_permission) for (const u of await usersWithPermission(db, tenantId, step.approver_permission!)) direct.add(u);
  if (step.escalated_to) direct.add(step.escalated_to);
  if (step.escalated_permission) for (const u of await usersWithPermission(db, tenantId, step.escalated_permission)) direct.add(u);
  const delegates = new Map<string, string>();   // delegate → delegator
  const people = [step.approver_kind === 'user' ? step.approver_user_id : null, step.escalated_to].filter((x): x is string => !!x);
  if (people.length) {
    const d = await db.query<{ delegate_id: string; delegator_id: string }>(
      `SELECT d.delegate_id, d.delegator_id FROM approval_delegations d JOIN users u ON u.id=d.delegate_id AND u.status='active'
        WHERE d.tenant_id=$1 AND d.delegator_id = ANY($2) AND d.revoked_at IS NULL AND $3::date BETWEEN d.starts_on AND d.ends_on`, [tenantId, people, today]);
    for (const x of d.rows) if (!direct.has(x.delegate_id)) delegates.set(x.delegate_id, x.delegator_id);
  }
  return { direct: [...direct], delegates };
}

async function displayNames(db: Db, tenantId: string, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const r = await db.query<{ id: string; display_name: string }>('SELECT id, display_name FROM users WHERE tenant_id=$1 AND id = ANY($2)', [tenantId, ids]);
  return new Map(r.rows.map((x) => [x.id, x.display_name]));
}

/** People who may not act on a request: the requester, excluded parties, and whoever decided (or was represented on) an earlier step. */
export async function blockedUsers(db: Db, tenantId: string, requestId: string) {
  const r = await db.query<{ blocked: string[] }>(
    `SELECT array_remove(r.excluded_user_ids || r.requester_id || coalesce((SELECT array_agg(p.acted_by) || array_agg(p.acted_for) FROM approval_steps p
       WHERE p.tenant_id=r.tenant_id AND p.request_id=r.id AND p.acted_by IS NOT NULL), '{}'), NULL) AS blocked
       FROM approval_requests r WHERE r.tenant_id=$1 AND r.id=$2`, [tenantId, requestId]);
  return new Set(r.rows[0]?.blocked ?? []);
}

/** Notify whoever can act on the request's active step (never the requester), including delegates covering for the approver. */
async function notifyActiveApprovers(db: Db, tenantId: string, requestId: string, opts: { onlyEscalation?: boolean } = {}) {
  const r = await db.query<ActiveStep & { summary: string; entity_type: string; requester_name: string }>(
    `SELECT r.summary, r.entity_type, u.display_name AS requester_name, s.approver_kind, s.approver_user_id, s.approver_permission, s.escalated_to, s.escalated_permission
       FROM approval_requests r JOIN approval_steps s ON s.tenant_id=r.tenant_id AND s.request_id=r.id AND s.status='active'
       JOIN users u ON u.id=r.requester_id WHERE r.tenant_id=$1 AND r.id=$2 AND r.status='pending'`, [tenantId, requestId]);
  const step = r.rows[0];
  if (!step) return;
  const blocked = await blockedUsers(db, tenantId, requestId);
  const today = await orgToday(db, tenantId);
  // On escalation only the new parties are told; the original approver hears separately.
  const { direct, delegates } = await stepRecipients(db, tenantId, opts.onlyEscalation
    ? { approver_kind: 'user', approver_user_id: null, approver_permission: null, escalated_to: step.escalated_to, escalated_permission: step.escalated_permission }
    : step, today);
  const label = handlers.get(step.entity_type)?.label ?? 'Request';
  const title = opts.onlyEscalation ? `Escalated to you: ${label.toLowerCase()} from ${step.requester_name}` : `${label} from ${step.requester_name} needs your approval`;
  await notifyUsers(db, tenantId, direct.filter((u) => !blocked.has(u)), { kind: opts.onlyEscalation ? 'approval.escalated' : 'approval.requested', title, body: step.summary, link: '/approvals', actionLabel: 'Review' });
  const names = await displayNames(db, tenantId, [...new Set(delegates.values())]);
  for (const [delegate, delegator] of delegates) {
    if (blocked.has(delegate)) continue;
    await notifyUsers(db, tenantId, [delegate], { kind: opts.onlyEscalation ? 'approval.escalated' : 'approval.requested', title: `${title} (covering for ${names.get(delegator) ?? 'a colleague'})`,
      body: step.summary, link: '/approvals', actionLabel: 'Review' });
  }
}

const handlers = new Map<string, ApprovalHandler>();
export function registerApprovalHandler(entityType: string, h: ApprovalHandler) { handlers.set(entityType, h); }

export interface Actor { userId: string; permissions: Set<string> }

export async function createApprovalRequest(db: Db, tenantId: string, p: {
  entityType: string; entityId: string; requesterId: string; summary: string; steps: StepSpec[];
  /** Others who must never act on it: the author when someone else submits, the employee it is about. */
  excludeUserIds?: (string | null | undefined)[];
}) {
  if (!handlers.has(p.entityType)) throw new Error(`No approval handler for ${p.entityType}`);
  const excluded = [...new Set(p.excludeUserIds?.filter((u): u is string => !!u && u !== p.requesterId) ?? [])];
  const blocked = new Set([p.requesterId, ...excluded]);
  const named = p.steps.flatMap((s) => (s.kind === 'user' ? [s.userId] : []));
  const active = new Set(named.length ? (await db.query<{ id: string }>(`SELECT id FROM users WHERE tenant_id=$1 AND id = ANY($2) AND status='active'`, [tenantId, named])).rows.map((u) => u.id) : []);
  // Maker-checker: neither the requester nor an excluded party is ever an approver of the request. A disabled account cannot act either.
  const kept = p.steps.filter((s) => s.kind !== 'user' || (!blocked.has(s.userId) && active.has(s.userId)));
  const steps: StepSpec[] = kept.length ? kept : [{ kind: 'permission', permission: ESCALATION_PERMISSION }];
  const r = await db.query<{ id: string }>(`INSERT INTO approval_requests (tenant_id, entity_type, entity_id, requester_id, summary, excluded_user_ids)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [tenantId, p.entityType, p.entityId, p.requesterId, p.summary, excluded]);
  const id = r.rows[0]!.id;
  const fallbackOpen = (await eligibleHolders(db, tenantId, ESCALATION_PERMISSION, blocked)).length > 0;
  let nobody = false;
  for (const [i, s] of steps.entries()) {
    const open = s.kind === 'user' || (await eligibleHolders(db, tenantId, s.permission, blocked)).length > 0;
    if (!open && !fallbackOpen) nobody = true;
    await db.query(`INSERT INTO approval_steps (tenant_id, request_id, step_index, approver_kind, approver_user_id, approver_permission, status, activated_at, escalated_at, escalated_permission)
      VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7='active' THEN now() END, CASE WHEN $8::text IS NOT NULL THEN now() END, $8)`,
      [tenantId, id, i, s.kind, s.kind === 'user' ? s.userId : null, s.kind === 'permission' ? s.permission : null, i === 0 ? 'active' : 'waiting', !open && fallbackOpen ? ESCALATION_PERMISSION : null]);
  }
  await notifyActiveApprovers(db, tenantId, id);
  if (nobody) await warnNoApprover(db, tenantId, id, p.entityType, p.requesterId);
  return id;
}

/** Holders of a permission who may act on a request with these people blocked. */
async function eligibleHolders(db: Db, tenantId: string, permission: string, blocked: Set<string>) {
  return (await usersWithPermission(db, tenantId, permission)).filter((u) => !blocked.has(u));
}

/** Nobody can act on this request as things stand: administrators and the requester are told, and it is on record. */
async function warnNoApprover(db: Db, tenantId: string, requestId: string, entityType: string, requesterId: string) {
  const label = handlers.get(entityType)?.label ?? 'Request';
  const admins = await usersWithPermission(db, tenantId, 'users.manage');
  await notifyUsers(db, tenantId, [...new Set([...admins, requesterId])], { kind: 'approval.no_approver', title: `${label} has nobody who can approve it`,
    body: 'Nobody eligible holds the permission it needs. An administrator can reassign it, or grant the permission to someone else.', link: '/approvals', actionLabel: 'Open' });
  await audit(db, { tenantId, actorId: null, actorType: 'system', action: 'approval.no_eligible_approver', targetType: entityType, metadata: { approvalRequestId: requestId } });
}

type Role = { via: null | 'delegation' | 'escalation'; forUser: string | null };

/** How this actor may act on the active step today, or null if they may not. */
async function actingRole(db: Db, tenantId: string, step: ActiveStep, actor: Actor, today: string): Promise<Role | null> {
  if (step.approver_kind === 'permission' && actor.permissions.has(step.approver_permission!)) return { via: null, forUser: null };
  if (step.approver_kind === 'user' && step.approver_user_id === actor.userId) return { via: null, forUser: null };
  if (step.escalated_to === actor.userId || (step.escalated_permission && actor.permissions.has(step.escalated_permission))) return { via: 'escalation', forUser: step.approver_user_id };
  const people = [step.approver_kind === 'user' ? step.approver_user_id : null, step.escalated_to].filter((x): x is string => !!x);
  if (!people.length) return null;
  const d = await db.query<{ delegator_id: string }>(
    `SELECT delegator_id FROM approval_delegations WHERE tenant_id=$1 AND delegate_id=$2 AND delegator_id = ANY($3) AND revoked_at IS NULL
        AND $4::date BETWEEN starts_on AND ends_on ORDER BY (delegator_id = $5) DESC LIMIT 1`, [tenantId, actor.userId, people, today, people[0]]);
  return d.rows[0] ? { via: 'delegation', forUser: d.rows[0].delegator_id } : null;
}

export async function actOnRequest(db: Db, tenantId: string, requestId: string, actor: Actor,
  action: 'approve' | 'reject' | 'return', comment: string | undefined, audBase: { requestId: string; ip: string }) {
  const rq = await db.query<{ id: string; entity_type: string; entity_id: string; requester_id: string; status: string; current_step: number; excluded_user_ids: string[] }>(
    'SELECT id, entity_type, entity_id, requester_id, status, current_step, excluded_user_ids FROM approval_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, requestId]);
  const req = rq.rows[0];
  if (!req) throw notFound('Approval request not found');
  if (req.status !== 'pending') throw conflict(`This request is already ${req.status}`);
  if (req.requester_id === actor.userId) throw forbidden('You cannot approve or reject your own request');
  if (req.excluded_user_ids.includes(actor.userId)) throw forbidden('You cannot act on a request you prepared or that concerns you');
  const blocked = await blockedUsers(db, tenantId, requestId);
  if (blocked.has(actor.userId)) throw forbidden('You already approved an earlier step; a different person must approve this one');
  if (action !== 'approve' && !comment?.trim()) throw badRequest('A comment is required when rejecting or returning a request');
  const st = await db.query<ActiveStep & { id: string; step_index: number }>(
    `SELECT id, step_index, approver_kind, approver_user_id, approver_permission, escalated_to, escalated_permission FROM approval_steps
      WHERE tenant_id=$1 AND request_id=$2 AND status='active' FOR UPDATE`, [tenantId, requestId]);
  const step = st.rows[0];
  const role = step ? await actingRole(db, tenantId, step, actor, await orgToday(db, tenantId)) : null;
  if (!step || !role) throw forbidden('You are not the approver for the current step');
  // Covering for someone who already decided an earlier step would let one person approve twice.
  if (role.via === 'delegation' && role.forUser && blocked.has(role.forUser)) throw forbidden('The person you are covering for decided an earlier step; a different person must approve this one');
  const h = handlers.get(req.entity_type)!;

  const stepStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'returned';
  await db.query(`UPDATE approval_steps SET status=$3, acted_by=$4, acted_at=now(), comment=$5, acted_for=$6, acted_via=$7 WHERE tenant_id=$1 AND id=$2`,
    [tenantId, step.id, stepStatus, actor.userId, comment ?? null, role.via ? role.forUser : null, role.via]);

  let final: string | null = null;
  if (action === 'approve') {
    const next = await db.query<{ id: string }>(`UPDATE approval_steps SET status='active', activated_at=now() WHERE tenant_id=$1 AND request_id=$2 AND step_index=$3 RETURNING id`,
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
    metadata: { approvalRequestId: requestId, step: step.step_index, final, comment, ...(role.via ? { via: role.via, onBehalfOf: role.forUser } : {}) }, ...audBase });
  return { status: final ?? 'pending' };
}

/**
 * Withdraw a pending request. Only its requester, unless the module has already decided the actor may
 * (`subjectMayWithdraw`: the employee a request was filed for on their behalf).
 */
export async function cancelRequest(db: Db, tenantId: string, requestId: string, actorId: string, audBase: { requestId: string; ip: string }, opts: { subjectMayWithdraw?: boolean } = {}) {
  const rq = await db.query<{ entity_type: string; entity_id: string; requester_id: string; status: string }>(
    'SELECT entity_type, entity_id, requester_id, status FROM approval_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, requestId]);
  const req = rq.rows[0];
  if (!req) throw notFound('Approval request not found');
  if (req.requester_id !== actorId && !opts.subjectMayWithdraw) throw forbidden('Only the requester can cancel this request');
  if (req.status !== 'pending') throw conflict(`This request is already ${req.status}`);
  await db.query(`UPDATE approval_requests SET status='cancelled', decided_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, requestId]);
  await db.query(`UPDATE approval_steps SET status='skipped' WHERE tenant_id=$1 AND request_id=$2 AND status IN ('waiting','active')`, [tenantId, requestId]);
  await handlers.get(req.entity_type)!.onRejected(db, tenantId, req.entity_id, actorId, 'cancelled');
  await audit(db, { tenantId, actorId, action: 'approval.cancelled', targetType: req.entity_type, targetId: req.entity_id, metadata: { approvalRequestId: requestId }, ...audBase });
}

/**
 * Pending requests whose ACTIVE step this actor can act on (never their own), with how: `via` is null when it is
 * addressed to them, 'delegation' when they cover for `on_behalf_of`, 'escalation' when it was escalated to them.
 */
export async function inbox(db: Db, tenantId: string, actor: Actor, today?: string) {
  today ??= await orgToday(db, tenantId);
  const r = await db.query<{ id: string; approver_kind: string; approver_user_id: string | null; approver_permission: string | null; escalated_to: string | null;
    escalated_permission: string | null; delegated_by: string | null; delegated_by_name: string | null; approver_name: string | null }>(
    `SELECT r.id, r.entity_type, r.entity_id, r.summary, r.created_at, r.current_step, u.display_name AS requester_name,
      s.approver_kind, s.approver_permission, s.approver_user_id, s.escalated_to, s.escalated_permission, s.escalated_at, au.display_name AS approver_name,
      dl.delegator_id AS delegated_by, du.display_name AS delegated_by_name
    FROM approval_requests r JOIN approval_steps s ON s.tenant_id=r.tenant_id AND s.request_id=r.id AND s.status='active'
    JOIN users u ON u.id=r.requester_id
    LEFT JOIN users au ON au.id=s.approver_user_id
    LEFT JOIN LATERAL (SELECT d.delegator_id FROM approval_delegations d WHERE d.tenant_id=r.tenant_id AND d.delegate_id=$2 AND d.revoked_at IS NULL
        AND $4::date BETWEEN d.starts_on AND d.ends_on AND s.approver_kind='user' AND d.delegator_id IN (s.approver_user_id, s.escalated_to)
        ORDER BY (d.delegator_id = s.approver_user_id) DESC LIMIT 1) dl ON true
    LEFT JOIN users du ON du.id=dl.delegator_id
    WHERE r.tenant_id=$1 AND r.status='pending' AND r.requester_id <> $2 AND NOT ($2 = ANY(r.excluded_user_ids))
      AND ((s.approver_kind='user' AND (s.approver_user_id=$2 OR dl.delegator_id IS NOT NULL))
        OR (s.approver_kind='permission' AND s.approver_permission = ANY($3))
        OR s.escalated_to=$2 OR s.escalated_permission = ANY($3))
      AND NOT EXISTS (SELECT 1 FROM approval_steps p WHERE p.tenant_id=r.tenant_id AND p.request_id=r.id AND p.acted_by IS NOT NULL
        AND (p.acted_by=$2 OR p.acted_for=$2 OR (dl.delegator_id IS NOT NULL AND s.approver_user_id IS DISTINCT FROM $2 AND p.acted_by=dl.delegator_id)))
    ORDER BY r.created_at LIMIT 200`, [tenantId, actor.userId, [...actor.permissions], today]);
  return r.rows.map(({ delegated_by, delegated_by_name, approver_name, ...x }) => {
    const mine = (x.approver_kind === 'permission' && actor.permissions.has(x.approver_permission!)) || x.approver_user_id === actor.userId;
    const escalated = !mine && (x.escalated_to === actor.userId || (!!x.escalated_permission && actor.permissions.has(x.escalated_permission)));
    const via = mine ? null : escalated ? 'escalation' : 'delegation';
    return { ...x, approver_name, via, on_behalf_of: via === 'escalation' ? approver_name : via === 'delegation' ? delegated_by_name : null, delegated_by: via === 'delegation' ? delegated_by : null };
  });
}

export async function requestHistory(db: Db, tenantId: string, requestId: string) {
  const r = await db.query(`SELECT s.step_index, s.approver_kind, s.approver_permission, au.display_name AS approver_name, s.status,
      s.acted_at, s.comment, ac.display_name AS acted_by_name, s.acted_via, af.display_name AS acted_for_name,
      s.escalated_at, eu.display_name AS escalated_to_name, s.escalated_permission
    FROM approval_steps s LEFT JOIN users au ON au.id=s.approver_user_id LEFT JOIN users ac ON ac.id=s.acted_by
    LEFT JOIN users af ON af.id=s.acted_for LEFT JOIN users eu ON eu.id=s.escalated_to
    WHERE s.tenant_id=$1 AND s.request_id=$2 ORDER BY s.step_index`, [tenantId, requestId]);
  return r.rows;
}

/** Holders of this permission take escalations when the approver has no manager who can take them. */
export const ESCALATION_PERMISSION = 'approvals.escalations';

/**
 * Escalate active steps addressed to one person that have waited more than `days` days: to the approver's reporting
 * manager, or, when there is none who may act, to holders of `approvals.escalations`. Each step escalates once;
 * the original approver (and their delegate) can still act. Group steps are not escalated: reminders go to the group.
 */
export async function escalateOverdue(db: Db, tenantId: string, days: number) {
  const due = await db.query<{ id: string; request_id: string; approver_user_id: string; approver_name: string; summary: string; entity_type: string }>(
    `SELECT s.id, s.request_id, s.approver_user_id, au.display_name AS approver_name, r.summary, r.entity_type
       FROM approval_steps s JOIN approval_requests r ON r.tenant_id=s.tenant_id AND r.id=s.request_id AND r.status='pending'
       JOIN users au ON au.id=s.approver_user_id
      WHERE s.tenant_id=$1 AND s.status='active' AND s.approver_kind='user' AND s.escalated_at IS NULL
        AND coalesce(s.activated_at, r.created_at) < now() - make_interval(days => $2)
      ORDER BY coalesce(s.activated_at, r.created_at) FOR UPDATE OF s SKIP LOCKED`, [tenantId, days]);
  let toManager = 0, toGroup = 0;
  for (const st of due.rows) {
    const blocked = await blockedUsers(db, tenantId, st.request_id);
    const mgr = await activeManagerOf(db, tenantId, st.approver_user_id, blocked);
    await db.query(`UPDATE approval_steps SET escalated_at=now(), escalated_to=$3, escalated_permission=$4 WHERE tenant_id=$1 AND id=$2`,
      [tenantId, st.id, mgr?.user_id ?? null, mgr ? null : ESCALATION_PERMISSION]);
    if (mgr) toManager++; else toGroup++;
    await notifyActiveApprovers(db, tenantId, st.request_id, { onlyEscalation: true });
    const label = handlers.get(st.entity_type)?.label ?? 'Request';
    await notifyUsers(db, tenantId, [st.approver_user_id], { kind: 'approval.escalated', title: `${label} escalated to ${mgr ? mgr.display_name : 'HR'} after ${days} day(s)`,
      body: `${st.summary} — you can still decide it.`, link: '/approvals', actionLabel: 'Review' });
    await audit(db, { tenantId, actorId: null, actorType: 'system', action: 'approval.escalated', targetType: st.entity_type,
      metadata: { approvalRequestId: st.request_id, from: st.approver_user_id, to: mgr?.user_id ?? ESCALATION_PERMISSION, afterDays: days } });
  }
  return { escalated: due.rowCount ?? 0, toManager, toGroup };
}

/** The person's reporting manager, if they have an active account and may act with these people blocked. */
async function activeManagerOf(db: Db, tenantId: string, userId: string, blocked: Set<string>) {
  const m = await db.query<{ user_id: string; display_name: string }>(
    `SELECT mu.id AS user_id, mu.display_name FROM employees e JOIN employees m ON m.tenant_id=e.tenant_id AND m.id=e.reporting_manager_id
       JOIN users mu ON mu.id=m.user_id AND mu.status='active'
      WHERE e.tenant_id=$1 AND e.user_id=$2 LIMIT 1`, [tenantId, userId]);
  return m.rows[0] && m.rows[0].user_id !== userId && !blocked.has(m.rows[0].user_id) ? m.rows[0] : null;
}

/**
 * A user's account was disabled: steps waiting on them go to their manager, or to the fallback owner. Runs in the same
 * transaction as the disable. Delegations stop mattering because the step no longer depends on this person.
 */
export async function reassignStepsOf(db: Db, tenantId: string, userId: string) {
  const steps = await db.query<{ id: string; request_id: string; status: string; entity_type: string; requester_id: string }>(
    `SELECT s.id, s.request_id, s.status, r.entity_type, r.requester_id FROM approval_steps s JOIN approval_requests r ON r.tenant_id=s.tenant_id AND r.id=s.request_id AND r.status='pending'
      WHERE s.tenant_id=$1 AND s.status IN ('active','waiting')
        AND (s.escalated_to=$2 OR (s.approver_user_id=$2 AND s.escalated_to IS NULL AND s.escalated_permission IS NULL)) FOR UPDATE OF s`, [tenantId, userId]);
  for (const st of steps.rows) {
    const blocked = await blockedUsers(db, tenantId, st.request_id);
    const mgr = await activeManagerOf(db, tenantId, userId, blocked);
    await db.query(`UPDATE approval_steps SET escalated_at=now(), escalated_to=$3, escalated_permission=$4 WHERE tenant_id=$1 AND id=$2`, [tenantId, st.id, mgr?.user_id ?? null, mgr ? null : ESCALATION_PERMISSION]);
    if (!mgr && !(await eligibleHolders(db, tenantId, ESCALATION_PERMISSION, blocked)).length) await warnNoApprover(db, tenantId, st.request_id, st.entity_type, st.requester_id);
    if (st.status === 'active') await notifyActiveApprovers(db, tenantId, st.request_id, { onlyEscalation: true });
    await audit(db, { tenantId, actorId: null, actorType: 'system', action: 'approval.reassigned', targetType: st.entity_type,
      metadata: { approvalRequestId: st.request_id, from: userId, to: mgr?.user_id ?? ESCALATION_PERMISSION, reason: 'approver_disabled' } });
  }
  return steps.rowCount ?? 0;
}

/**
 * Active group steps whose holders have all gone (left, or lost the role) since the request was made: to the fallback
 * owner, or a warning when nobody is there either. Unlike timed escalation this is not optional, so it always runs.
 */
export async function reassignStranded(db: Db, tenantId: string) {
  const steps = await db.query<{ id: string; request_id: string; approver_permission: string; entity_type: string; requester_id: string }>(
    `SELECT s.id, s.request_id, s.approver_permission, r.entity_type, r.requester_id FROM approval_steps s JOIN approval_requests r ON r.tenant_id=s.tenant_id AND r.id=s.request_id AND r.status='pending'
      WHERE s.tenant_id=$1 AND s.status='active' AND s.approver_kind='permission' AND s.escalated_at IS NULL FOR UPDATE OF s SKIP LOCKED`, [tenantId]);
  let moved = 0;
  for (const st of steps.rows) {
    const blocked = await blockedUsers(db, tenantId, st.request_id);
    if ((await eligibleHolders(db, tenantId, st.approver_permission, blocked)).length) continue;
    await db.query(`UPDATE approval_steps SET escalated_at=now(), escalated_permission=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, st.id, ESCALATION_PERMISSION]);
    if (!(await eligibleHolders(db, tenantId, ESCALATION_PERMISSION, blocked)).length) await warnNoApprover(db, tenantId, st.request_id, st.entity_type, st.requester_id);
    await notifyActiveApprovers(db, tenantId, st.request_id, { onlyEscalation: true });
    await audit(db, { tenantId, actorId: null, actorType: 'system', action: 'approval.reassigned', targetType: st.entity_type,
      metadata: { approvalRequestId: st.request_id, to: ESCALATION_PERMISSION, reason: 'no_eligible_holder' } });
    moved++;
  }
  return moved;
}

/**
 * Hands the active step to a named person, who can then decide it. It stays on the record. Administrators (who are not
 * in any approval chain by role) may do this only for a request nobody can act on; the fallback owner may at any time.
 */
export async function reassignRequest(db: Db, tenantId: string, requestId: string, actorId: string, targetUserId: string, reason: string, audBase: { requestId: string; ip: string }, opts: { onlyIfStuck: boolean }) {
  const req = (await db.query<{ entity_type: string; status: string }>('SELECT entity_type, status FROM approval_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, requestId])).rows[0];
  if (!req) throw notFound('Approval request not found');
  if (req.status !== 'pending') throw conflict(`This request is already ${req.status}`);
  const blocked = await blockedUsers(db, tenantId, requestId);
  if (blocked.has(actorId)) throw forbidden('You cannot reassign a request you prepared, that concerns you, or that you already decided');
  if (targetUserId === actorId) throw badRequest('Reassign it to someone else: taking it yourself would let you choose your own approver');
  if (blocked.has(targetUserId)) throw badRequest('That person cannot act on this request');
  const target = await db.query(`SELECT 1 FROM users WHERE tenant_id=$1 AND id=$2 AND status='active'`, [tenantId, targetUserId]);
  if (!target.rowCount) throw badRequest('Choose an active user');
  const step = (await db.query<ActiveStep>(`SELECT approver_kind, approver_user_id, approver_permission, escalated_to, escalated_permission FROM approval_steps WHERE tenant_id=$1 AND request_id=$2 AND status='active' FOR UPDATE`, [tenantId, requestId])).rows[0];
  if (!step) throw conflict('This request has no active step');
  if (opts.onlyIfStuck) {
    const { direct, delegates } = await stepRecipients(db, tenantId, step, await orgToday(db, tenantId));
    const able = await db.query(`SELECT 1 FROM users WHERE tenant_id=$1 AND status='active' AND id = ANY($2) AND NOT (id = ANY($3)) LIMIT 1`, [tenantId, [...direct, ...delegates.keys()], [...blocked]]);
    if (able.rowCount) throw conflict('Someone can still act on this request; only HR can reassign it');
  }
  await db.query(`UPDATE approval_steps SET escalated_at=now(), escalated_to=$3, escalated_permission=NULL WHERE tenant_id=$1 AND request_id=$2 AND status='active'`, [tenantId, requestId, targetUserId]);
  await notifyActiveApprovers(db, tenantId, requestId, { onlyEscalation: true });
  await audit(db, { tenantId, actorId, action: 'approval.reassigned', targetType: req.entity_type, metadata: { approvalRequestId: requestId, to: targetUserId, reason }, ...audBase });
}
