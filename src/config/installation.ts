import type { Env, InstallationEnv } from './env.js';
import { appUrl, deploymentDomains, organizationName } from './env.js';
import type pg from 'pg';
type Db = pg.ClientBase;
import { FEATURE_BY_ENV } from '../core/features/registry.js';

/**
 * The installation's public identity, built once from deployment configuration. It is the ONLY configuration exposed
 * to browsers (GET /api/v1/config/public) and the single source for branding in the UI, page title and documents.
 * Never add secrets, internal endpoints or feature descriptions here.
 */
export interface PublicConfig {
  product: { name: string };
  brand: {
    name: string; legalName: string; logoUrl: string | null; logoDarkUrl: string | null; faviconUrl: string | null;
    primaryColor: string; secondaryColor: string | null; accentColor: string | null; fontFamily: string | null;
    supportEmail: string; supportPhone: string | null; helpUrl: string | null; loginMessage: string | null;
    domain: string; locale: string; timezone: string; currency: string; dateFormat: string; financialYearStart: string; country: string;
  };
  /** Every flag of the registry; one that is off is false. */
  features: Record<string, boolean>;
  mode: 'single' | 'single_hr' | 'multi';
  mfa: { available: boolean; enforced: boolean; methods: string[] };
}

export function buildPublicConfig(env: Env): PublicConfig {
  return {
    product: { name: env.BRAND_PRODUCT_NAME },
    brand: {
      name: env.BRAND_NAME,
      legalName: organizationName(env),
      logoUrl: env.BRAND_LOGO_URL ?? null,
      logoDarkUrl: env.BRAND_LOGO_DARK_URL ?? null,
      faviconUrl: env.BRAND_FAVICON_URL ?? null,
      primaryColor: env.BRAND_PRIMARY_COLOR,
      secondaryColor: env.BRAND_SECONDARY_COLOR ?? null,
      accentColor: env.BRAND_ACCENT_COLOR ?? null,
      fontFamily: env.BRAND_FONT_FAMILY ?? null,
      supportEmail: env.BRAND_SUPPORT_EMAIL,
      supportPhone: env.BRAND_SUPPORT_PHONE ?? null,
      helpUrl: env.BRAND_HELP_URL ?? null,
      loginMessage: env.BRAND_LOGIN_MESSAGE ?? null,
      domain: env.BRAND_DOMAIN,
      locale: env.BRAND_LOCALE,
      timezone: env.BRAND_TIMEZONE,
      currency: env.BRAND_CURRENCY,
      dateFormat: env.BRAND_DATE_FORMAT,
      financialYearStart: env.BRAND_FINANCIAL_YEAR_START,
      country: env.BRAND_COUNTRY,
    },
    features: Object.fromEntries([...FEATURE_BY_ENV].map(([name, d]) => [name, env.enabledFeatures.has(d.key)])),
    mode: env.ORG_MANAGEMENT_MODE,
    mfa: { available: env.MFA_AVAILABLE, enforced: env.MFA_ENFORCED, methods: env.MFA_AVAILABLE ? env.MFA_METHODS : [] },
  };
}

export const SINGLE_ORG_SLUG = 'organization';

/**
 * Make the database match the deployment configuration: the organization row
 * (name, timezone) and its domains (BRAND_DOMAIN + BRAND_EXTRA_DOMAINS active;
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
    [tenantId, organizationName(env), env.BRAND_TIMEZONE]);
  const domains = deploymentDomains(env);
  for (const [i, h] of domains.entries()) {
    const other = await db.query<{ tenant_id: string }>('SELECT tenant_id FROM tenant_domains WHERE hostname=$1', [h]);
    if (other.rows[0] && other.rows[0].tenant_id !== tenantId) throw new Error(`hostname ${h} belongs to another organization`);
    await db.query(`INSERT INTO tenant_domains (tenant_id, hostname, verification_token, verification_status, verified_at, activation_status, tls_status, is_primary)
        VALUES ($1,$2,'deployment-config','verified',now(),'active',$3,$4)
      ON CONFLICT (hostname) DO UPDATE SET verification_status='verified', activation_status='active', tls_status=$3, is_primary=$4, last_error=NULL, updated_at=now()`,
      [tenantId, h, appUrl(env).startsWith('https://') ? 'issued' : 'not_requested', i === 0]);
  }
  await db.query(`UPDATE tenant_domains SET activation_status='inactive', is_primary=false, updated_at=now()
    WHERE tenant_id=$1 AND NOT (hostname = ANY($2)) AND activation_status='active'`, [tenantId, domains]);
  return { tenantId, domains };
}
