import * as R from '../../core/http/responses.js';
import { reassignStepsOf } from '../../core/workflow/engine.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantActor, tenantActorAny, requireFeature } from '../../core/http/context.js';
import { JOBS, JOB_MAP, nextRun, jobActive } from '../../core/jobs/registry.js';
import { enqueueRun, localNow, MAX_ATTEMPTS } from '../../core/jobs/scheduler.js';
import { SETTINGS } from '../../core/settings/registry.js';
import { resolveSetting, writeSetting, clearSetting } from '../../core/settings/service.js';
import { allOff, evaluateFeatures, isModuleEnabled } from '../../core/features/state.js';
import { FEATURE_MAP, dependentsOf } from '../../core/features/registry.js';
import { audit } from '../../core/audit/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { PageQuery, offsetOf, paged, Uuid, ListQuery, pageOf } from '../../core/http/pagination.js';
import type { PublicConfig } from '../../config/installation.js';
import { SYSTEM_ROLES, SYSTEM_ROLE_MAP, PERMISSIONS, permissionFeature, roleGroup, assignableRoles, isOwnerRole, OWNER_ROLE_KEYS } from '../../core/auth/permissions.js';
import { currentMode, isCollapsedMode } from '../../core/policy/mode.js';
import { outranks } from '../../core/policy/salary.js';
import { anotherActiveOwner, effectiveLevel, roleFloor, SALARY_LEVEL_MAX } from '../../core/policy/levels.js';
import { redact } from '../../core/audit/audit.js';
import { emailLink } from '../../core/auth/links.js';
import { getSettingValue } from '../../core/settings/service.js';
import { companyRoutes } from './company.js';
import { dataRightsRoutes } from '../data-rights/routes.js';
import { notifyUsers } from '../../core/notify/service.js';
import { revokeAllSessionsForUser } from '../../core/auth/session.js';
import { clearLoginAccount } from '../../core/auth/throttle.js';

/** The modes without role screens answer 404 here, like any address that does not exist. */
const noRoleScreens = () => {
  if (isCollapsedMode()) throw notFound();
};
const isOwnerOrSuperAdmin = (a: { user: { roles: string[] } }) => a.user.roles.some(isOwnerRole);

const SettingsQuery = z.object({ branchId: Uuid.optional() });
const SettingsParams = z.object({ key: z.string() });
const DeleteSettingsQuery = z.object({ scope: z.enum(['tenant', 'branch']).default('tenant'), branchId: Uuid.optional() });
const RolesParams = z.object({ key: z.string().regex(/^custom:[a-z0-9_]+$/, 'Built-in roles cannot be changed') });
const DeleteRolesParams = z.object({ key: z.string().regex(/^custom:[a-z0-9_]+$/, 'Built-in roles cannot be deleted') });
const UsersQuery = PageQuery.extend({ search: z.string().trim().max(100).optional() });
const IdParams = z.object({ id: Uuid });
const UsersSalaryLevelBody = z.object({ level: z.number().int().min(0).max(SALARY_LEVEL_MAX) });
const AuditQuery = PageQuery.extend({
  category: z.enum(['auth', 'configuration', 'data', 'security', 'access']).optional(),
  targetType: z.string().max(50).optional(),
  targetId: z.string().max(100).optional(),
  action: z.string().max(80).optional(),
});
export async function tenantAdminRoutes(app: FastifyInstance, opts: { publicConfig: PublicConfig }) {
  await app.register(companyRoutes);
  await app.register(dataRightsRoutes, { prefix: '/data-rights' });

  // ------------------------------------------------------------ settings
  app.get('/settings', { schema: { response: { 200: R.GetTenantSettings200 }, querystring: SettingsQuery }, config: { perm: ['settings.read'] } }, async (req) => {
    const a = tenantActor(req, 'settings.read');
    const q = SettingsQuery.parse(req.query);
    return a.tx(async (db) => {
      const items = [];
      for (const d of SETTINGS) {
        if (allOff(d.feature)) continue; // a setting of a module that is off does not exist for this deployment
        const eff = await resolveSetting(db, a.tenantId, d.key, q.branchId);
        items.push({
          key: d.key,
          group: d.group,
          label: d.label,
          description: d.description,
          control: d.control,
          options: d.options ?? null,
          scopes: d.scopes,
          feature: d.feature ?? null,
          editable: a.has(d.editPermission),
          editPermission: d.editPermission,
          effective: eff.value,
          source: eff.source,
          defaultValue: eff.defaultValue,
          platformValue: eff.platformValue ?? null,
          tenantValue: eff.tenantValue ?? null,
          branchValue: eff.branchValue ?? null,
          version: eff.version ?? null,
        });
      }
      return { items };
    });
  });

  const SettingWriteBody = z.object({
    value: z.unknown(),
    scope: z.enum(['tenant', 'branch']).default('tenant'),
    branchId: Uuid.optional(),
    expectedVersion: z.number().int().optional(),
  });

  app.put('/settings/:key', { schema: { response: { 200: R.PutTenantSettingsByKey200 }, params: SettingsParams, body: SettingWriteBody } }, async (req) => {
    const { key } = SettingsParams.parse(req.params);
    const def = SETTINGS.find((s) => s.key === key);
    if (!def || allOff(def.feature)) throw notFound('Unknown setting');
    const a = tenantActor(req, def.editPermission);
    const body = SettingWriteBody.parse(req.body);
    return a.tx(async (db) => {
      const res = await writeSetting(db, a.tenantId, { key, value: body.value, scope: body.scope, branchId: body.branchId, expectedVersion: body.expectedVersion }, a.user.userId);
      await audit(db, {
        ...a.auditBase,
        action: 'settings.updated',
        category: 'configuration',
        settingKey: key,
        targetType: body.scope,
        targetId: body.branchId,
        metadata: { from: res.previous ?? null, to: res.value },
      });
      return { key, value: res.value };
    });
  });

  app.delete('/settings/:key', { schema: { response: { 200: R.DeleteTenantSettingsByKey200 }, params: SettingsParams, querystring: DeleteSettingsQuery } }, async (req) => {
    const { key } = SettingsParams.parse(req.params);
    const def = SETTINGS.find((s) => s.key === key);
    if (!def || allOff(def.feature)) throw notFound('Unknown setting');
    const a = tenantActor(req, def.editPermission);
    const q = DeleteSettingsQuery.parse(req.query);
    return a.tx(async (db) => {
      const prev = await clearSetting(db, a.tenantId, key, q.scope, q.branchId);
      if (prev !== undefined) {
        await audit(db, {
          ...a.auditBase,
          action: 'settings.reset_to_inherited',
          category: 'configuration',
          settingKey: key,
          targetType: q.scope,
          targetId: q.branchId,
          metadata: { from: prev },
        });
      }
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ installation (read-only)
  /**
   * What this installation was deployed with: branding, organization identity,
   * domains and modules. All deployment-controlled (Compose .env / Terraform);
   * administrators can see but not change them. Contains no secrets.
   */
  app.get('/installation', { schema: { response: { 200: R.GetTenantInstallation200 } }, config: { perm: ['settings.read'] } }, async (req) => {
    const a = tenantActor(req, 'settings.read');
    return a.tx(async (db) => {
      const states = await evaluateFeatures(db, a.tenantId);
      const domains = (await db.query(`SELECT hostname, activation_status, is_primary FROM tenant_domains WHERE tenant_id=$1 ORDER BY is_primary DESC, hostname`, [a.tenantId]))
        .rows;
      return {
        ...opts.publicConfig,
        domains,
        modules: [...states.values()]
          .filter((s) => s.enabled)
          .map((s) => ({ ...s, availability: FEATURE_MAP.get(s.key)!.availability, dependents: dependentsOf(s.key).map((d) => d.key) })),
        managedBy: 'deployment',
      };
    });
  });

  // ------------------------------------------------------------ scheduled jobs
  app.get('/jobs', { schema: { response: { 200: R.GetTenantJobs200 }, querystring: ListQuery }, config: { perm: ['settings.read'] } }, async (req) => {
    const a = tenantActor(req, 'settings.read');
    const q = ListQuery.parse(req.query);
    return a.tx(async (db) => {
      const states = await evaluateFeatures(db, a.tenantId);
      const tz = await getSettingValue<string>(db, a.tenantId, 'general.timezone');
      const { date, time } = localNow(tz, new Date());
      const runs = await pageOf(
        db,
        `SELECT r.id, r.job_key, r.period_key, r.trigger, r.status, r.attempts, r.started_at, r.finished_at, r.next_retry_at, r.result, r.error,
          u.display_name AS triggered_by_name FROM job_runs r LEFT JOIN users u ON u.id=r.triggered_by
        WHERE r.tenant_id=$1 ORDER BY r.started_at DESC`,
        [a.tenantId],
        q,
      );
      return {
        timezone: tz,
        maxAttempts: MAX_ATTEMPTS,
        runsPage: { page: runs.page, pageSize: runs.pageSize, total: runs.total },
        items: JOBS.filter((j) => j.retention || !allOff(j.feature)).map((j) => ({
          key: j.key,
          name: j.name,
          description: j.description,
          schedule: j.schedule,
          feature: j.feature ?? null,
          active: jobActive(j, (k) => !!states.get(k)?.usable),
          nextRun: nextRun(j.schedule, date, time),
          canRun: a.has(j.runPermission),
          recentRuns: runs.items.filter((r) => r.job_key === j.key).slice(0, 10),
        })),
      };
    });
  });

  app.post(
    '/jobs/:key/run',
    { schema: { response: { 202: R.PostTenantJobsByKeyRun202 }, params: SettingsParams }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { key } = SettingsParams.parse(req.params);
      const job = JOB_MAP.get(key);
      if (!job || (!job.retention && allOff(job.feature))) throw notFound('Unknown job');
      const a = tenantActor(req, job.runPermission);
      if (job.feature && !job.retention)
        await a.tx(async (db) => {
          const keys = typeof job.feature === 'string' ? [job.feature] : job.feature!;
          const states = await evaluateFeatures(db, a.tenantId);
          if (!jobActive(job, (k) => !!states.get(k)?.usable)) await requireFeature(db, a.tenantId, keys.find(isModuleEnabled)!); // throws feature_not_configured
        });
      await a.tx((db) => audit(db, { ...a.auditBase, action: 'job.run_requested', category: 'data', targetType: 'job', targetId: key }));
      reply.code(202);
      return enqueueRun(app.deps.pool, a.tenantId, key, a.user.userId);
    },
  );

  // ------------------------------------------------------------ users & roles
  app.get('/roles', { schema: { response: { 200: R.GetTenantRoles200 } }, config: { permAny: ['users.manage', 'settings.read'] } }, async (req) => {
    noRoleScreens();
    const a = tenantActorAny(req, 'users.manage', 'settings.read');
    // `grantable`: whether this user may grant or remove the role (the same rule assertMayGrant enforces).
    const grantable = (key: string, perms: readonly string[]) =>
      (roleFloor(key) === 0 || roleFloor(key) < a.user.salaryLevel) && (isAdministrator(a) || (!isOwnerRole(key) && perms.every((p) => a.user.permissions.has(p))));
    return a.tx(async (db) => {
      const counts = new Map(
        (
          await db.query<{ role_key: string; n: number }>(
            `SELECT r.role_key, count(DISTINCT r.user_id)::int AS n FROM user_roles r JOIN users u ON u.id=r.user_id
        WHERE r.tenant_id=$1 AND u.status='active' GROUP BY r.role_key`,
            [a.tenantId],
          )
        ).rows.map((r) => [r.role_key, r.n]),
      );
      const visible = (perms: readonly string[]) => perms.filter((p) => !allOff(permissionFeature(p)));
      return {
        system: SYSTEM_ROLES.map((r) => ({
          key: r.key,
          name: r.name,
          group: roleGroup(r.key),
          permissions: visible(r.key === 'owner' ? SYSTEM_ROLE_MAP.get('tenant_admin')!.permissions : r.permissions),
          grantable: grantable(r.key, r.permissions),
          users: counts.get(r.key) ?? 0,
        })),
        custom: (
          await db.query<{ key: string; name: string; permissions: string[] }>(
            `SELECT t.key, t.name, t.description, t.permissions, t.updated_at, u.display_name AS updated_by_name
            FROM tenant_roles t LEFT JOIN users u ON u.id=coalesce(t.updated_by, t.created_by) WHERE t.tenant_id=$1 ORDER BY t.name`,
            [a.tenantId],
          )
        ).rows.map((r) => ({ ...r, permissions: visible(r.permissions), grantable: grantable(r.key, r.permissions), users: counts.get(r.key) ?? 0 })),
        permissions: Object.entries(PERMISSIONS)
          .filter(([key]) => !allOff(permissionFeature(key)))
          .map(([key, label]) => ({ key, label })),
        // Whether this user may create and edit roles, and with which permissions (an administrator: any).
        canManage: a.has('users.manage'),
        maxPermissions: isAdministrator(a) ? null : [...a.user.permissions].filter((p) => p in PERMISSIONS),
      };
    });
  });

  // ------------------------------------------------------------ the organization's own roles
  // Anyone with users.manage may define roles, but only from permissions they hold themselves (an administrator: any),
  // the same limit as granting roles. Changing a role's permissions signs its holders out so it applies at once.
  const RoleBody = z.object({
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(300).optional().nullable(),
    permissions: z
      .array(z.string())
      .min(1)
      .max(Object.keys(PERMISSIONS).length)
      .transform((p) => [...new Set(p)].sort()),
  });
  const checkPermissions = (a: { user: { roles: string[]; permissions: Set<string> } }, perms: string[], verb: string) => {
    const unknown = perms.filter((p) => !(p in PERMISSIONS));
    if (unknown.length) throw badRequest(`Unknown permission: ${unknown.join(', ')}`);
    const beyond = isAdministrator(a) ? [] : perms.filter((p) => !a.user.permissions.has(p));
    if (beyond.length)
      throw forbidden(
        `Only an administrator can ${verb} a role with permissions you do not have yourself: ${beyond.map((p) => PERMISSIONS[p as keyof typeof PERMISSIONS]).join('; ')}`,
      );
    // A module that is off has no permissions: a role holding one now would quietly grant it the day the flag comes on.
    const switchedOff = perms.filter((p) => {
      const f = permissionFeature(p);
      return !!f && allOff(f);
    });
    if (switchedOff.length) throw badRequest(`Unknown permission: ${switchedOff.join(', ')}`);
  };
  const checkName = async (db: import('../../db/tx.js').Db, tenantId: string, name: string, exceptKey?: string) => {
    if (SYSTEM_ROLES.some((r) => r.name.toLowerCase() === name.toLowerCase())) throw conflict(`"${name}" is the name of a built-in role; choose another`);
    const dup = await db.query('SELECT 1 FROM tenant_roles WHERE tenant_id=$1 AND lower(name)=lower($2) AND key IS DISTINCT FROM $3', [tenantId, name, exceptKey ?? null]);
    if (dup.rowCount) throw conflict(`A role named "${name}" already exists`);
  };

  app.post('/roles', { schema: { response: { 201: R.PostTenantRoles201 }, body: RoleBody }, config: { perm: ['users.manage'] } }, async (req, reply) => {
    noRoleScreens();
    const a = tenantActor(req, 'users.manage');
    const b = RoleBody.parse(req.body);
    checkPermissions(a, b.permissions, 'create');
    const out = await a.tx(async (db) => {
      await checkName(db, a.tenantId, b.name);
      const base = `custom:${
        b.name
          .toLowerCase()
          .normalize('NFKD')
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 40) || 'role'
      }`;
      let key = base;
      for (let i = 2; (await db.query('SELECT 1 FROM tenant_roles WHERE tenant_id=$1 AND key=$2', [a.tenantId, key])).rowCount; i++) key = `${base}_${i}`;
      await db.query(`INSERT INTO tenant_roles (tenant_id, key, name, description, permissions, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$6)`, [
        a.tenantId,
        key,
        b.name,
        b.description || null,
        b.permissions,
        a.user.userId,
      ]);
      await audit(db, { ...a.auditBase, action: 'role.created', category: 'security', targetType: 'role', targetId: key, metadata: { name: b.name, permissions: b.permissions } });
      return { key };
    });
    reply.code(201);
    return out;
  });

  const RolesBody = RoleBody.partial();
  app.patch('/roles/:key', { schema: { response: { 200: R.PatchTenantRolesByKey200 }, params: RolesParams, body: RolesBody }, config: { perm: ['users.manage'] } }, async (req) => {
    noRoleScreens();
    const a = tenantActor(req, 'users.manage');
    const { key } = RolesParams.parse(req.params);
    const b = RolesBody.parse(req.body);
    return a.tx(async (db) => {
      const cur = (
        await db.query<{ name: string; description: string | null; permissions: string[] }>(
          'SELECT name, description, permissions FROM tenant_roles WHERE tenant_id=$1 AND key=$2 FOR UPDATE',
          [a.tenantId, key],
        )
      ).rows[0];
      if (!cur) throw notFound('Role not found');
      checkPermissions(a, cur.permissions, 'change'); // someone who couldn't grant the role can't edit it
      if (b.permissions) checkPermissions(a, b.permissions, 'change');
      if (b.name && b.name !== cur.name) await checkName(db, a.tenantId, b.name, key);
      const added = b.permissions ? b.permissions.filter((p) => !cur.permissions.includes(p)) : [];
      const removed = b.permissions ? cur.permissions.filter((p) => !b.permissions!.includes(p)) : [];
      await db.query(
        `UPDATE tenant_roles SET name=coalesce($3,name), description=CASE WHEN $4::boolean THEN $5 ELSE description END, permissions=coalesce($6,permissions),
          updated_by=$7, updated_at=now() WHERE tenant_id=$1 AND key=$2`,
        [a.tenantId, key, b.name ?? null, b.description !== undefined, b.description || null, b.permissions ?? null, a.user.userId],
      );
      let signedOut = 0;
      if (added.length || removed.length) {
        const holders = (await db.query<{ user_id: string }>('SELECT DISTINCT user_id FROM user_roles WHERE tenant_id=$1 AND role_key=$2', [a.tenantId, key])).rows;
        for (const h of holders) await revokeAllSessionsForUser(db, h.user_id);
        signedOut = holders.length;
      }
      await audit(db, {
        ...a.auditBase,
        action: 'role.updated',
        category: 'security',
        targetType: 'role',
        targetId: key,
        metadata: { name: b.name && b.name !== cur.name ? { from: cur.name, to: b.name } : undefined, added, removed, holdersSignedOut: signedOut },
      });
      return { ok: true, holdersSignedOut: signedOut };
    });
  });

  app.delete('/roles/:key', { schema: { response: { 200: R.DeleteTenantRolesByKey200 }, params: DeleteRolesParams }, config: { perm: ['users.manage'] } }, async (req) => {
    noRoleScreens();
    const a = tenantActor(req, 'users.manage');
    const { key } = DeleteRolesParams.parse(req.params);
    return a.tx(async (db) => {
      const cur = (
        await db.query<{ name: string; permissions: string[] }>('SELECT name, permissions FROM tenant_roles WHERE tenant_id=$1 AND key=$2 FOR UPDATE', [a.tenantId, key])
      ).rows[0];
      if (!cur) throw notFound('Role not found');
      checkPermissions(a, cur.permissions, 'delete');
      const n = Number((await db.query<{ n: string }>('SELECT count(DISTINCT user_id) AS n FROM user_roles WHERE tenant_id=$1 AND role_key=$2', [a.tenantId, key])).rows[0]!.n);
      if (n) throw conflict(`${n} ${n === 1 ? 'person has' : 'people have'} this role; remove it from them first`);
      await db.query('DELETE FROM tenant_roles WHERE tenant_id=$1 AND key=$2', [a.tenantId, key]);
      await audit(db, {
        ...a.auditBase,
        action: 'role.deleted',
        category: 'security',
        targetType: 'role',
        targetId: key,
        metadata: { name: cur.name, permissions: cur.permissions },
      });
      return { ok: true };
    });
  });

  app.get('/users', { schema: { response: { 200: R.GetTenantUsers200 }, querystring: UsersQuery }, config: { perm: ['users.manage'] } }, async (req) => {
    const a = tenantActor(req, 'users.manage');
    const q = UsersQuery.parse(req.query);
    return a.tx(async (db) => {
      const where = `u.tenant_id=$1 AND ($2::text IS NULL OR u.email ILIKE '%'||$2||'%' OR u.display_name ILIKE '%'||$2||'%')`;
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM users u WHERE ${where}`, [a.tenantId, q.search ?? null])).rows[0]!.n);
      const rows = await db.query<{ salary_access_level: number; roles: string[] } & Record<string, unknown>>(
        `SELECT u.id, u.email, u.display_name, u.status, u.salary_access_level, u.last_login_at, u.password_hash IS NULL AS invite_pending, EXISTS (SELECT 1 FROM auth_throttle th WHERE th.tenant_id=u.tenant_id AND th.subject_hash=encode(sha256(convert_to(u.tenant_id::text||'|'||u.email,'UTF8')),'hex') AND th.blocked_until > now()) AS locked, u.mfa_enabled_at IS NOT NULL AS mfa_enabled,
          coalesce(array_agg(r.role_key ORDER BY r.role_key) FILTER (WHERE r.role_key IS NOT NULL), '{}') AS roles,
          e.id AS employee_id, e.employee_code
        FROM users u LEFT JOIN user_roles r ON r.user_id=u.id AND r.tenant_id=u.tenant_id
        LEFT JOIN employees e ON e.tenant_id=u.tenant_id AND e.user_id=u.id
        WHERE ${where} GROUP BY u.id, e.id ORDER BY u.display_name LIMIT $3 OFFSET $4`,
        [a.tenantId, q.search ?? null, q.pageSize, offsetOf(q)],
      );
      return paged(
        rows.rows.map((r) => ({ ...r, effective_salary_level: effectiveLevel(r.salary_access_level, r.roles) })),
        total,
        q,
      );
    });
  });

  const RoleKeys = z.array(z.string()).min(1).max(10);
  const assertTenantRoles = async (db: import('../../db/tx.js').Db, tenantId: string, roles: string[]) => {
    for (const k of roles) {
      const sys = SYSTEM_ROLE_MAP.get(k);
      if (sys) continue;
      const c = await db.query('SELECT 1 FROM tenant_roles WHERE tenant_id=$1 AND key=$2', [tenantId, k]);
      if (!c.rowCount) throw badRequest(`Unknown role '${k}'`);
    }
  };

  /** Every permission the given role keys carry (system roles and this organization's custom roles). */
  const rolePermissions = async (db: import('../../db/tx.js').Db, tenantId: string, roles: string[]) => {
    const out = new Set<string>();
    for (const k of roles) SYSTEM_ROLE_MAP.get(k)?.permissions.forEach((p) => out.add(p));
    const custom = roles.filter((k) => !SYSTEM_ROLE_MAP.has(k));
    if (custom.length)
      (await db.query<{ permissions: string[] }>('SELECT permissions FROM tenant_roles WHERE tenant_id=$1 AND key = ANY($2)', [tenantId, custom])).rows.forEach((r) =>
        r.permissions.forEach((p) => out.add(p)),
      );
    return out;
  };
  /**
   * No escalation through user management: only an Administrator may grant any role. Anyone else with users.manage
   * (e.g. the IT administrator) may grant or remove only roles whose permissions they hold themselves, and may not
   * change an account that holds permissions they lack.
   */
  const isAdministrator = (a: { user: { roles: string[] } }) => a.user.roles.some(isOwnerRole);
  /**
   * What the mode and the salary hierarchy allow, whoever is asking. A role change counts as setting a level: one that raises someone's
   * effective level to the actor's own or above is refused, for everyone. Effective, not floor: changing roles can also lift a ceiling off
   * a high stored level, and a removal can do that too. Only the bootstrap command works outside this (D40).
   */
  const assertRolesAllowed = async (
    db: import('../../db/tx.js').Db,
    a: { tenantId: string; user: { userId: string; roles: string[]; salaryLevel: number } },
    targetId: string | null,
    roles: string[],
    prev: string[],
  ) => {
    const mode = currentMode();
    if (mode !== 'multi') {
      const allowed = assignableRoles(mode);
      const off = roles.filter((r) => !allowed.includes(r));
      if (off.length) throw badRequest(`These roles do not exist in ${mode} mode: ${off.join(', ')}`);
    }
    const added = roles.filter((r) => !prev.includes(r));
    if (mode === 'single' && added.some(isOwnerRole)) {
      const other = await db.query(
        `SELECT 1 FROM user_roles r JOIN users u ON u.id=r.user_id WHERE r.tenant_id=$1 AND r.role_key = ANY($2) AND u.status='active' AND r.user_id IS DISTINCT FROM $3 LIMIT 1`,
        [a.tenantId, OWNER_ROLE_KEYS, targetId],
      );
      if (other.rowCount) throw conflict('A single-person organization has one owner');
    }
    const stored = targetId
      ? ((await db.query<{ l: number }>('SELECT salary_access_level AS l FROM users WHERE tenant_id=$1 AND id=$2', [a.tenantId, targetId])).rows[0]?.l ?? 0)
      : 0;
    const before = targetId ? effectiveLevel(stored, prev) : 0;
    const after = effectiveLevel(stored, roles);
    if (after > before && after >= a.user.salaryLevel) throw forbidden('You cannot give anyone a salary level equal to or above your own, through a role or otherwise');
  };
  /** The one above: nobody changes the roles or status of someone at or above them, or clears their second factor. */
  const assertBelowActor = async (db: import('../../db/tx.js').Db, a: { tenantId: string; user: { userId: string; salaryLevel: number } }, targetId: string, roles: string[]) => {
    if (targetId === a.user.userId) return;
    const stored = (await db.query<{ l: number }>('SELECT salary_access_level AS l FROM users WHERE tenant_id=$1 AND id=$2', [a.tenantId, targetId])).rows[0]?.l ?? 0;
    if (effectiveLevel(stored, roles) >= a.user.salaryLevel) throw forbidden('You cannot change an account at or above your own salary level');
  };
  const assertMayGrant = async (db: import('../../db/tx.js').Db, a: { tenantId: string; user: { roles: string[]; permissions: Set<string> } }, roles: string[]) => {
    if (isAdministrator(a) || !roles.length) return;
    const beyond = [...(await rolePermissions(db, a.tenantId, roles))].filter((p) => !a.user.permissions.has(p));
    if (roles.includes('tenant_admin') || beyond.length) throw forbidden('Only an administrator can grant or remove roles with permissions you do not have yourself');
  };
  const assertMayManage = async (db: import('../../db/tx.js').Db, a: { tenantId: string; user: { roles: string[]; permissions: Set<string> } }, targetRoles: string[]) => {
    if (isAdministrator(a)) return;
    const beyond = [...(await rolePermissions(db, a.tenantId, targetRoles))].filter((p) => !a.user.permissions.has(p));
    if (targetRoles.includes('tenant_admin') || beyond.length) throw forbidden('Only an administrator can change this account');
  };

  const UsersBody = z.object({
    email: z.string().trim().toLowerCase().pipe(z.email()),
    displayName: z.string().trim().min(2).max(120),
    roles: RoleKeys,
    employeeId: Uuid.optional(),
  });
  /** A person gets an invitation by email and chooses their own password. Nobody else ever knows it. Without mail: `bootstrap --issue-link` prints one for the operator. */
  app.post('/users', { schema: { response: { 201: R.PostTenantUsers201 }, body: UsersBody }, config: { perm: ['users.manage'] } }, async (req, reply) => {
    const a = tenantActor(req, 'users.manage');
    if (req.body && typeof req.body === 'object' && 'initialPassword' in req.body)
      throw badRequest('Initial passwords are gone: people choose their own from an invitation sent by email. Leave this out.');
    const body = UsersBody.parse(req.body);
    return a.tx(async (db) => {
      await assertTenantRoles(db, a.tenantId, body.roles);
      await assertMayGrant(db, a, body.roles);
      await assertRolesAllowed(db, a, null, body.roles, []);
      const u = await db.query<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,$3,NULL) RETURNING id`, [
        a.tenantId,
        body.email,
        body.displayName,
      ]);
      const userId = u.rows[0]!.id;
      for (const role of body.roles)
        await db.query(`INSERT INTO user_roles (user_id, tenant_id, role_key, granted_by) VALUES ($1,$2,$3,$4)`, [userId, a.tenantId, role, a.user.userId]);
      if (body.employeeId) {
        // A login on a record reads that record as its own, pay and bank included. So it goes to the address the record already has, or someone with the standing to see the person says so.
        const rec = (await db.query<{ work_email: string | null }>('SELECT work_email FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, body.employeeId])).rows[0];
        const sameAddress = !!rec?.work_email && rec.work_email.toLowerCase() === body.email.toLowerCase();
        const mayVouch = (a.has('employees.manage') || a.user.roles.some(isOwnerRole)) && (await outranks(db, a.tenantId, { level: a.user.salaryLevel }, body.employeeId));
        if (rec && !sameAddress && !mayVouch) throw forbidden("This address is not the one on the person's record. Update the record, or ask HR to create this login");
        const e = await db.query(`UPDATE employees SET user_id=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2 AND user_id IS NULL`, [a.tenantId, body.employeeId, userId]);
        if (!e.rowCount) throw conflict('Employee not found or already linked to a user');
      }
      const invite = await emailLink(db, a.tenantId, userId, 'invite');
      await audit(db, {
        ...a.auditBase,
        action: 'user.created',
        category: 'security',
        targetType: 'user',
        targetId: userId,
        metadata: { email: body.email, roles: body.roles, employeeId: body.employeeId, invite },
      });
      reply.code(201);
      return { id: userId, inviteSent: invite === 'sent' };
    });
  });

  /** Sends a link to someone: a fresh invitation to a person who has not accepted one, or a reset to anyone else below the sender. */
  const sendLink = (purpose: 'invite' | 'reset') => async (req: FastifyRequest) => {
    const a = tenantActor(req, 'users.manage');
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      const u = (
        await db.query<{ status: string; accepted: boolean }>('SELECT status, password_hash IS NOT NULL AS accepted FROM users WHERE tenant_id=$1 AND id=$2', [a.tenantId, id])
      ).rows[0];
      if (!u) throw notFound('User not found');
      if (u.status !== 'active') throw conflict('This account is disabled');
      if (purpose === 'invite' && u.accepted) throw conflict('This person has already accepted their invitation. Send a password reset instead.');
      const roles = (await db.query<{ role_key: string }>('SELECT role_key FROM user_roles WHERE tenant_id=$1 AND user_id=$2', [a.tenantId, id])).rows.map((r) => r.role_key);
      await assertMayManage(db, a, roles);
      await assertBelowActor(db, a, id, roles);
      const result = await emailLink(db, a.tenantId, id, purpose);
      if (result === 'unavailable') throw new AppError(409, 'feature_not_configured', 'Email is not set up on this installation.');
      if (result === 'limited') throw new AppError(429, 'rate_limited', 'Too many links sent to this person. Try again later.');
      await audit(db, { ...a.auditBase, action: `user.${purpose}_sent`, category: 'security', targetType: 'user', targetId: id });
      return { ok: true };
    });
  };
  app.post(
    '/users/:id/invite',
    { schema: { response: { 200: R.PostTenantUsersByIdInvite200 }, params: IdParams }, config: { perm: ['users.manage'], rateLimit: { max: 10, timeWindow: '1 minute' } } },
    sendLink('invite'),
  );
  app.post(
    '/users/:id/password-reset',
    { schema: { response: { 200: R.PostTenantUsersByIdPasswordReset200 }, params: IdParams }, config: { perm: ['users.manage'], rateLimit: { max: 10, timeWindow: '1 minute' } } },
    sendLink('reset'),
  );

  const PatchUsersBody = z.object({
    status: z.enum(['active', 'disabled']).optional(),
    roles: RoleKeys.optional(),
    unlock: z.boolean().optional(),
    resetMfa: z.boolean().optional(),
  });
  app.patch('/users/:id', { schema: { response: { 200: R.PatchTenantUsersById200 }, params: IdParams, body: PatchUsersBody }, config: { perm: ['users.manage'] } }, async (req) => {
    const a = tenantActor(req, 'users.manage');
    const { id } = IdParams.parse(req.params);
    const body = PatchUsersBody.parse(req.body);
    return a.tx(async (db) => {
      const u = await db.query<{ status: string; email: string }>('SELECT status, email FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id]);
      if (!u.rowCount) throw notFound('User not found');
      const prevRoles = (await db.query<{ role_key: string }>('SELECT role_key FROM user_roles WHERE tenant_id=$1 AND user_id=$2', [a.tenantId, id])).rows.map((r) => r.role_key);
      if (id === a.user.userId && (body.status === 'disabled' || (body.roles && !body.roles.some(isOwnerRole) && prevRoles.some(isOwnerRole)))) {
        throw conflict('You cannot disable yourself or remove your own administrator role');
      }
      await assertMayManage(db, a, prevRoles);
      if (body.roles || body.status || body.resetMfa || body.unlock) await assertBelowActor(db, a, id, prevRoles);
      // Someone must stay above everyone: nobody could appoint an administrator or produce a whole bank file otherwise. Recovery is the bootstrap command.
      const losesOwner = prevRoles.includes('owner') && u.rows[0]!.status === 'active' && (body.status === 'disabled' || (!!body.roles && !body.roles.includes('owner')));
      if (losesOwner && !(await anotherActiveOwner(db, a.tenantId, id))) throw conflict('This is the last active owner. Appoint another through the bootstrap command first.');
      if (body.roles) {
        await assertTenantRoles(db, a.tenantId, body.roles);
        await assertRolesAllowed(db, a, id, body.roles, prevRoles);
        const changed = [...body.roles.filter((r) => !prevRoles.includes(r)), ...prevRoles.filter((r) => !body.roles!.includes(r))];
        await assertMayGrant(db, a, changed);
        await db.query('DELETE FROM user_roles WHERE tenant_id=$1 AND user_id=$2', [a.tenantId, id]);
        for (const role of body.roles)
          await db.query(`INSERT INTO user_roles (user_id, tenant_id, role_key, granted_by) VALUES ($1,$2,$3,$4)`, [id, a.tenantId, role, a.user.userId]);
        const admins = await db.query<{ n: string }>(
          `SELECT count(DISTINCT r.user_id) AS n FROM user_roles r JOIN users u ON u.id=r.user_id
          WHERE r.tenant_id=$1 AND r.role_key = ANY($2) AND u.status='active'`,
          [a.tenantId, OWNER_ROLE_KEYS],
        );
        if (Number(admins.rows[0]!.n) === 0) throw conflict('At least one active Tenant Administrator is required');
      }
      if (body.status) await db.query('UPDATE users SET status=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2', [a.tenantId, id, body.status]);
      if (body.unlock) await clearLoginAccount(db, a.tenantId, u.rows[0]!.email);
      if (body.resetMfa) {
        if (id === a.user.userId) throw conflict('You cannot reset your own two-factor authentication here');
        // MFA_AVAILABLE=false keeps what people enrolled in, to come back if it is turned on again.
        if (!app.deps.env.MFA_AVAILABLE) throw conflict('Two-factor authentication is off on this installation');
        await db.query(
          `UPDATE users SET mfa_secret_enc=NULL, mfa_pending_secret_enc=NULL, mfa_enabled_at=NULL, mfa_method=NULL, mfa_recovery_hashes='{}', mfa_last_step=NULL, mfa_failures=0, mfa_locked_until=NULL
          WHERE tenant_id=$1 AND id=$2`,
          [a.tenantId, id],
        );
        await notifyUsers(db, a.tenantId, [id], {
          kind: 'security.mfa_disabled',
          title: 'Two-factor authentication was turned off',
          body: 'An administrator reset it for your account. If you did not ask for this, contact them immediately.',
          link: '/account',
        });
      }
      if (body.status === 'disabled') await reassignStepsOf(db, a.tenantId, id);
      // Role or status changes take effect immediately: existing sessions are revoked.
      if (body.status === 'disabled' || body.roles || body.resetMfa) await revokeAllSessionsForUser(db, id);
      await audit(db, {
        ...a.auditBase,
        action: 'user.updated',
        category: 'security',
        targetType: 'user',
        targetId: id,
        metadata: {
          status: body.status ? { from: u.rows[0]!.status, to: body.status } : undefined,
          roles: body.roles ? { from: prevRoles, to: body.roles } : undefined,
          unlock: body.unlock,
          resetMfa: body.resetMfa,
        },
      });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ salary hierarchy
  /**
   * A user's stored salary level. Nobody changes their own, sets someone's to their own level or above, or edits someone at or
   * above them. The effective level can still end higher: it never falls below the floor of the person's roles.
   */
  app.put(
    '/users/:id/salary-level',
    { schema: { response: { 200: R.PutTenantUsersByIdSalaryLevel200 }, params: IdParams, body: UsersSalaryLevelBody }, config: { perm: ['users.manage'] } },
    async (req) => {
      const a = tenantActor(req, 'users.manage');
      const { id } = IdParams.parse(req.params);
      const { level } = UsersSalaryLevelBody.parse(req.body);
      if (id === a.user.userId) throw forbidden('You cannot change your own salary level');
      return a.tx(async (db) => {
        const u = (await db.query<{ salary_access_level: number }>('SELECT salary_access_level FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id])).rows[0];
        if (!u) throw notFound('User not found');
        const roles = (await db.query<{ role_key: string }>('SELECT role_key FROM user_roles WHERE tenant_id=$1 AND user_id=$2', [a.tenantId, id])).rows.map((r) => r.role_key);
        await assertMayManage(db, a, roles);
        const before = effectiveLevel(u.salary_access_level, roles);
        if (before >= a.user.salaryLevel) throw forbidden('You cannot change the salary level of someone at or above your own');
        if (level >= a.user.salaryLevel) throw forbidden('You can only set a salary level below your own');
        await db.query('UPDATE users SET salary_access_level=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2', [a.tenantId, id, level]);
        const after = effectiveLevel(level, roles);
        // What this person can read has changed: they sign in again, like after a role change.
        await revokeAllSessionsForUser(db, id);
        await audit(db, {
          ...a.auditBase,
          action: 'user.salary_level_changed',
          category: 'security',
          targetType: 'user',
          targetId: id,
          metadata: { from: u.salary_access_level, to: level, effectiveFrom: before, effectiveTo: after },
        });
        return { ok: true, level, effectiveLevel: after };
      });
    },
  );

  // ------------------------------------------------------------ audit history
  app.get('/audit', { schema: { response: { 200: R.GetTenantAudit200 }, querystring: AuditQuery }, config: { perm: ['audit.read'] } }, async (req) => {
    const a = tenantActor(req, 'audit.read');
    const q = AuditQuery.parse(req.query);
    return a.tx(async (db) => {
      const params = [a.tenantId, q.category ?? null, q.targetType ?? null, q.targetId ?? null, q.action ?? null];
      const where = `l.tenant_id=$1 AND ($2::text IS NULL OR l.category=$2) AND ($3::text IS NULL OR l.target_type=$3)
        AND ($4::text IS NULL OR l.target_id=$4) AND ($5::text IS NULL OR l.action LIKE $5||'%')`;
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM audit_logs l WHERE ${where}`, params)).rows[0]!.n);
      const rows = await db.query(
        `SELECT l.id, l.action, l.category, l.target_type, l.target_id, l.setting_key, l.change_metadata, l.created_at, l.ip,
          l.actor_type, coalesce(u.display_name, CASE WHEN l.actor_type='platform' THEN 'Platform operator' END) AS actor_name
        FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_id AND u.tenant_id=l.tenant_id
        WHERE ${where} ORDER BY l.created_at DESC, l.id DESC LIMIT $6 OFFSET $7`,
        [...params, q.pageSize, offsetOf(q)],
      );
      // Old rows were cleaned when this was introduced; this keeps it so for anything restored from before that.
      return paged(
        rows.rows.map((r) => ({ ...r, change_metadata: redact(r.change_metadata) })),
        total,
        q,
      );
    });
  });

  /** The hash chain itself, and whether it holds. Only the top of the organization: an audit reader does not audit the log. */
  const chainActor = (req: Parameters<typeof tenantActor>[0]) => {
    const a = tenantActor(req);
    if (!isOwnerOrSuperAdmin(a)) throw forbidden();
    return a;
  };
  app.get('/audit/chain', { schema: { response: { 200: R.GetTenantAuditChain200 }, querystring: PageQuery } }, async (req) => {
    const a = chainActor(req);
    const q = PageQuery.parse(req.query);
    return a.tx(async (db) => {
      const total = Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM audit_logs WHERE tenant_id=$1', [a.tenantId])).rows[0]!.n);
      const rows = await db.query(
        `SELECT chain_seq, id, action, category, actor_id, actor_type, target_type, target_id, change_metadata, ip, user_agent, created_at, prev_hash, row_hash
        FROM audit_logs WHERE tenant_id=$1 ORDER BY chain_seq DESC LIMIT $2 OFFSET $3`,
        [a.tenantId, q.pageSize, offsetOf(q)],
      );
      return paged(
        rows.rows.map((r) => ({ ...r, change_metadata: redact(r.change_metadata) })),
        total,
        q,
      );
    });
  });
  app.get('/audit/chain/verify', { schema: { response: { 200: R.GetTenantAuditChainVerify200 } } }, async (req) => {
    const a = chainActor(req);
    return a.tx(async (db) => {
      const r = (await db.query<{ ok: boolean; checked: string; broken_seq: string | null; reason: string | null }>('SELECT * FROM audit_chain_verify($1)', [a.tenantId])).rows[0]!;
      await audit(db, { ...a.auditBase, action: 'audit.chain_verified', category: 'security', metadata: { ok: r.ok, checked: Number(r.checked) } });
      return { ok: r.ok, checked: Number(r.checked), brokenAt: r.broken_seq === null ? null : Number(r.broken_seq), reason: r.reason };
    });
  });
}
