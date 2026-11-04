import type { Pool } from '../../db/pool.js';
import { withPlatformBypass } from '../../db/tx.js';

export interface ResolvedTenant { id: string; slug: string; name: string; status: string; timezone: string }

export type HostResolution =
  | { kind: 'tenant'; host: string; tenant: ResolvedTenant }
  | { kind: 'unknown'; host: string };

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Lowercase, strip port and trailing dot; return null for anything that is not a plain hostname. */
export function normalizeHostname(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let h = raw.trim().toLowerCase();
  if (h.startsWith('[')) return null;           // IPv6 literal — never a tenant domain
  const colon = h.lastIndexOf(':');
  if (colon !== -1) {
    const port = h.slice(colon + 1);
    if (!/^\d{1,5}$/.test(port)) return null;
    h = h.slice(0, colon);
  }
  if (h.endsWith('.')) h = h.slice(0, -1);
  return HOSTNAME_RE.test(h) ? h : null;
}

/**
 * Host → the installation's organization. A Host header is honoured ONLY when it
 * is one of the domains configured for this deployment (BRAND_DOMAIN / BRAND_EXTRA_DOMAINS,
 * synced to tenant_domains at startup and by the bootstrap task). Unknown hosts get
 * no organization. Lookup is per request (indexed).
 */
export async function resolveHost(pool: Pool, rawHost: string | undefined): Promise<HostResolution> {
  const host = normalizeHostname(rawHost);
  if (!host) return { kind: 'unknown', host: '' };
  const r = await withPlatformBypass(pool, (db) => db.query<ResolvedTenant>(
    `SELECT t.id, t.slug, t.name, t.status, t.timezone
       FROM tenant_domains d JOIN tenants t ON t.id = d.tenant_id
      WHERE d.hostname = $1 AND d.verification_status = 'verified' AND d.activation_status = 'active'`, [host]));
  const t = r.rows[0];
  return t ? { kind: 'tenant', host, tenant: t } : { kind: 'unknown', host };
}
