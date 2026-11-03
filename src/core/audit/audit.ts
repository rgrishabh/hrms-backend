import type { Db } from '../../db/tx.js';

export interface AuditEntry {
  tenantId: string | null;
  actorId: string | null;
  actorType?: 'user' | 'system' | 'device' | 'platform';
  action: string;
  category?: 'auth' | 'configuration' | 'data' | 'security' | 'access';
  targetType?: string;
  targetId?: string;
  settingKey?: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
  ip?: string;
}

const REDACT_KEYS = /(password|token|secret|account_?number|api_?key)/i;

/** Strip values that must never be persisted in audit metadata, recursively. */
export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, REDACT_KEYS.test(k) ? '[REDACTED]' : redact(val)]));
  }
  return v;
}

/** Written in the same transaction as the change it records, so both commit or roll back together. */
export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (tenant_id, actor_id, actor_type, action, category, target_type, target_id, setting_key,
       change_metadata, request_id, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [e.tenantId, e.actorId, e.actorType ?? 'user', e.action, e.category ?? 'data', e.targetType ?? null,
     e.targetId ?? null, e.settingKey ?? null, JSON.stringify(redact(e.metadata ?? {})), e.requestId ?? null, e.ip ?? null]);
}
