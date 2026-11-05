import type { Db } from '../../db/tx.js';
import { SETTINGS_MAP, type DeploymentLimits } from './registry.js';
import { badRequest } from '../http/errors.js';
import { cached, invalidate } from '../cache/index.js';

let limits: DeploymentLimits = { sessionTtlHours: 12 };
export function setDeploymentLimits(l: DeploymentLimits) { limits = l; }

/** Defaults supplied by deployment configuration (e.g. BRAND_TIMEZONE). Administrators may override them. */
let deploymentDefaults: Record<string, unknown> = {};
export function setDeploymentDefaults(d: Record<string, unknown>) { deploymentDefaults = d; }

export type SettingSource = 'default' | 'deployment' | 'platform' | 'tenant' | 'branch' | 'deployment_ceiling';

export interface EffectiveSetting {
  key: string;
  value: unknown;
  source: SettingSource;
  defaultValue: unknown;
  platformValue?: unknown;
  tenantValue?: unknown;
  branchValue?: unknown;
  version?: number;
}

/**
 * Resolve the effective value. The stored rows may come from the shared cache (core/cache), which a write invalidates when it
 * commits, so saved changes apply to the next request on every instance without restarts. Without Redis: the database.
 */
export async function resolveSetting(db: Db, tenantId: string, key: string, branchId?: string | null): Promise<EffectiveSetting> {
  const d = SETTINGS_MAP.get(key);
  if (!d) throw new Error(`Unknown setting ${key}`);
  const { platform, rows } = await cached(db, tenantId, 'settings', `${key}:${branchId ?? ''}`, async () => ({
    platform: (await db.query<{ setting_value: unknown }>('SELECT setting_value FROM platform_settings WHERE setting_key=$1', [key])).rows,
    rows: (await db.query<{ scope_type: string; scope_id: string | null; setting_value: unknown; version: number }>(
      `SELECT scope_type, scope_id, setting_value, version FROM tenant_settings
        WHERE tenant_id=$1 AND setting_key=$2 AND (scope_type='tenant' OR (scope_type='branch' AND scope_id=$3))`,
      [tenantId, key, branchId ?? null])).rows,
  }));
  const tenantRow = rows.find((r) => r.scope_type === 'tenant');
  const branchRow = d.scopes.includes('branch') ? rows.find((r) => r.scope_type === 'branch') : undefined;

  const res: EffectiveSetting = { key, value: d.default, source: 'default', defaultValue: d.default };
  if (key in deploymentDefaults) { res.defaultValue = deploymentDefaults[key]; res.value = deploymentDefaults[key]; res.source = 'deployment'; }
  if (platform[0]) { res.platformValue = platform[0].setting_value; res.value = platform[0].setting_value; res.source = 'platform'; }
  if (tenantRow) { res.tenantValue = tenantRow.setting_value; res.value = tenantRow.setting_value; res.source = 'tenant'; res.version = tenantRow.version; }
  if (branchRow) { res.branchValue = branchRow.setting_value; res.value = branchRow.setting_value; res.source = 'branch'; }
  // Stored values are re-validated on read; anything invalid (e.g. schema tightened) falls back safely.
  const parsed = d.schema.safeParse(res.value);
  if (!parsed.success) { res.value = d.default; res.source = 'default'; } else res.value = parsed.data;
  if (d.deploymentCeiling) {
    const ceiling = d.deploymentCeiling(limits);
    if (typeof res.value === 'number' && typeof ceiling === 'number' && res.value > ceiling) {
      res.value = ceiling; res.source = 'deployment_ceiling';
    }
  }
  return res;
}

export async function getSettingValue<T>(db: Db, tenantId: string, key: string, branchId?: string | null): Promise<T> {
  return (await resolveSetting(db, tenantId, key, branchId)).value as T;
}

export interface SettingWrite {
  key: string;
  value: unknown;
  scope: 'tenant' | 'branch';
  branchId?: string;
  /** Optimistic concurrency: the version the editor saw (tenant scope). */
  expectedVersion?: number;
}

/** Validate and upsert. Returns old/new for the audit log. Caller checks permission. */
export async function writeSetting(db: Db, tenantId: string, w: SettingWrite, actorId: string) {
  const d = SETTINGS_MAP.get(w.key);
  if (!d) throw badRequest(`Unknown setting '${w.key}'`);
  if (!d.scopes.includes(w.scope)) throw badRequest(`'${d.label}' cannot be set at ${w.scope} level`);
  if (w.scope === 'branch') {
    if (!w.branchId) throw badRequest('branchId is required for branch-level settings');
    const b = await db.query('SELECT 1 FROM branches WHERE tenant_id=$1 AND id=$2', [tenantId, w.branchId]);
    if (!b.rowCount) throw badRequest('Unknown branch');
  }
  const parsed = d.schema.safeParse(w.value);
  if (!parsed.success) throw badRequest(`Invalid value for '${d.label}'`, parsed.error.issues.map((i) => i.message));
  if (d.deploymentCeiling) {
    const ceiling = d.deploymentCeiling(limits);
    if (typeof parsed.data === 'number' && typeof ceiling === 'number' && parsed.data > ceiling) {
      throw badRequest(`'${d.label}' cannot exceed ${ceiling} on this deployment`);
    }
  }
  const scopeId = w.scope === 'branch' ? w.branchId! : null;
  const existing = await db.query<{ id: string; setting_value: unknown; version: number }>(
    `SELECT id, setting_value, version FROM tenant_settings WHERE tenant_id=$1 AND setting_key=$2 AND scope_type=$3
       AND scope_id IS NOT DISTINCT FROM $4 FOR UPDATE`, [tenantId, w.key, w.scope, scopeId]);
  const prev = existing.rows[0];
  if (prev && w.expectedVersion !== undefined && prev.version !== w.expectedVersion) {
    throw badRequest(`'${d.label}' was changed by someone else. Reload and try again.`);
  }
  if (prev) {
    await db.query(`UPDATE tenant_settings SET setting_value=$1, version=version+1, updated_by=$2, updated_at=now() WHERE id=$3`,
      [JSON.stringify(parsed.data), actorId, prev.id]);
  } else {
    // Two people saving the first value at once: no row for FOR UPDATE to wait on. The second then counts as a change on top of the first.
    await db.query(`INSERT INTO tenant_settings (tenant_id, setting_key, scope_type, scope_id, setting_value, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (tenant_id, setting_key, scope_type, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'))
      DO UPDATE SET setting_value=EXCLUDED.setting_value, updated_by=EXCLUDED.updated_by, version=tenant_settings.version+1, updated_at=now()`, [tenantId, w.key, w.scope, scopeId, JSON.stringify(parsed.data), actorId]);
  }
  invalidate(db, tenantId, 'settings');
  return { definition: d, previous: prev?.setting_value, value: parsed.data };
}

/** Remove an override so the value inherits from the level below. */
export async function clearSetting(db: Db, tenantId: string, key: string, scope: 'tenant' | 'branch', branchId?: string) {
  const r = await db.query<{ setting_value: unknown }>(
    `DELETE FROM tenant_settings WHERE tenant_id=$1 AND setting_key=$2 AND scope_type=$3 AND scope_id IS NOT DISTINCT FROM $4
     RETURNING setting_value`, [tenantId, key, scope, scope === 'branch' ? branchId ?? null : null]);
  invalidate(db, tenantId, 'settings');
  return r.rows[0]?.setting_value;
}
