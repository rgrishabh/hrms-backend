import type { Env, InstallationEnv } from './env.js';
import { deploymentDomains } from './env.js';
import type pg from 'pg';
type Db = pg.ClientBase;
import { isModuleEnabled } from '../core/features/state.js';
import { FEATURES } from '../core/features/registry.js';

/**
 * The installation's public identity, built once from deployment configuration.
 * This is the ONLY configuration exposed to browsers (GET /api/v1/public/config)
 * and the single source for branding in the UI, page title and documents.
 * Never add secrets or internal endpoints here.
 */
export interface PublicConfig {
  product: { name: string };
  brand: {
    name: string; shortName: string; logoUrl: string | null; faviconUrl: string | null;
    primaryColor: string; secondaryColor: string; accentColor: string; loginMessage: string | null;
    supportEmail: string | null; supportPhone: string | null; helpUrl: string | null;
  };
  organization: {
    name: string; legalName: string; country: string; timezone: string; currency: string; dateFormat: string; fiscalYearStartMonth: number;
  };
  modules: string[];
}

export function buildPublicConfig(env: Env): PublicConfig {
  const brandName = env.BRAND_NAME ?? env.ORGANIZATION_NAME;
  return {
    product: { name: env.PRODUCT_NAME },
    brand: {
      name: brandName,
      shortName: env.BRAND_SHORT_NAME ?? brandName,
      logoUrl: env.BRAND_LOGO_URL ?? null,
      faviconUrl: env.BRAND_FAVICON_URL ?? null,
      primaryColor: env.BRAND_PRIMARY_COLOR,
      secondaryColor: env.BRAND_SECONDARY_COLOR,
      accentColor: env.BRAND_ACCENT_COLOR,
      loginMessage: env.BRAND_LOGIN_MESSAGE ?? null,
      supportEmail: env.BRAND_SUPPORT_EMAIL ?? null,
      supportPhone: env.BRAND_SUPPORT_PHONE ?? null,
      helpUrl: env.BRAND_HELP_URL ?? null,
    },
    organization: {
      name: env.ORGANIZATION_NAME,
      legalName: env.ORGANIZATION_LEGAL_NAME ?? env.ORGANIZATION_NAME,
      country: env.ORGANIZATION_COUNTRY,
      timezone: env.ORGANIZATION_TIMEZONE,
      currency: env.ORGANIZATION_CURRENCY,
      dateFormat: env.ORGANIZATION_DATE_FORMAT,
      fiscalYearStartMonth: env.ORGANIZATION_FY_START_MONTH,
    },
    modules: FEATURES.filter((f) => isModuleEnabled(f.key)).map((f) => f.key),
  };
}

export const SINGLE_ORG_SLUG = 'organization';

/**
 * Make the database match the deployment configuration: the organization row
 * (name, timezone) and its domains (APP_URL host + APP_EXTRA_DOMAINS active;
 * anything else deactivated, never deleted). Idempotent. Never creates a second
 * organization. Must run with platform bypass (it spans tenant-scoped tables).
 * Returns null when the installation has not been bootstrapped yet.
 */
export async function reconcileInstallation(db: Db, env: InstallationEnv): Promise<{ tenantId: string; domains: string[] } | null> {
  const t = await db.query<{ id: string }>('SELECT id FROM tenants ORDER BY created_at');
  if (t.rowCount! > 1) throw new Error(`this installation contains ${t.rowCount} organizations; exactly one is allowed`);
  const tenantId = t.rows[0]?.id;
  if (!tenantId) return null;
  await db.query(`UPDATE tenants SET name=$2, timezone=$3, updated_at=now() WHERE id=$1 AND (name<>$2 OR timezone<>$3)`,
    [tenantId, env.ORGANIZATION_NAME, env.ORGANIZATION_TIMEZONE]);
  const domains = deploymentDomains(env);
  for (const [i, h] of domains.entries()) {
    const other = await db.query<{ tenant_id: string }>('SELECT tenant_id FROM tenant_domains WHERE hostname=$1', [h]);
    if (other.rows[0] && other.rows[0].tenant_id !== tenantId) throw new Error(`hostname ${h} belongs to another organization`);
    await db.query(`INSERT INTO tenant_domains (tenant_id, hostname, verification_token, verification_status, verified_at, activation_status, tls_status, is_primary)
        VALUES ($1,$2,'deployment-config','verified',now(),'active',$3,$4)
      ON CONFLICT (hostname) DO UPDATE SET verification_status='verified', activation_status='active', tls_status=$3, is_primary=$4, last_error=NULL, updated_at=now()`,
      [tenantId, h, env.APP_URL.startsWith('https://') ? 'issued' : 'not_requested', i === 0]);
  }
  await db.query(`UPDATE tenant_domains SET activation_status='inactive', is_primary=false, updated_at=now()
    WHERE tenant_id=$1 AND NOT (hostname = ANY($2)) AND activation_status='active'`, [tenantId, domains]);
  return { tenantId, domains };
}
