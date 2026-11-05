import { audit } from '../../core/audit/audit.js';
import { anotherActiveOwner } from '../../core/policy/levels.js';
import { revokeAllSessionsForUser } from '../../core/auth/session.js';
import { reassignStepsOf } from '../../core/workflow/engine.js';
import type { Db } from '../../db/tx.js';
import { assertFeatureUsable } from '../../core/features/state.js';
import { usersWithPermission, notifyUsers } from '../../core/notify/service.js';
import { AppError } from '../../core/http/errors.js';

export const OWNERS = ['hr', 'it', 'admin', 'finance', 'manager', 'employee'] as const;
export type Owner = (typeof OWNERS)[number];
/** Which permission lets someone complete a task of each owner group (besides lifecycle.manage). */
export const OWNER_PERMISSION: Record<Owner, string | null> = {
  hr: 'lifecycle.manage',
  admin: 'lifecycle.manage',
  it: 'users.manage',
  finance: 'expenses.pay',
  manager: null,
  employee: null,
};

export async function featureOn(db: Db, tenantId: string, key: string) {
  try {
    await assertFeatureUsable(db, tenantId, key);
    return true;
  } catch (e) {
    if (e instanceof AppError) return false;
    throw e;
  }
}

export interface EmpRow {
  id: string;
  user_id: string | null;
  manager_user_id: string | null;
  name: string;
  status: string;
  employment_type: string;
  date_of_joining: string;
  probation_end_date: string | null;
}
export async function loadEmp(db: Db, tenantId: string, id: string): Promise<EmpRow | undefined> {
  return (
    await db.query<EmpRow>(
      `SELECT e.id, e.user_id, m.user_id AS manager_user_id, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, e.status, e.employment_type,
      e.date_of_joining::text, e.probation_end_date::text
    FROM employees e LEFT JOIN employees m ON m.tenant_id=e.tenant_id AND m.id=e.reporting_manager_id WHERE e.tenant_id=$1 AND e.id=$2`,
      [tenantId, id],
    )
  ).rows[0];
}

/** Users who should act on a task of this owner group for this employee. */
export async function taskAssignees(db: Db, tenantId: string, owner: Owner, emp: EmpRow): Promise<string[]> {
  if (owner === 'employee') return emp.user_id ? [emp.user_id] : [];
  if (owner === 'manager') return emp.manager_user_id ? [emp.manager_user_id] : await usersWithPermission(db, tenantId, 'lifecycle.manage');
  return usersWithPermission(db, tenantId, OWNER_PERMISSION[owner]!);
}

export function canActOnTask(owner: Owner, emp: { user_id: string | null; manager_user_id: string | null }, user: { userId: string; permissions: Set<string> }) {
  if (user.permissions.has('lifecycle.manage')) return true;
  if (owner === 'employee') return emp.user_id === user.userId;
  if (owner === 'manager') return emp.manager_user_id === user.userId;
  return user.permissions.has(OWNER_PERMISSION[owner]!);
}

/** Instantiate a checklist from a template (default for the kind when none is given). Returns null when no template exists. */
export async function createChecklist(
  db: Db,
  tenantId: string,
  p: { kind: 'onboarding' | 'offboarding'; employeeId: string; anchorDate: string; templateId?: string | null; separationId?: string | null; actorId: string | null },
) {
  const tpl = (
    await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM checklist_templates WHERE tenant_id=$1 AND kind=$2 AND status='active'
    AND (($3::uuid IS NULL AND is_default) OR id=$3) LIMIT 1`,
      [tenantId, p.kind, p.templateId ?? null],
    )
  ).rows[0];
  if (!tpl) return null;
  const id = (
    await db.query<{ id: string }>(
      `INSERT INTO checklists (tenant_id, kind, employee_id, template_id, separation_id, anchor_date, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [tenantId, p.kind, p.employeeId, tpl.id, p.separationId ?? null, p.anchorDate, p.actorId],
    )
  ).rows[0]!.id;
  await db.query(
    `INSERT INTO checklist_tasks (tenant_id, checklist_id, position, title, description, owner, due_date)
    SELECT $1, $2, position, title, description, owner, $3::date + offset_days FROM checklist_template_tasks WHERE tenant_id=$1 AND template_id=$4 ORDER BY position`,
    [tenantId, id, p.anchorDate, tpl.id],
  );
  const emp = (await loadEmp(db, tenantId, p.employeeId))!;
  const owners = (await db.query<{ owner: Owner }>('SELECT DISTINCT owner FROM checklist_tasks WHERE tenant_id=$1 AND checklist_id=$2', [tenantId, id])).rows;
  const users = new Set<string>();
  for (const o of owners) for (const u of await taskAssignees(db, tenantId, o.owner, emp)) users.add(u);
  await notifyUsers(db, tenantId, [...users], {
    kind: `lifecycle.${p.kind}`,
    title: `${p.kind === 'onboarding' ? 'Onboarding' : 'Exit clearance'}: ${emp.name}`,
    body: `You have tasks in the ${tpl.name} checklist.`,
    link: '/lifecycle?tab=tasks',
    actionLabel: 'Open tasks',
    dedupeKey: `checklist:${id}`,
  });
  return id;
}

/** Closes the checklist when every task is done or skipped. */
export async function maybeCompleteChecklist(db: Db, tenantId: string, checklistId: string) {
  await db.query(
    `UPDATE checklists c SET status='completed', completed_at=now() WHERE c.tenant_id=$1 AND c.id=$2 AND c.status='open'
    AND NOT EXISTS (SELECT 1 FROM checklist_tasks t WHERE t.tenant_id=c.tenant_id AND t.checklist_id=c.id AND t.status='pending')`,
    [tenantId, checklistId],
  );
}

/** Ends a person's access: disables the login, revokes every session and hands over approvals waiting on them. */
export async function endAccess(db: Db, tenantId: string, employeeId: string) {
  const u = (await db.query<{ user_id: string | null }>('SELECT user_id FROM employees WHERE tenant_id=$1 AND id=$2', [tenantId, employeeId])).rows[0]?.user_id;
  if (!u) return false;
  // The last owner cannot be cut off by a date or a separation: nobody else could ever recover the installation. HR sees it on the audit log.
  const owner = await db.query(`SELECT 1 FROM user_roles WHERE tenant_id=$1 AND user_id=$2 AND role_key='owner'`, [tenantId, u]);
  if (owner.rowCount && !(await anotherActiveOwner(db, tenantId, u))) {
    await audit(db, { tenantId, actorId: null, actorType: 'system', action: 'user.end_access_refused_last_owner', category: 'security', targetType: 'user', targetId: u });
    return false;
  }
  await db.query(`UPDATE users SET status='disabled', updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status <> 'disabled'`, [tenantId, u]);
  await revokeAllSessionsForUser(db, u);
  await reassignStepsOf(db, tenantId, u);
  return true;
}
