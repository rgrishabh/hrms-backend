import type { Db } from '../../db/tx.js';

/**
 * The salary hierarchy. A user's effective level is their stored level, raised to their roles' floor and held under their
 * roles' ceiling: a misconfigured administrator cannot put someone below what their role implies, and no setting can lift
 * HR above an administrator. Product constants (configuration layer 4). An employee without a login is level 0.
 */
const FLOORS: Readonly<Record<string, number>> = {
  owner: 100, tenant_admin: 90, it_admin: 60, finance_manager: 50, hr_admin: 40, payroll_manager: 40, hr_executive: 30, auditor: 30,
  department_head: 10, laboratory_manager: 10, quality_manager: 10, reporting_manager: 10, hiring_approver: 10, employee: 0,
};
/**
 * Highest level a role can be set to. HR stays under every administrator; payroll can be made senior, but stays under Super-admin. Holding
 * several, the highest counts. Employee and manager roles say nothing here, so holding them next to HR cannot lift HR's limit.
 */
const CEILINGS: Readonly<Record<string, number | null>> = {
  owner: 100, tenant_admin: 100, it_admin: 89, finance_manager: 89, payroll_manager: 89, auditor: 59, hr_admin: 59, hr_executive: 59,
  department_head: null, laboratory_manager: null, quality_manager: null, reporting_manager: null, hiring_approver: null, employee: null,
};
const CUSTOM_ROLE_CEILING = 59;
/** Someone with no role that sets a limit. They can be protected as a subject, up to below Super-admin. */
const DEFAULT_CEILING = 89;

export const SALARY_LEVEL_MAX = 100;
export const roleFloor = (role: string) => FLOORS[role] ?? 0;

/** Effective level, from what is stored and the roles held. Custom roles add no floor, and stay under the administrators. */
export function effectiveLevel(stored: number, roles: readonly string[]): number {
  const floor = Math.max(0, ...roles.map(roleFloor));
  const limits = roles.map((r) => (r in CEILINGS ? CEILINGS[r]! : CUSTOM_ROLE_CEILING)).filter((c): c is number => c !== null);
  const ceiling = limits.length ? Math.max(...limits) : DEFAULT_CEILING;
  return Math.max(floor, Math.min(stored, ceiling));
}

/** Whether someone other than this user is an active owner. The hierarchy needs a top, so the last one stays. */
export async function anotherActiveOwner(db: Db, tenantId: string, userId: string) {
  const r = await db.query(`SELECT 1 FROM user_roles r JOIN users u ON u.id=r.user_id WHERE r.tenant_id=$1 AND r.role_key='owner' AND u.status='active' AND r.user_id <> $2 LIMIT 1`, [tenantId, userId]);
  return !!r.rowCount;
}

const whenList = (map: Readonly<Record<string, number | null>>) => Object.entries(map).map(([k, v]) => `WHEN '${k}' THEN ${v === null ? 'NULL::int' : v}`).join(' ');

/**
 * The same computation in SQL, generated from the same tables so the two cannot drift: the effective level of the user `userColumn`
 * points at; 0 when it is NULL (an employee with no login). Used per row by row filters.
 */
export function effectiveLevelSql(userColumn: string): string {
  return `coalesce((SELECT greatest(coalesce(max(CASE ur.role_key ${whenList(FLOORS)} ELSE 0 END), 0),
      least(lu.salary_access_level, coalesce(max(CASE ur.role_key ${whenList(CEILINGS)} ELSE ${CUSTOM_ROLE_CEILING} END), ${DEFAULT_CEILING})))
    FROM users lu LEFT JOIN user_roles ur ON ur.user_id = lu.id WHERE lu.id = ${userColumn} GROUP BY lu.salary_access_level), 0)`;
}
