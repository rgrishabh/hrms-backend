import type { Db } from '../../db/tx.js';
import { badRequest, conflict, forbidden, notFound } from '../http/errors.js';
import { audit } from '../audit/audit.js';
import { notifyUsers, usersWithPermission } from '../notify/service.js';
import { allOff } from '../features/state.js';
import { localDate } from '../../modules/attendance/time.js';
import { currentMode, isCollapsedMode } from '../policy/mode.js';
import { scrubAmounts } from '../policy/text.js';
import { OWNER_ROLE_KEYS } from '../auth/permissions.js';

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
 *   - a permission step: anyone holding the permission (group steps are not delegated or escalated, except the HR step above);
 * never the requester, an excluded party, or someone who (or whose delegate) decided an earlier step.
 *
 * Management modes (buildSteps): in `single` a request has one step, addressed to the owner by name. In `single_hr` it is one step for
 * HR or the owner (the group permission `approvals.hr_step`), and anything HR raised, or that moves money, goes to the owner by name.
 * A step for a name keeps delegation and escalation as it always had. The HR group step would have lost both, so it alone among group
 * steps may be delegated by a holder, and escalates to the owner when overdue. The owner may decide their own request here: nobody is
 * above them. It is recorded on the request as `self_approver_id`, and each such decision writes `approval.self_approved`.
 *
 * Nothing waits forever on someone who cannot act. A step for a disabled person, or a group step with no eligible holder,
 * goes to the fallback owner: holders of `approvals.escalations`. If nobody there can act either, the request is still
 * created and administrators are warned, and can reassign it; holders of `approvals.escalations` can reassign any request.
 */

export type StepSpec = { kind: 'user'; userId: string } | { kind: 'permission'; permission: string };

/** The one-step group of `single_hr`: HR or the owner. */
export const HR_STEP_PERMISSION = 'approvals.hr_step';
/** A step for any of these is the finance or payroll check of something that moves money or changes pay. */
const MONEY_PERMISSIONS: ReadonlySet<string> = new Set([
  'payroll.approve',
  'loans.approve',
  'expenses.approve',
  'expenses.pay',
  'travel.approve',
  'employees.bank.approve',
  'recruitment.approve',
]);

export interface ApprovalHandler {
  onApproved(db: Db, tenantId: string, entityId: string, actorId: string): Promise<void>;
  onRejected(db: Db, tenantId: string, entityId: string, actorId: string, status: 'rejected' | 'returned' | 'cancelled'): Promise<void>;
  /** The module this belongs to. While it is off, its requests leave the inbox and answer 404; see offEntityTypes. */
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
  approver_kind: string;
  approver_user_id: string | null;
  approver_permission: string | null;
  escalated_to: string | null;
  escalated_permission: string | null;
}

/**
 * Everyone who could act on an active step today, split into those it is addressed to and the delegates covering
 * for them (keyed by the person they cover for). The caller removes the requester and other blocked people.
 */
export async function stepRecipients(db: Db, tenantId: string, step: ActiveStep, today: string) {
  const direct = new Set<string>();
  if (step.approver_kind === 'user') {
    if (step.approver_user_id) direct.add(step.approver_user_id);
  } else if (step.approver_permission) for (const u of await usersWithPermission(db, tenantId, step.approver_permission!)) direct.add(u);
  if (step.escalated_to) direct.add(step.escalated_to);
  if (step.escalated_permission) for (const u of await usersWithPermission(db, tenantId, step.escalated_permission)) direct.add(u);
  const delegates = new Map<string, string>(); // delegate → delegator
  const people = [step.approver_kind === 'user' ? step.approver_user_id : null, step.escalated_to].filter((x): x is string => !!x);
  if (step.approver_permission === HR_STEP_PERMISSION) people.push(...direct);
  if (people.length) {
    const d = await db.query<{ delegate_id: string; delegator_id: string }>(
      `SELECT d.delegate_id, d.delegator_id FROM approval_delegations d JOIN users u ON u.id=d.delegate_id AND u.status='active'
        WHERE d.tenant_id=$1 AND d.delegator_id = ANY($2) AND d.revoked_at IS NULL AND $3::date BETWEEN d.starts_on AND d.ends_on`,
      [tenantId, people, today],
    );
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
  const r = await db.query<{ blocked: string[]; self_approver_id: string | null }>(
    `SELECT r.self_approver_id, array_remove(r.excluded_user_ids || r.requester_id || coalesce((SELECT array_agg(p.acted_by) || array_agg(p.acted_for) FROM approval_steps p
       WHERE p.tenant_id=r.tenant_id AND p.request_id=r.id AND p.acted_by IS NOT NULL), '{}'), NULL) AS blocked
       FROM approval_requests r WHERE r.tenant_id=$1 AND r.id=$2`,
    [tenantId, requestId],
  );
  const blocked = new Set(r.rows[0]?.blocked ?? []);
  if (r.rows[0]?.self_approver_id) blocked.delete(r.rows[0].self_approver_id);
  return blocked;
}

/** Notify whoever can act on the request's active step (never the requester), including delegates covering for the approver. */
async function notifyActiveApprovers(db: Db, tenantId: string, requestId: string, opts: { onlyEscalation?: boolean } = {}) {
  const r = await db.query<ActiveStep & { summary: string; entity_type: string; requester_name: string }>(
    `SELECT r.summary, r.entity_type, u.display_name AS requester_name, s.approver_kind, s.approver_user_id, s.approver_permission, s.escalated_to, s.escalated_permission
       FROM approval_requests r JOIN approval_steps s ON s.tenant_id=r.tenant_id AND s.request_id=r.id AND s.status='active'
       JOIN users u ON u.id=r.requester_id WHERE r.tenant_id=$1 AND r.id=$2 AND r.status='pending'`,
    [tenantId, requestId],
  );
  const step = r.rows[0];
  if (!step || allOff(handlers.get(step.entity_type)?.feature)) return;
  const blocked = await blockedUsers(db, tenantId, requestId);
  const today = await orgToday(db, tenantId);
  // On escalation only the new parties are told; the original approver hears separately.
  const { direct, delegates } = await stepRecipients(
    db,
    tenantId,
    opts.onlyEscalation
      ? { approver_kind: 'user', approver_user_id: null, approver_permission: null, escalated_to: step.escalated_to, escalated_permission: step.escalated_permission }
      : step,
    today,
  );
  const label = handlers.get(step.entity_type)?.label ?? 'Request';
  const title = opts.onlyEscalation ? `Escalated to you: ${label.toLowerCase()} from ${step.requester_name}` : `${label} from ${step.requester_name} needs your approval`;
  await notifyUsers(
    db,
    tenantId,
    direct.filter((u) => !blocked.has(u)),
    {
      kind: opts.onlyEscalation ? 'approval.escalated' : 'approval.requested',
      title,
      body: step.summary,
      link: '/approvals',
      actionLabel: 'Review',
      feature: handlers.get(step.entity_type)?.feature,
    },
  );
  const names = await displayNames(db, tenantId, [...new Set(delegates.values())]);
  for (const [delegate, delegator] of delegates) {
    if (blocked.has(delegate)) continue;
    await notifyUsers(db, tenantId, [delegate], {
      kind: opts.onlyEscalation ? 'approval.escalated' : 'approval.requested',
      title: `${title} (covering for ${names.get(delegator) ?? 'a colleague'})`,
      body: step.summary,
      link: '/approvals',
      actionLabel: 'Review',
      feature: handlers.get(step.entity_type)?.feature,
    });
  }
}

const handlers = new Map<string, ApprovalHandler>();
export function registerApprovalHandler(entityType: string, h: ApprovalHandler) {
  handlers.set(entityType, h);
}

/**
 * Requests of a module that is off: out of every inbox, nobody can act on them, no reminder or escalation runs and nobody is told.
 * Their state is untouched, so they carry on as they were when the flag returns.
 */
export const offEntityTypes = () => [...handlers].filter(([, h]) => allOff(h.feature)).map(([type]) => type);
function assertEntityOn(entityType: string) {
  if (allOff(handlers.get(entityType)?.feature)) throw notFound('Approval request not found');
}

export const handlerFeature = (entityType: string) => handlers.get(entityType)?.feature;

export interface Actor {
  userId: string;
  permissions: Set<string>;
}

export async function createApprovalRequest(
  db: Db,
  tenantId: string,
  p: {
    entityType: string;
    entityId: string;
    requesterId: string;
    summary: string;
    steps: StepSpec[];
    /** Others who must never act on it: the author when someone else submits, the employee it is about. */
    excludeUserIds?: (string | null | undefined)[];
  },
) {
  if (!handlers.has(p.entityType)) throw new Error(`No approval handler for ${p.entityType}`);
  const collapsedRoute = isCollapsedMode() ? await collapseSteps(db, tenantId, p) : null;
  const selfApprover = collapsedRoute?.selfApprover ?? null;
  const excluded = [...new Set(p.excludeUserIds?.filter((u): u is string => !!u && u !== p.requesterId && u !== selfApprover) ?? [])];
  const blocked = new Set([p.requesterId, ...excluded]);
  if (selfApprover) blocked.delete(selfApprover);
  const wanted = collapsedRoute?.steps ?? p.steps;
  const named = wanted.flatMap((s) => (s.kind === 'user' ? [s.userId] : []));
  const active = new Set(
    named.length ? (await db.query<{ id: string }>(`SELECT id FROM users WHERE tenant_id=$1 AND id = ANY($2) AND status='active'`, [tenantId, named])).rows.map((u) => u.id) : [],
  );
  // Maker-checker: neither the requester nor an excluded party is ever an approver of the request. A disabled account cannot act either.
  const kept = wanted.filter((s) => s.kind !== 'user' || (!blocked.has(s.userId) && active.has(s.userId)));
  const steps: StepSpec[] = kept.length ? kept : [{ kind: 'permission', permission: ESCALATION_PERMISSION }];
  // Summaries reach inboxes, notifications and email in plaintext: no figure, whoever wrote it.
  const r = await db.query<{ id: string }>(
    `INSERT INTO approval_requests (tenant_id, entity_type, entity_id, requester_id, summary, excluded_user_ids, self_approver_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [tenantId, p.entityType, p.entityId, p.requesterId, scrubAmounts(p.summary), excluded, selfApprover],
  );
  const id = r.rows[0]!.id;
  const fallbackOpen = (await eligibleHolders(db, tenantId, ESCALATION_PERMISSION, blocked)).length > 0;
  let nobody = false;
  for (const [i, s] of steps.entries()) {
    const open = s.kind === 'user' || (await eligibleHolders(db, tenantId, s.permission, blocked)).length > 0;
    if (!open && !fallbackOpen) nobody = true;
    await db.query(
      `INSERT INTO approval_steps (tenant_id, request_id, step_index, approver_kind, approver_user_id, approver_permission, status, activated_at, escalated_at, escalated_permission)
      VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7='active' THEN now() END, CASE WHEN $8::text IS NOT NULL THEN now() END, $8)`,
      [
        tenantId,
        id,
        i,
        s.kind,
        s.kind === 'user' ? s.userId : null,
        s.kind === 'permission' ? s.permission : null,
        i === 0 ? 'active' : 'waiting',
        !open && fallbackOpen ? ESCALATION_PERMISSION : null,
      ],
    );
  }
  await notifyActiveApprovers(db, tenantId, id);
  if (nobody) await warnNoApprover(db, tenantId, id, p.entityType, p.requesterId);
  return id;
}

/** The organization's owner: the oldest active holder of an owner role. In `multi` this is the top Super-admin. */
export async function ownerUserId(db: Db, tenantId: string) {
  const r = await db.query<{ id: string }>(
    `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id AND ur.tenant_id=u.tenant_id
    WHERE u.tenant_id=$1 AND u.status='active' AND ur.role_key = ANY($2) ORDER BY (ur.role_key='owner') DESC, u.created_at, u.id LIMIT 1`,
    [tenantId, OWNER_ROLE_KEYS],
  );
  return r.rows[0]?.id ?? null;
}

/**
 * The one step of a smaller mode, for any request. Money stays with the owner: expenses, loans, advances, travel and overtime pay are
 * never decided by HR alone (see DECISIONS.md). So does anything HR raised or that is about an HR holder. A requester who is the only HR
 * person therefore cannot strand their own request, and the owner's own request comes back to them, on the record.
 */
async function collapseSteps(db: Db, tenantId: string, p: { entityType: string; requesterId: string; steps: StepSpec[]; excludeUserIds?: (string | null | undefined)[] }) {
  const owner = await ownerUserId(db, tenantId);
  if (!owner) return null;
  const parties = new Set([p.requesterId, ...(p.excludeUserIds ?? []).filter((u): u is string => !!u)]);
  const selfApprover = parties.has(owner) ? owner : null;
  const toOwner = { steps: [{ kind: 'user', userId: owner }] as StepSpec[], selfApprover };
  if (currentMode() === 'single' || selfApprover) return toOwner;
  if (p.entityType === 'overtime_claim' || p.steps.some((s) => s.kind === 'permission' && MONEY_PERMISSIONS.has(s.permission))) return toOwner;
  const hr = new Set(await usersWithPermission(db, tenantId, HR_STEP_PERMISSION));
  if ([...parties].some((u) => hr.has(u))) return toOwner;
  return { steps: [{ kind: 'permission', permission: HR_STEP_PERMISSION }] as StepSpec[], selfApprover: null };
}

export interface RouteInput {
  requesterId: string;
  /** The employee's account, when they have one: they never decide their own request. */
  subjectUserId?: string | null;
  /** The employee's manager's account (active), when there is one. */
  managerUserId?: string | null;
  /** Steps after the manager's, in order. */
  then?: readonly string[];
  /** Only when no manager can decide it. */
  ifNoManager?: readonly string[];
}

/**
 * The approval route of a manager-first request, in one place. `multi`: the manager (unless they are the requester or the employee), then
 * `then`, or `ifNoManager` when nobody manages them. The smaller modes collapse whatever this returns to one step in createApprovalRequest.
 */
export function buildSteps(r: RouteInput): StepSpec[] {
  const mgr = r.managerUserId && r.managerUserId !== r.requesterId && r.managerUserId !== r.subjectUserId ? r.managerUserId : null;
  return [
    ...(mgr ? [{ kind: 'user', userId: mgr } as StepSpec] : []),
    ...[...(r.then ?? []), ...(mgr ? [] : (r.ifNoManager ?? []))].map((permission): StepSpec => ({ kind: 'permission', permission })),
  ];
}

/** Holders of a permission who may act on a request with these people blocked. */
async function eligibleHolders(db: Db, tenantId: string, permission: string, blocked: Set<string>) {
  return (await usersWithPermission(db, tenantId, permission)).filter((u) => !blocked.has(u));
}

/** Nobody can act on this request as things stand: administrators and the requester are told, and it is on record. */
async function warnNoApprover(db: Db, tenantId: string, requestId: string, entityType: string, requesterId: string) {
  if (allOff(handlers.get(entityType)?.feature)) return;
  const label = handlers.get(entityType)?.label ?? 'Request';
  const admins = await usersWithPermission(db, tenantId, 'users.manage');
  await notifyUsers(db, tenantId, [...new Set([...admins, requesterId])], {
    kind: 'approval.no_approver',
    title: `${label} has nobody who can approve it`,
    body: 'Nobody eligible holds the permission it needs. An administrator can reassign it, or grant the permission to someone else.',
    link: '/approvals',
    actionLabel: 'Open',
    feature: handlers.get(entityType)?.feature,
  });
  await audit(db, { tenantId, actorId: null, actorType: 'system', action: 'approval.no_eligible_approver', targetType: entityType, metadata: { approvalRequestId: requestId } });
}

type Role = { via: null | 'delegation' | 'escalation'; forUser: string | null };

/** How this actor may act on the active step today, or null if they may not. */
async function actingRole(db: Db, tenantId: string, step: ActiveStep, actor: Actor, today: string): Promise<Role | null> {
  if (step.approver_kind === 'permission' && actor.permissions.has(step.approver_permission!)) return { via: null, forUser: null };
  if (step.approver_kind === 'user' && step.approver_user_id === actor.userId) return { via: null, forUser: null };
  if (step.escalated_to === actor.userId || (step.escalated_permission && actor.permissions.has(step.escalated_permission)))
    return { via: 'escalation', forUser: step.approver_user_id };
  const people = [step.approver_kind === 'user' ? step.approver_user_id : null, step.escalated_to].filter((x): x is string => !!x);
  if (step.approver_permission === HR_STEP_PERMISSION) people.push(...(await usersWithPermission(db, tenantId, HR_STEP_PERMISSION)));
  if (!people.length) return null;
  const d = await db.query<{ delegator_id: string }>(
    `SELECT delegator_id FROM approval_delegations WHERE tenant_id=$1 AND delegate_id=$2 AND delegator_id = ANY($3) AND revoked_at IS NULL
        AND $4::date BETWEEN starts_on AND ends_on ORDER BY (delegator_id = $5) DESC LIMIT 1`,
    [tenantId, actor.userId, people, today, people[0]],
  );
  return d.rows[0] ? { via: 'delegation', forUser: d.rows[0].delegator_id } : null;
}

export async function actOnRequest(
  db: Db,
  tenantId: string,
  requestId: string,
  actor: Actor,
  action: 'approve' | 'reject' | 'return',
  comment: string | undefined,
  audBase: { requestId: string; ip: string },
) {
  const rq = await db.query<{
    id: string;
    entity_type: string;
    entity_id: string;
    requester_id: string;
    status: string;
    current_step: number;
    excluded_user_ids: string[];
    self_approver_id: string | null;
  }>('SELECT id, entity_type, entity_id, requester_id, status, current_step, excluded_user_ids, self_approver_id FROM approval_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
    tenantId,
    requestId,
  ]);
  const req = rq.rows[0];
  if (!req) throw notFound('Approval request not found');
  assertEntityOn(req.entity_type);
  if (req.status !== 'pending') throw conflict(`This request is already ${req.status}`);
  const selfDecision = req.self_approver_id === actor.userId;
  if (req.requester_id === actor.userId && !selfDecision) throw forbidden('You cannot approve or reject your own request');
  if (req.excluded_user_ids.includes(actor.userId) && !selfDecision) throw forbidden('You cannot act on a request you prepared or that concerns you');
  const blocked = await blockedUsers(db, tenantId, requestId);
  if (blocked.has(actor.userId)) throw forbidden('You already approved an earlier step; a different person must approve this one');
  if (action !== 'approve' && !comment?.trim()) throw badRequest('A comment is required when rejecting or returning a request');
  const st = await db.query<ActiveStep & { id: string; step_index: number }>(
    `SELECT id, step_index, approver_kind, approver_user_id, approver_permission, escalated_to, escalated_permission FROM approval_steps
      WHERE tenant_id=$1 AND request_id=$2 AND status='active' FOR UPDATE`,
    [tenantId, requestId],
  );
  const step = st.rows[0];
  const role = step ? await actingRole(db, tenantId, step, actor, await orgToday(db, tenantId)) : null;
  if (!step || !role) throw forbidden('You are not the approver for the current step');
  // Covering for someone who already decided an earlier step would let one person approve twice.
  if (role.via === 'delegation' && role.forUser && blocked.has(role.forUser))
    throw forbidden('The person you are covering for decided an earlier step; a different person must approve this one');
  const h = handlers.get(req.entity_type)!;

  const stepStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'returned';
  await db.query(`UPDATE approval_steps SET status=$3, acted_by=$4, acted_at=now(), comment=$5, acted_for=$6, acted_via=$7 WHERE tenant_id=$1 AND id=$2`, [
    tenantId,
    step.id,
    stepStatus,
    actor.userId,
    comment ?? null,
    role.via ? role.forUser : null,
    role.via,
  ]);

  let final: string | null = null;
  if (action === 'approve') {
    const next = await db.query<{ id: string }>(
      `UPDATE approval_steps SET status='active', activated_at=now() WHERE tenant_id=$1 AND request_id=$2 AND step_index=$3 RETURNING id`,
      [tenantId, requestId, step.step_index + 1],
    );
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
      kind: `approval.${final}`,
      title: `Your ${(h.label ?? 'request').toLowerCase()} was ${verb}`,
      body: comment ? `${summary} — “${comment.slice(0, 300)}”` : summary,
      link: h.requesterLink ?? '/approvals',
      actionLabel: 'View',
      feature: h.feature,
    });
  }
  if (selfDecision)
    await audit(db, {
      tenantId,
      actorId: actor.userId,
      action: 'approval.self_approved',
      category: 'security',
      targetType: req.entity_type,
      targetId: req.entity_id,
      metadata: { approvalRequestId: requestId, decision: stepStatus },
      ...audBase,
    });
  await audit(db, {
    tenantId,
    actorId: actor.userId,
    action: `approval.${stepStatus}`,
    targetType: req.entity_type,
    targetId: req.entity_id,
    metadata: { approvalRequestId: requestId, step: step.step_index, final, comment, ...(role.via ? { via: role.via, onBehalfOf: role.forUser } : {}) },
    ...audBase,
  });
  return { status: final ?? 'pending' };
}

/**
 * Withdraw a pending request. Only its requester, unless the module has already decided the actor may
 * (`subjectMayWithdraw`: the employee a request was filed for on their behalf).
 */
export async function cancelRequest(
  db: Db,
  tenantId: string,
  requestId: string,
  actorId: string,
  audBase: { requestId: string; ip: string },
  opts: { subjectMayWithdraw?: boolean } = {},
) {
  const rq = await db.query<{ entity_type: string; entity_id: string; requester_id: string; status: string }>(
    'SELECT entity_type, entity_id, requester_id, status FROM approval_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
    [tenantId, requestId],
  );
  const req = rq.rows[0];
  if (!req) throw notFound('Approval request not found');
  assertEntityOn(req.entity_type);
  if (req.requester_id !== actorId && !opts.subjectMayWithdraw) throw forbidden('Only the requester can cancel this request');
  if (req.status !== 'pending') throw conflict(`This request is already ${req.status}`);
  await db.query(`UPDATE approval_requests SET status='cancelled', decided_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, requestId]);
  await db.query(`UPDATE approval_steps SET status='skipped' WHERE tenant_id=$1 AND request_id=$2 AND status IN ('waiting','active')`, [tenantId, requestId]);
  await handlers.get(req.entity_type)!.onRejected(db, tenantId, req.entity_id, actorId, 'cancelled');
  await audit(db, {
    tenantId,
    actorId,
    action: 'approval.cancelled',
    targetType: req.entity_type,
    targetId: req.entity_id,
    metadata: { approvalRequestId: requestId },
    ...audBase,
  });
}

/**
 * Pending requests whose ACTIVE step this actor can act on (never their own), with how: `via` is null when it is
 * addressed to them, 'delegation' when they cover for `on_behalf_of`, 'escalation' when it was escalated to them.
 */
export async function inbox(db: Db, tenantId: string, actor: Actor, today?: string, page?: { page: number; pageSize: number }) {
  today ??= await orgToday(db, tenantId);
  const coveringHr = await coveringHrStep(db, tenantId, actor.userId, today);
  const sql = `SELECT r.id, r.entity_type, r.entity_id, r.summary, r.created_at, r.current_step, u.display_name AS requester_name,
      s.approver_kind, s.approver_permission, s.approver_user_id, s.escalated_to, s.escalated_permission, s.escalated_at, au.display_name AS approver_name,
      dl.delegator_id AS delegated_by, du.display_name AS delegated_by_name
    FROM approval_requests r JOIN approval_steps s ON s.tenant_id=r.tenant_id AND s.request_id=r.id AND s.status='active'
    JOIN users u ON u.id=r.requester_id
    LEFT JOIN users au ON au.id=s.approver_user_id
    LEFT JOIN LATERAL (SELECT d.delegator_id FROM approval_delegations d WHERE d.tenant_id=r.tenant_id AND d.delegate_id=$2 AND d.revoked_at IS NULL
        AND $4::date BETWEEN d.starts_on AND d.ends_on AND s.approver_kind='user' AND d.delegator_id IN (s.approver_user_id, s.escalated_to)
        ORDER BY (d.delegator_id = s.approver_user_id) DESC LIMIT 1) dl ON true
    LEFT JOIN users du ON du.id=dl.delegator_id
    WHERE r.tenant_id=$1 AND r.status='pending' AND ((r.requester_id <> $2 AND NOT ($2 = ANY(r.excluded_user_ids))) OR r.self_approver_id = $2) AND NOT (r.entity_type = ANY($5))
      AND ((s.approver_kind='user' AND (s.approver_user_id=$2 OR dl.delegator_id IS NOT NULL))
        OR (s.approver_kind='permission' AND (s.approver_permission = ANY($3) OR ($6 AND s.approver_permission = '${HR_STEP_PERMISSION}')))
        OR s.escalated_to=$2 OR s.escalated_permission = ANY($3))
      AND NOT EXISTS (SELECT 1 FROM approval_steps p WHERE p.tenant_id=r.tenant_id AND p.request_id=r.id AND p.acted_by IS NOT NULL
        AND (p.acted_by=$2 OR p.acted_for=$2 OR (dl.delegator_id IS NOT NULL AND s.approver_user_id IS DISTINCT FROM $2 AND p.acted_by=dl.delegator_id)))
    ORDER BY r.created_at`;
  const args = [tenantId, actor.userId, [...actor.permissions], today, offEntityTypes(), coveringHr];
  type Row = {
    id: string;
    approver_kind: string;
    approver_user_id: string | null;
    approver_permission: string | null;
    escalated_to: string | null;
    escalated_permission: string | null;
    delegated_by: string | null;
    delegated_by_name: string | null;
    approver_name: string | null;
  };
  const total = page ? Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM (${sql}) counted`, args)).rows[0]!.n) : null;
  const r = await db.query<Row>(page ? `${sql} LIMIT ${page.pageSize} OFFSET ${(page.page - 1) * page.pageSize}` : sql, args);
  const items = r.rows.map(({ delegated_by, delegated_by_name, approver_name, ...x }) => {
    const mine = (x.approver_kind === 'permission' && actor.permissions.has(x.approver_permission!)) || x.approver_user_id === actor.userId;
    const escalated = !mine && (x.escalated_to === actor.userId || (!!x.escalated_permission && actor.permissions.has(x.escalated_permission)));
    const via = mine ? null : escalated ? 'escalation' : 'delegation';
    return {
      ...x,
      approver_name,
      via,
      on_behalf_of: via === 'escalation' ? approver_name : via === 'delegation' ? delegated_by_name : null,
      delegated_by: via === 'delegation' ? delegated_by : null,
    };
  });
  return { items, total: total ?? items.length };
}

/**
 * Pending requests nobody can decide: every person the active step reaches is disabled, blocked as requester or earlier decider, or does not exist.
 * A page of them, oldest first. Read from `stepRecipients` and `blockedUsers`, the rules the inbox and the decision itself follow.
 */
export async function stuckRequests(db: Db, tenantId: string, page: { page: number; pageSize: number }) {
  const today = await orgToday(db, tenantId);
  const rows = (
    await db.query<ActiveStep & { id: string; entity_type: string; entity_id: string; summary: string; created_at: Date; requester_name: string }>(
      `SELECT r.id, r.entity_type, r.entity_id, r.summary, r.created_at, u.display_name AS requester_name,
       s.id AS step_id, s.step_index, s.approver_kind, s.approver_user_id, s.approver_permission, s.escalated_to, s.escalated_permission
     FROM approval_requests r JOIN approval_steps s ON s.tenant_id=r.tenant_id AND s.request_id=r.id AND s.status='active' JOIN users u ON u.id=r.requester_id
     WHERE r.tenant_id=$1 AND r.status='pending' AND NOT (r.entity_type = ANY($2)) ORDER BY r.created_at`,
      [tenantId, offEntityTypes()],
    )
  ).rows;
  const stuck: { id: string; entity_type: string; entity_id: string; summary: string; created_at: Date; requester_name: string }[] = [];
  for (const row of rows) {
    const { direct, delegates } = await stepRecipients(db, tenantId, row, today);
    const blocked = await blockedUsers(db, tenantId, row.id);
    const candidates = [...direct, ...delegates.keys()].filter((u) => !blocked.has(u));
    const active = candidates.length ? (await db.query(`SELECT 1 FROM users WHERE tenant_id=$1 AND id = ANY($2) AND status='active' LIMIT 1`, [tenantId, candidates])).rowCount : 0;
    if (!active)
      stuck.push({ id: row.id, entity_type: row.entity_type, entity_id: row.entity_id, summary: row.summary, created_at: row.created_at, requester_name: row.requester_name });
  }
  return { items: stuck.slice((page.page - 1) * page.pageSize, page.page * page.pageSize), page: page.page, pageSize: page.pageSize, total: stuck.length };
}

/** Whether this person covers today for someone who holds the HR step. */
async function coveringHrStep(db: Db, tenantId: string, userId: string, today: string) {
  const d = await db.query<{ delegator_id: string }>(
    `SELECT delegator_id FROM approval_delegations WHERE tenant_id=$1 AND delegate_id=$2 AND revoked_at IS NULL AND $3::date BETWEEN starts_on AND ends_on`,
    [tenantId, userId, today],
  );
  if (!d.rowCount) return false;
  const holders = new Set(await usersWithPermission(db, tenantId, HR_STEP_PERMISSION));
  return d.rows.some((x) => holders.has(x.delegator_id));
}

export async function requestHistory(db: Db, tenantId: string, requestId: string) {
  const r = await db.query(
    `SELECT s.step_index, s.approver_kind, s.approver_permission, au.display_name AS approver_name, s.status,
      s.acted_at, s.comment, ac.display_name AS acted_by_name, s.acted_via, af.display_name AS acted_for_name,
      s.escalated_at, eu.display_name AS escalated_to_name, s.escalated_permission
    FROM approval_steps s LEFT JOIN users au ON au.id=s.approver_user_id LEFT JOIN users ac ON ac.id=s.acted_by
    LEFT JOIN users af ON af.id=s.acted_for LEFT JOIN users eu ON eu.id=s.escalated_to
    WHERE s.tenant_id=$1 AND s.request_id=$2 ORDER BY s.step_index`,
    [tenantId, requestId],
  );
  return r.rows;
}

/** Holders of this permission take escalations when the approver has no manager who can take them. */
export const ESCALATION_PERMISSION = 'approvals.escalations';

/**
 * Escalate active steps addressed to one person that have waited more than `days` days: to the approver's reporting
 * manager, or, when there is none who may act, to holders of `approvals.escalations`. Each step escalates once;
 * the original approver (and their delegate) can still act. Group steps are not escalated, reminders go to the group, except the HR
 * step of `single_hr`, the only route such a request has: it goes to the owner.
 */
export async function escalateOverdue(db: Db, tenantId: string, days: number) {
  const due = await db.query<{ id: string; request_id: string; approver_user_id: string | null; approver_name: string | null; summary: string; entity_type: string }>(
    `SELECT s.id, s.request_id, s.approver_user_id, au.display_name AS approver_name, r.summary, r.entity_type
       FROM approval_steps s JOIN approval_requests r ON r.tenant_id=s.tenant_id AND r.id=s.request_id AND r.status='pending'
       LEFT JOIN users au ON au.id=s.approver_user_id
      WHERE s.tenant_id=$1 AND s.status='active' AND (s.approver_kind='user' OR s.approver_permission='${HR_STEP_PERMISSION}') AND s.escalated_at IS NULL
        AND coalesce(s.activated_at, r.created_at) < now() - make_interval(days => $2) AND NOT (r.entity_type = ANY($3))
      ORDER BY coalesce(s.activated_at, r.created_at) FOR UPDATE OF s SKIP LOCKED`,
    [tenantId, days, offEntityTypes()],
  );
  let toManager = 0,
    toGroup = 0;
  for (const st of due.rows) {
    const blocked = await blockedUsers(db, tenantId, st.request_id);
    const owner = st.approver_user_id ? null : await ownerUserId(db, tenantId);
    const mgr = st.approver_user_id
      ? await activeManagerOf(db, tenantId, st.approver_user_id, blocked)
      : owner && !blocked.has(owner)
        ? { user_id: owner, display_name: 'the owner' }
        : null;
    await db.query(`UPDATE approval_steps SET escalated_at=now(), escalated_to=$3, escalated_permission=$4 WHERE tenant_id=$1 AND id=$2`, [
      tenantId,
      st.id,
      mgr?.user_id ?? null,
      mgr ? null : ESCALATION_PERMISSION,
    ]);
    if (mgr) toManager++;
    else toGroup++;
    await notifyActiveApprovers(db, tenantId, st.request_id, { onlyEscalation: true });
    const label = handlers.get(st.entity_type)?.label ?? 'Request';
    if (st.approver_user_id)
      await notifyUsers(db, tenantId, [st.approver_user_id], {
        kind: 'approval.escalated',
        title: `${label} escalated to ${mgr ? mgr.display_name : 'HR'} after ${days} day(s)`,
        body: `${st.summary} — you can still decide it.`,
        link: '/approvals',
        actionLabel: 'Review',
        feature: handlers.get(st.entity_type)?.feature,
      });
    await audit(db, {
      tenantId,
      actorId: null,
      actorType: 'system',
      action: 'approval.escalated',
      targetType: st.entity_type,
      metadata: { approvalRequestId: st.request_id, from: st.approver_user_id, to: mgr?.user_id ?? ESCALATION_PERMISSION, afterDays: days },
    });
  }
  return { escalated: due.rowCount ?? 0, toManager, toGroup };
}

/** The person's reporting manager, if they have an active account and may act with these people blocked. */
async function activeManagerOf(db: Db, tenantId: string, userId: string, blocked: Set<string>) {
  const m = await db.query<{ user_id: string; display_name: string }>(
    `SELECT mu.id AS user_id, mu.display_name FROM employees e JOIN employees m ON m.tenant_id=e.tenant_id AND m.id=e.reporting_manager_id
       JOIN users mu ON mu.id=m.user_id AND mu.status='active'
      WHERE e.tenant_id=$1 AND e.user_id=$2 LIMIT 1`,
    [tenantId, userId],
  );
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
        AND (s.escalated_to=$2 OR (s.approver_user_id=$2 AND s.escalated_to IS NULL AND s.escalated_permission IS NULL)) FOR UPDATE OF s`,
    [tenantId, userId],
  );
  for (const st of steps.rows) {
    const blocked = await blockedUsers(db, tenantId, st.request_id);
    const mgr = await activeManagerOf(db, tenantId, userId, blocked);
    await db.query(`UPDATE approval_steps SET escalated_at=now(), escalated_to=$3, escalated_permission=$4 WHERE tenant_id=$1 AND id=$2`, [
      tenantId,
      st.id,
      mgr?.user_id ?? null,
      mgr ? null : ESCALATION_PERMISSION,
    ]);
    if (!mgr && !(await eligibleHolders(db, tenantId, ESCALATION_PERMISSION, blocked)).length) await warnNoApprover(db, tenantId, st.request_id, st.entity_type, st.requester_id);
    if (st.status === 'active') await notifyActiveApprovers(db, tenantId, st.request_id, { onlyEscalation: true });
    await audit(db, {
      tenantId,
      actorId: null,
      actorType: 'system',
      action: 'approval.reassigned',
      targetType: st.entity_type,
      metadata: { approvalRequestId: st.request_id, from: userId, to: mgr?.user_id ?? ESCALATION_PERMISSION, reason: 'approver_disabled' },
    });
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
      WHERE s.tenant_id=$1 AND s.status='active' AND s.approver_kind='permission' AND s.escalated_at IS NULL AND NOT (r.entity_type = ANY($2)) FOR UPDATE OF s SKIP LOCKED`,
    [tenantId, offEntityTypes()],
  );
  let moved = 0;
  for (const st of steps.rows) {
    const blocked = await blockedUsers(db, tenantId, st.request_id);
    if ((await eligibleHolders(db, tenantId, st.approver_permission, blocked)).length) continue;
    await db.query(`UPDATE approval_steps SET escalated_at=now(), escalated_permission=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, st.id, ESCALATION_PERMISSION]);
    if (!(await eligibleHolders(db, tenantId, ESCALATION_PERMISSION, blocked)).length) await warnNoApprover(db, tenantId, st.request_id, st.entity_type, st.requester_id);
    await notifyActiveApprovers(db, tenantId, st.request_id, { onlyEscalation: true });
    await audit(db, {
      tenantId,
      actorId: null,
      actorType: 'system',
      action: 'approval.reassigned',
      targetType: st.entity_type,
      metadata: { approvalRequestId: st.request_id, to: ESCALATION_PERMISSION, reason: 'no_eligible_holder' },
    });
    moved++;
  }
  return moved;
}

/**
 * Hands the active step to a named person, who can then decide it. It stays on the record. Administrators (who are not
 * in any approval chain by role) may do this only for a request nobody can act on; the fallback owner may at any time.
 */
export async function reassignRequest(
  db: Db,
  tenantId: string,
  requestId: string,
  actorId: string,
  targetUserId: string,
  reason: string,
  audBase: { requestId: string; ip: string },
  opts: { onlyIfStuck: boolean },
) {
  const req = (
    await db.query<{ entity_type: string; status: string }>('SELECT entity_type, status FROM approval_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, requestId])
  ).rows[0];
  if (!req) throw notFound('Approval request not found');
  assertEntityOn(req.entity_type);
  if (req.status !== 'pending') throw conflict(`This request is already ${req.status}`);
  const blocked = await blockedUsers(db, tenantId, requestId);
  if (blocked.has(actorId)) throw forbidden('You cannot reassign a request you prepared, that concerns you, or that you already decided');
  if (targetUserId === actorId) throw badRequest('Reassign it to someone else: taking it yourself would let you choose your own approver');
  if (blocked.has(targetUserId)) throw badRequest('That person cannot act on this request');
  const target = await db.query(`SELECT 1 FROM users WHERE tenant_id=$1 AND id=$2 AND status='active'`, [tenantId, targetUserId]);
  if (!target.rowCount) throw badRequest('Choose an active user');
  const step = (
    await db.query<ActiveStep>(
      `SELECT approver_kind, approver_user_id, approver_permission, escalated_to, escalated_permission FROM approval_steps WHERE tenant_id=$1 AND request_id=$2 AND status='active' FOR UPDATE`,
      [tenantId, requestId],
    )
  ).rows[0];
  if (!step) throw conflict('This request has no active step');
  if (opts.onlyIfStuck) {
    const { direct, delegates } = await stepRecipients(db, tenantId, step, await orgToday(db, tenantId));
    const able = await db.query(`SELECT 1 FROM users WHERE tenant_id=$1 AND status='active' AND id = ANY($2) AND NOT (id = ANY($3)) LIMIT 1`, [
      tenantId,
      [...direct, ...delegates.keys()],
      [...blocked],
    ]);
    if (able.rowCount) throw conflict('Someone can still act on this request; only HR can reassign it');
  }
  await db.query(`UPDATE approval_steps SET escalated_at=now(), escalated_to=$3, escalated_permission=NULL WHERE tenant_id=$1 AND request_id=$2 AND status='active'`, [
    tenantId,
    requestId,
    targetUserId,
  ]);
  await notifyActiveApprovers(db, tenantId, requestId, { onlyEscalation: true });
  await audit(db, {
    tenantId,
    actorId,
    action: 'approval.reassigned',
    targetType: req.entity_type,
    metadata: { approvalRequestId: requestId, to: targetUserId, reason },
    ...audBase,
  });
}
