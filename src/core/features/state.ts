import type { Db } from '../../db/tx.js';
import { FEATURES, FEATURE_MAP, type FeatureDefinition } from './registry.js';
import { featureUnavailable } from '../http/errors.js';
import { resolveSetting } from '../settings/service.js';

/**
 * Module state for this installation:
 *   supported   — implemented in this release
 *   enabled     — listed in the deployment's ENABLED_MODULES (or core)
 *   configured  — required settings / resources present
 *   operational — measurable health, where meaningful
 * Enablement is deployment-controlled: administrators cannot change it in the UI.
 * Disabling a module never deletes data; it only blocks new operations.
 */

// Process-wide: one installation per process (set once by buildApp from ENABLED_MODULES).
let enabledModules: ReadonlySet<string> = resolveEnabledModules('default');

/**
 * Parse and validate ENABLED_MODULES. 'default' expands to the registry
 * defaults and can be combined with extra keys ("default,attendance.biometric").
 * Throws a descriptive error for unknown, unimplemented or dependency-missing modules.
 */
export function resolveEnabledModules(spec: string): ReadonlySet<string> {
  const tokens = spec.split(',').map((s) => s.trim()).filter(Boolean);
  const set = new Set(FEATURES.filter((d) => d.core).map((d) => d.key));
  const problems: string[] = [];
  for (const t of tokens.length ? tokens : ['default']) {
    if (t === 'default') {
      FEATURES.filter((d) => d.defaultEnabled && d.availability !== 'planned').forEach((d) => set.add(d.key));
      continue;
    }
    const d = FEATURE_MAP.get(t);
    if (!d) { problems.push(`unknown module '${t}'`); continue; }
    if (d.availability === 'planned') { problems.push(`module '${t}' is not available in this release`); continue; }
    set.add(t);
  }
  for (const k of set) {
    for (const dep of FEATURE_MAP.get(k)!.dependencies) {
      if (!set.has(dep)) problems.push(`module '${k}' requires '${dep}' to be enabled`);
    }
  }
  if (problems.length) throw new Error(`Invalid ENABLED_MODULES:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return set;
}

export function setEnabledModules(set: ReadonlySet<string>) { enabledModules = set; }
export function isModuleEnabled(key: string) { return enabledModules.has(key); }

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
export function setStorageConfigured(v: boolean) { storageConfigured = v; }
export function setEmailTransportConfigured(v: boolean) { emailTransportConfigured = v; }
let smsTransportConfigured = false;
export function setSmsTransportConfigured(v: boolean) { smsTransportConfigured = v; }

/** Per-feature configuration checks beyond required settings. */
const CONFIG_CHECKS: Record<string, (db: Db, tenantId: string) => Promise<{ configured: boolean; operational: FeatureState['operational']; note?: string }>> = {
  'core.documents': async () => ({
    configured: storageConfigured, operational: 'not_applicable',
    note: storageConfigured ? undefined : 'Document storage not configured (STORAGE_DRIVER deployment setting)',
  }),
  'notifications.email': async () => ({
    configured: emailTransportConfigured, operational: 'not_applicable',
    note: emailTransportConfigured ? undefined : 'Email transport not configured (MAIL_TRANSPORT / SMTP_* deployment settings)',
  }),
  'notifications.sms': async (db, tenantId) => {
    if (!smsTransportConfigured) return { configured: false, operational: 'not_applicable', note: 'SMS provider not configured (SMS_TRANSPORT / SMS_HTTP_* deployment settings)' };
    const n = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM sms_templates WHERE tenant_id=$1 AND enabled`, [tenantId])).rows[0]!.n);
    return { configured: true, operational: 'not_applicable', note: n ? undefined : 'No SMS templates yet: add the DLT-registered templates under Settings → SMS' };
  },
  overtime: async (db, tenantId) => {
    const on = (await resolveSetting(db, tenantId, 'attendance.overtime_enabled')).value === true;
    return { configured: on, operational: 'not_applicable', note: on ? undefined : "Turn on 'Calculate overtime minutes' in the attendance policy" };
  },
  'attendance.biometric': async (db, tenantId) => {
    const r = await db.query<{ active: string; recent: string }>(
      `SELECT count(*) FILTER (WHERE status='active') AS active,
              count(*) FILTER (WHERE status='active' AND last_sync_at > now() - interval '24 hours') AS recent
         FROM attendance_devices WHERE tenant_id = $1`, [tenantId]);
    const active = Number(r.rows[0]!.active); const recent = Number(r.rows[0]!.recent);
    return {
      configured: active > 0,
      operational: active === 0 ? 'unknown' : recent === active ? 'healthy' : 'degraded',
      note: active === 0 ? 'No active biometric device registered' : undefined,
    };
  },
};

export async function evaluateFeatures(db: Db, tenantId: string): Promise<Map<string, FeatureState>> {
  const out = new Map<string, FeatureState>();
  const evalOne = async (d: FeatureDefinition): Promise<FeatureState> => {
    const cached = out.get(d.key);
    if (cached) return cached;
    const blockers: string[] = [];
    const supported = d.availability !== 'planned';
    if (!supported) blockers.push('Not available in this release');
    const enabled = d.core || enabledModules.has(d.key);
    if (supported && !enabled) blockers.push('Not enabled for this installation');
    let dependenciesMet = true;
    for (const dep of d.dependencies) {
      const ds = await evalOne(FEATURE_MAP.get(dep)!);
      if (!ds.usable) { dependenciesMet = false; blockers.push(`Requires '${ds.name}'`); }
    }
    let configured = true;
    let operational: FeatureState['operational'] = 'not_applicable';
    if (supported && enabled) {
      for (const key of d.requiredSettings ?? []) {
        const v = await resolveSetting(db, tenantId, key);
        if (v.value === null || v.value === undefined) { configured = false; blockers.push(`Setting '${key}' not configured`); }
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
      key: d.key, name: d.name, description: d.description, category: d.category, core: d.core, dependencies: d.dependencies,
      supported, enabled, configured, dependenciesMet, operational, usable: supported && enabled && dependenciesMet && configured, blockers,
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
  if (!s.usable) throw featureUnavailable(key, s.blockers.join('; '));
}
