import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from '../../db/tx.js';
import { FEATURES, FEATURE_MAP, type FeatureDefinition } from './registry.js';
import { featureNotConfigured, notFound } from '../http/errors.js';
import { resolveSetting } from '../settings/service.js';
import { memoized } from '../memo.js';

/**
 * Module state for this installation:
 *   supported   — implemented in this release
 *   enabled     — its FEATURE_* variable is on (or it is core)
 *   configured  — required settings / resources present
 *   operational — measurable health, where meaningful
 * Enablement is deployment-controlled: administrators cannot change it in the UI.
 * Disabling a module never deletes data; it only blocks new operations.
 */

/**
 * Which features are on is decided once per process from its FEATURE_* variables, and never changes while it runs.
 * It is carried in the async context instead of a mutable global: buildApp enters its own set for every request and the
 * worker for its whole loop, so two apps in one process (the test suite) cannot see each other's set. Code running outside
 * any of these sees the registry defaults.
 */
const scope = new AsyncLocalStorage<ReadonlySet<string>>();
const DEFAULTS: ReadonlySet<string> = new Set(FEATURES.filter((d) => d.core || d.defaultEnabled).map((d) => d.key));
export const currentFeatures = (): ReadonlySet<string> => scope.getStore() ?? DEFAULTS;
export function withFeatures<T>(features: ReadonlySet<string>, fn: () => T): T {
  return scope.run(features, fn);
}
export function isModuleEnabled(key: string) {
  return currentFeatures().has(key);
}
/** True when no feature of a key or list applies: a setting, job or report that belongs to a module that is off. */
export function allOff(feature: string | readonly string[] | undefined | null) {
  if (!feature) return false;
  return !(typeof feature === 'string' ? [feature] : feature).some(isModuleEnabled);
}

export interface FeatureState {
  key: string;
  name: string;
  description: string;
  category: string;
  core: boolean;
  dependencies: readonly string[];
  supported: boolean;
  enabled: boolean;
  configured: boolean;
  dependenciesMet: boolean;
  operational: 'healthy' | 'degraded' | 'unknown' | 'not_applicable';
  usable: boolean;
  blockers: string[];
}

let emailTransportConfigured = false;
let storageConfigured = false;
export function setStorageConfigured(v: boolean) {
  storageConfigured = v;
}
export function setEmailTransportConfigured(v: boolean) {
  emailTransportConfigured = v;
}
let pushConfigured = false;
export function setPushConfigured(v: boolean) {
  pushConfigured = v;
}

/** Per-feature configuration checks beyond required settings. */
const CONFIG_CHECKS: Record<string, (db: Db, tenantId: string) => Promise<{ configured: boolean; operational: FeatureState['operational']; note?: string }>> = {
  'core.documents': async () => ({
    configured: storageConfigured,
    operational: 'not_applicable',
    note: storageConfigured ? undefined : 'Document storage not configured (STORAGE_DRIVER deployment setting)',
  }),
  'notifications.email': async () => ({
    configured: emailTransportConfigured,
    operational: 'not_applicable',
    note: emailTransportConfigured ? undefined : 'Email transport not configured (SMTP_HOST deployment setting)',
  }),
  'notifications.push': async () => ({
    configured: pushConfigured,
    operational: 'not_applicable',
    note: pushConfigured ? undefined : 'Web push is not configured (VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY deployment settings)',
  }),
  'attendance.selfie': async () => ({
    configured: storageConfigured,
    operational: 'not_applicable',
    note: storageConfigured ? undefined : 'Selfie storage not configured (STORAGE_DRIVER deployment setting)',
  }),
  overtime: async (db, tenantId) => {
    const on = (await resolveSetting(db, tenantId, 'attendance.overtime_enabled')).value === true;
    return { configured: on, operational: 'not_applicable', note: on ? undefined : "Turn on 'Calculate overtime minutes' in the attendance policy" };
  },
  'attendance.biometric': async (db, tenantId) => {
    const r = await db.query<{ active: string; recent: string }>(
      `SELECT count(*) FILTER (WHERE status='active') AS active,
              count(*) FILTER (WHERE status='active' AND last_sync_at > now() - interval '24 hours') AS recent
         FROM attendance_devices WHERE tenant_id = $1`,
      [tenantId],
    );
    const active = Number(r.rows[0]!.active);
    const recent = Number(r.rows[0]!.recent);
    return {
      configured: active > 0,
      operational: active === 0 ? 'unknown' : recent === active ? 'healthy' : 'degraded',
      note: active === 0 ? 'No active biometric device registered' : undefined,
    };
  },
};

export async function evaluateFeatures(db: Db, tenantId: string): Promise<Map<string, FeatureState>> {
  return memoized(`features:${tenantId}`, () => evaluate(db, tenantId));
}

async function evaluate(db: Db, tenantId: string): Promise<Map<string, FeatureState>> {
  const out = new Map<string, FeatureState>();
  const evalOne = async (d: FeatureDefinition): Promise<FeatureState> => {
    const cached = out.get(d.key);
    if (cached) return cached;
    const blockers: string[] = [];
    const supported = d.availability !== 'planned';
    if (!supported) blockers.push('Not available in this release');
    const enabled = d.core || isModuleEnabled(d.key);
    if (supported && !enabled) blockers.push('Not enabled for this installation');
    let dependenciesMet = true;
    for (const dep of d.dependencies) {
      const ds = await evalOne(FEATURE_MAP.get(dep)!);
      if (!ds.usable) {
        dependenciesMet = false;
        blockers.push(`Requires '${ds.name}'`);
      }
    }
    let configured = true;
    let operational: FeatureState['operational'] = 'not_applicable';
    if (supported && enabled) {
      for (const key of d.requiredSettings ?? []) {
        const v = await resolveSetting(db, tenantId, key);
        if (v.value === null || v.value === undefined) {
          configured = false;
          blockers.push(`Setting '${key}' not configured`);
        }
      }
      const check = CONFIG_CHECKS[d.key];
      if (check) {
        const r = await check(db, tenantId);
        configured = configured && r.configured;
        operational = r.operational;
        if (r.note && !r.configured) blockers.push(r.note);
      }
    }
    const state: FeatureState = {
      key: d.key,
      name: d.name,
      description: d.description,
      category: d.category,
      core: d.core,
      dependencies: d.dependencies,
      supported,
      enabled,
      configured,
      dependenciesMet,
      operational,
      usable: supported && enabled && dependenciesMet && configured,
      blockers,
    };
    out.set(d.key, state);
    return state;
  };
  for (const d of FEATURES) await evalOne(d);
  return out;
}

export async function assertFeatureUsable(db: Db, tenantId: string, key: string): Promise<void> {
  const s = (await evaluateFeatures(db, tenantId)).get(key);
  if (!s) throw new Error(`Unknown feature ${key}`);
  // Off means the module does not exist for this deployment. On but not usable means it needs setting up.
  if (!s.enabled || !s.supported) throw notFound();
  if (!s.usable) throw featureNotConfigured(key, s.blockers.join('; '));
}
