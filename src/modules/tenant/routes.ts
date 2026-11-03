import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantActor, tenantActorAny, requireFeature } from '../../core/http/context.js';
import { JOBS, JOB_MAP, nextRun } from '../../core/jobs/registry.js';
import { runNow, localNow, MAX_ATTEMPTS } from '../../core/jobs/scheduler.js';
import { SETTINGS } from '../../core/settings/registry.js';
import { resolveSetting, writeSetting, clearSetting } from '../../core/settings/service.js';
import { evaluateFeatures } from '../../core/features/state.js';
import { FEATURE_MAP, dependentsOf } from '../../core/features/registry.js';
import { audit } from '../../core/audit/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { PageQuery, offsetOf, paged, Uuid } from '../../core/http/pagination.js';
import type { PublicConfig } from '../../config/installation.js';
import { SYSTEM_ROLES, SYSTEM_ROLE_MAP, PERMISSIONS } from '../../core/auth/permissions.js';
import { hashPassword } from '../../core/crypto/index.js';
import { getSettingValue } from '../../core/settings/service.js';
import { revokeAllSessionsForUser } from '../../core/auth/session.js';

export async function tenantAdminRoutes(app: FastifyInstance, opts: { publicConfig: PublicConfig }) {

  // ------------------------------------------------------------ settings
  app.get('/settings', async (req) => {
    const a = tenantActor(req, 'settings.read');
    const q = z.object({ branchId: Uuid.optional() }).parse(req.query);
    return a.tx(async (db) => {
      const features = await evaluateFeatures(db, a.tenantId);
      const items = [];
      for (const d of SETTINGS) {
        const eff = await resolveSetting(db, a.tenantId, d.key, q.branchId);
        items.push({
          key: d.key, group: d.group, label: d.label, description: d.description, control: d.control, options: d.options ?? null,
          scopes: d.scopes, feature: d.feature ?? null, featureEnabled: d.feature ? features.get(d.feature)?.enabled ?? false : true,
          editable: a.has(d.editPermission), editPermission: d.editPermission,
          effective: eff.value, source: eff.source, defaultValue: eff.defaultValue, platformValue: eff.platformValue ?? null,
          tenantValue: eff.tenantValue ?? null, branchValue: eff.branchValue ?? null, version: eff.version ?? null,
        });
      }
      return { items };
    });
  });

  const SettingWriteBody = z.object({ value: z.unknown(), scope: z.enum(['tenant', 'branch']).default('tenant'), branchId: Uuid.optional(), expectedVersion: z.number().int().optional() });

  app.put('/settings/:key', async (req) => {
    const { key } = z.object({ key: z.string() }).parse(req.params);
    const def = SETTINGS.find((s) => s.key === key);
    if (!def) throw notFound('Unknown setting');
    const a = tenantActor(req, def.editPermission);
    const body = SettingWriteBody.parse(req.body);
    return a.tx(async (db) => {
      const res = await writeSetting(db, a.tenantId, { key, value: body.value, scope: body.scope, branchId: body.branchId, expectedVersion: body.expectedVersion }, a.user.userId);
      await audit(db, { ...a.auditBase, action: 'settings.updated', category: 'configuration', settingKey: key, targetType: body.scope, targetId: body.branchId,
        metadata: { from: res.previous ?? null, to: res.value } });
      return { key, value: res.value };
    });
  });

  app.delete('/settings/:key', async (req) => {
    const { key } = z.object({ key: z.string() }).parse(req.params);
    const def = SETTINGS.find((s) => s.key === key);
    if (!def) throw notFound('Unknown setting');
    const a = tenantActor(req, def.editPermission);
    const q = z.object({ scope: z.enum(['tenant', 'branch']).default('tenant'), branchId: Uuid.optional() }).parse(req.query);
    return a.tx(async (db) => {
      const prev = await clearSetting(db, a.tenantId, key, q.scope, q.branchId);
      if (prev !== undefined) {
        await audit(db, { ...a.auditBase, action: 'settings.reset_to_inherited', category: 'configuration', settingKey: key, targetType: q.scope, targetId: q.branchId, metadata: { from: prev } });
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
  app.get('/installation', async (req) => {
    const a = tenantActor(req, 'settings.read');
    return a.tx(async (db) => {
      const states = await evaluateFeatures(db, a.tenantId);
      const domains = (await db.query(`SELECT hostname, activation_status, is_primary FROM tenant_domains WHERE tenant_id=$1 ORDER BY is_primary DESC, hostname`, [a.tenantId])).rows;
      return {
        ...opts.publicConfig,
        domains,
        modules: [...states.values()].map((s) => ({ ...s, availability: FEATURE_MAP.get(s.key)!.availability, dependents: dependentsOf(s.key).map((d) => d.key) })),
        managedBy: 'deployment',
      };
    });
  });

  // ------------------------------------------------------------ scheduled jobs
  app.get('/jobs', async (req) => {
    const a = tenantActor(req, 'settings.read');
    return a.tx(async (db) => {
      const states = await evaluateFeatures(db, a.tenantId);
      const tz = await getSettingValue<string>(db, a.tenantId, 'general.timezone');
      const { date, time } = localNow(tz, new Date());
      const runs = (await db.query(`SELECT r.id, r.job_key, r.period_key, r.trigger, r.status, r.attempts, r.started_at, r.finished_at, r.next_retry_at, r.result, r.error,
          u.display_name AS triggered_by_name FROM job_runs r LEFT JOIN users u ON u.id=r.triggered_by
        WHERE r.tenant_id=$1 ORDER BY r.started_at DESC LIMIT 100`, [a.tenantId])).rows;
      return {
        timezone: tz, maxAttempts: MAX_ATTEMPTS,
        items: JOBS.map((j) => ({
          key: j.key, name: j.name, description: j.description, schedule: j.schedule, feature: j.feature ?? null,
          active: !j.feature || !!states.get(j.feature)?.usable, nextRun: nextRun(j.schedule, date, time),
          canRun: a.has(j.runPermission), recentRuns: runs.filter((r) => r.job_key === j.key).slice(0, 10),
        })),
      };
    });
  });

  app.post('/jobs/:key/run', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { key } = z.object({ key: z.string() }).parse(req.params);
    const job = JOB_MAP.get(key);
    if (!job) throw notFound('Unknown job');
    const a = tenantActor(req, job.runPermission);
    if (job.feature) await a.tx((db) => requireFeature(db, a.tenantId, job.feature!));
    await a.tx((db) => audit(db, { ...a.auditBase, action: 'job.run_requested', category: 'data', targetType: 'job', targetId: key }));
    return runNow(app.deps.pool, req.log, a.tenantId, key, a.user.userId);
  });

  // ------------------------------------------------------------ users & roles
  app.get('/roles', async (req) => {
    const a = tenantActorAny(req, 'users.manage', 'settings.read');
    return a.tx(async (db) => ({
      system: SYSTEM_ROLES.map((r) => ({ key: r.key, name: r.name, permissions: r.permissions })),
      custom: (await db.query('SELECT key, name, permissions FROM tenant_roles WHERE tenant_id=$1 ORDER BY name', [a.tenantId])).rows,
      permissions: Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label })),
    }));
  });

  app.get('/users', async (req) => {
    const a = tenantActor(req, 'users.manage');
    const q = PageQuery.extend({ search: z.string().trim().max(100).optional() }).parse(req.query);
    return a.tx(async (db) => {
      const where = `u.tenant_id=$1 AND ($2::text IS NULL OR u.email ILIKE '%'||$2||'%' OR u.display_name ILIKE '%'||$2||'%')`;
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM users u WHERE ${where}`, [a.tenantId, q.search ?? null])).rows[0]!.n);
      const rows = await db.query(`SELECT u.id, u.email, u.display_name, u.status, u.last_login_at, u.locked_until > now() AS locked, u.mfa_enabled_at IS NOT NULL AS mfa_enabled,
          coalesce(array_agg(r.role_key ORDER BY r.role_key) FILTER (WHERE r.role_key IS NOT NULL), '{}') AS roles,
          e.id AS employee_id, e.employee_code
        FROM users u LEFT JOIN user_roles r ON r.user_id=u.id AND r.tenant_id=u.tenant_id
        LEFT JOIN employees e ON e.tenant_id=u.tenant_id AND e.user_id=u.id
        WHERE ${where} GROUP BY u.id, e.id ORDER BY u.display_name LIMIT $3 OFFSET $4`, [a.tenantId, q.search ?? null, q.pageSize, offsetOf(q)]);
      return paged(rows.rows, total, q);
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

  app.post('/users', async (req, reply) => {
    const a = tenantActor(req, 'users.manage');
    const body = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()), displayName: z.string().trim().min(2).max(120),
      initialPassword: z.string().min(1).max(256), roles: RoleKeys, employeeId: Uuid.optional() }).parse(req.body);
    return a.tx(async (db) => {
      const minLen = await getSettingValue<number>(db, a.tenantId, 'security.password_min_length');
      if (body.initialPassword.length < minLen) throw badRequest(`Password must be at least ${minLen} characters`);
      await assertTenantRoles(db, a.tenantId, body.roles);
      const u = await db.query<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
        [a.tenantId, body.email, body.displayName, await hashPassword(body.initialPassword)]);
      const userId = u.rows[0]!.id;
      for (const role of body.roles) await db.query(`INSERT INTO user_roles (user_id, tenant_id, role_key, granted_by) VALUES ($1,$2,$3,$4)`, [userId, a.tenantId, role, a.user.userId]);
      if (body.employeeId) {
        const e = await db.query(`UPDATE employees SET user_id=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2 AND user_id IS NULL`, [a.tenantId, body.employeeId, userId]);
        if (!e.rowCount) throw conflict('Employee not found or already linked to a user');
      }
      await audit(db, { ...a.auditBase, action: 'user.created', category: 'security', targetType: 'user', targetId: userId,
        metadata: { email: body.email, roles: body.roles, employeeId: body.employeeId } });
      reply.code(201); return { id: userId };
    });
  });

  app.patch('/users/:id', async (req) => {
    const a = tenantActor(req, 'users.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const body = z.object({ status: z.enum(['active', 'disabled']).optional(), roles: RoleKeys.optional(), unlock: z.boolean().optional(), resetMfa: z.boolean().optional() }).parse(req.body);
    return a.tx(async (db) => {
      const u = await db.query<{ status: string }>('SELECT status FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id]);
      if (!u.rowCount) throw notFound('User not found');
      const prevRoles = (await db.query<{ role_key: string }>('SELECT role_key FROM user_roles WHERE tenant_id=$1 AND user_id=$2', [a.tenantId, id])).rows.map((r) => r.role_key);
      if (id === a.user.userId && (body.status === 'disabled' || (body.roles && !body.roles.includes('tenant_admin') && prevRoles.includes('tenant_admin')))) {
        throw conflict('You cannot disable yourself or remove your own administrator role');
      }
      if (body.roles) {
        await assertTenantRoles(db, a.tenantId, body.roles);
        await db.query('DELETE FROM user_roles WHERE tenant_id=$1 AND user_id=$2', [a.tenantId, id]);
        for (const role of body.roles) await db.query(`INSERT INTO user_roles (user_id, tenant_id, role_key, granted_by) VALUES ($1,$2,$3,$4)`, [id, a.tenantId, role, a.user.userId]);
        const admins = await db.query<{ n: string }>(`SELECT count(DISTINCT r.user_id) AS n FROM user_roles r JOIN users u ON u.id=r.user_id
          WHERE r.tenant_id=$1 AND r.role_key='tenant_admin' AND u.status='active'`, [a.tenantId]);
        if (Number(admins.rows[0]!.n) === 0) throw conflict('At least one active Tenant Administrator is required');
      }
      if (body.status) await db.query('UPDATE users SET status=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2', [a.tenantId, id, body.status]);
      if (body.unlock) await db.query('UPDATE users SET locked_until=NULL, failed_logins=0 WHERE tenant_id=$1 AND id=$2', [a.tenantId, id]);
      if (body.resetMfa) {
        if (id === a.user.userId) throw conflict('You cannot reset your own two-factor authentication here');
        await db.query(`UPDATE users SET mfa_secret_enc=NULL, mfa_pending_secret_enc=NULL, mfa_enabled_at=NULL, mfa_recovery_hashes='{}', mfa_last_step=NULL
          WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      }
      // Role or status changes take effect immediately: existing sessions are revoked.
      if (body.status === 'disabled' || body.roles || body.resetMfa) await revokeAllSessionsForUser(db, id);
      await audit(db, { ...a.auditBase, action: 'user.updated', category: 'security', targetType: 'user', targetId: id,
        metadata: { status: body.status ? { from: u.rows[0]!.status, to: body.status } : undefined, roles: body.roles ? { from: prevRoles, to: body.roles } : undefined, unlock: body.unlock, resetMfa: body.resetMfa } });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ audit history
  app.get('/audit', async (req) => {
    const a = tenantActor(req, 'audit.read');
    const q = PageQuery.extend({ category: z.enum(['auth', 'configuration', 'data', 'security', 'access']).optional(),
      targetType: z.string().max(50).optional(), targetId: z.string().max(100).optional(), action: z.string().max(80).optional() }).parse(req.query);
    return a.tx(async (db) => {
      const params = [a.tenantId, q.category ?? null, q.targetType ?? null, q.targetId ?? null, q.action ?? null];
      const where = `l.tenant_id=$1 AND ($2::text IS NULL OR l.category=$2) AND ($3::text IS NULL OR l.target_type=$3)
        AND ($4::text IS NULL OR l.target_id=$4) AND ($5::text IS NULL OR l.action LIKE $5||'%')`;
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM audit_logs l WHERE ${where}`, params)).rows[0]!.n);
      const rows = await db.query(`SELECT l.id, l.action, l.category, l.target_type, l.target_id, l.setting_key, l.change_metadata, l.created_at, l.ip,
          l.actor_type, coalesce(u.display_name, CASE WHEN l.actor_type='platform' THEN 'Platform operator' END) AS actor_name
        FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_id AND u.tenant_id=l.tenant_id
        WHERE ${where} ORDER BY l.created_at DESC, l.id DESC LIMIT $6 OFFSET $7`, [...params, q.pageSize, offsetOf(q)]);
      return paged(rows.rows, total, q);
    });
  });
}
