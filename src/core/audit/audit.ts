import type { Db } from '../../db/tx.js';
import { scrubAmounts } from '../policy/text.js';

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
  /** The device: the request's user agent, on L4 reads and reveals. */
  userAgent?: string;
}

/**
 * Keys that never reach the audit log, at any depth. Money and identity values are removed when written, and removed again
 * when an old row is read. Names of fields are fine; values are not. `Set` and `Changed` flags stay, because they carry no value.
 */
const REDACT_KEYS =
  /(password|token|secret|account_?number|api_?key|^amounts?$|gross|^net$|deductions?$|employer_?cost|totals?$|ctc|salary$|^pan$|aadhaar$|last_?4|^uan$|ifsc|installment_?amount|estimate|^advance$|outstanding|^expected_?ctc)/i;

/** Strip values that must never be persisted in audit metadata, recursively. */
export function redact(v: unknown): unknown {
  if (typeof v === 'string') return scrubAmounts(v);
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
       change_metadata, request_id, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      e.tenantId,
      e.actorId,
      e.actorType ?? 'user',
      e.action,
      e.category ?? 'data',
      e.targetType ?? null,
      e.targetId ?? null,
      e.settingKey ?? null,
      JSON.stringify(redact(e.metadata ?? {})),
      e.requestId ?? null,
      e.ip ?? null,
      e.userAgent?.slice(0, 300) ?? null,
    ],
  );
}

/** Several rows at once, each chained on its own: one reveal of a payroll run audits every person in it. */
export async function auditMany(db: Db, base: Omit<AuditEntry, 'targetId' | 'metadata'>, rows: { targetId: string; metadata: Record<string, unknown> }[]): Promise<void> {
  if (!rows.length) return;
  await db.query(
    `INSERT INTO audit_logs (tenant_id, actor_id, actor_type, action, category, target_type, target_id, change_metadata, request_id, ip, user_agent)
     SELECT $1,$2,$3,$4,$5,$6,x.t,x.m::jsonb,$9,$10,$11 FROM unnest($7::text[],$8::text[]) AS x(t,m)`,
    [
      base.tenantId,
      base.actorId,
      base.actorType ?? 'user',
      base.action,
      base.category ?? 'access',
      base.targetType ?? null,
      rows.map((r) => r.targetId),
      rows.map((r) => JSON.stringify(redact(r.metadata))),
      base.requestId ?? null,
      base.ip ?? null,
      base.userAgent?.slice(0, 300) ?? null,
    ],
  );
}
