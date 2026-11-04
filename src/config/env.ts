import { isIP } from 'node:net';
import { z } from 'zod';

/**
 * Deployment configuration. One installation = one customer; everything that
 * identifies the installation (branding, organization identity, enabled
 * modules, domains) is set here by whoever deploys it (Docker Compose `.env`
 * or Terraform), validated once at startup, and cannot be changed by
 * administrators in the UI. Secrets are read from env (injected from Secrets
 * Manager on AWS) and are never exposed to the browser or logs.
 */
const bool = (def: 'true' | 'false') => z.enum(['true', 'false']).default(def).transform((v) => v === 'true');
// In .env files quote colours ("#14532D"): many parsers treat an unquoted # as a comment.
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a hex colour like "#14532D" (quote it in .env files)');
const list = z.string().default('').transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));
/** Logo/favicon: an https URL, or a path served from BRANDING_DIR (e.g. /branding/logo.svg). */
const assetRef = z.string().refine((v) => /^https:\/\/[^\s"'<>]+$/.test(v) || /^\/branding\/[A-Za-z0-9._-]+$/.test(v),
  'must be an https:// URL or /branding/<file>');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('127.0.0.1'),
  /** Public URL of this installation; its hostname is the primary domain. */
  APP_URL: z.url().default('http://localhost:5173'),
  /** Additional hostnames that serve this installation (comma separated). */
  APP_EXTRA_DOMAINS: list,

  // ---- database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (runtime role hrms_app, no BYPASSRLS)'),
  DATABASE_MIGRATION_URL: z.string().optional(),
  DATABASE_SSL: z.enum(['disable', 'verify-full']).optional(),
  DATABASE_CA_FILE: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),

  // ---- security
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Login/password attempts per client IP per minute (account lockout is enforced separately). */
  // Per client IP across the whole API. A lab's staff often share one office NAT address, so keep this generous;
  // sign-in and password endpoints have their own strict limits (AUTH_RATE_LIMIT_PER_MINUTE).
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(60).max(100000).default(3000),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(20),
  // Sign-in attempts on one account per minute, whatever address they come from.
  AUTH_ACCOUNT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(10),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
  COOKIE_SECURE: bool('true'),
  // Whose X-Forwarded-For to believe: false, a number of proxy hops in front of the app, or comma-separated proxy
  // addresses/CIDRs. Trusting every hop would let a client choose its own address, so `true` means one hop.
  TRUST_PROXY: z.string().default('false').transform((v, ctx): false | number | string[] => {
    const t = v.trim();
    if (t === 'false' || t === '0' || t === '') return false;
    if (t === 'true') return 1;
    if (/^[0-9]+$/.test(t)) return Number(t);
    const list = t.split(',').map((x) => x.trim()).filter(Boolean);
    if (list.every((x) => isIP(x.split('/')[0]!) !== 0)) return list;
    ctx.addIssue({ code: 'custom', message: 'Use false, a number of proxy hops, or comma-separated proxy addresses or CIDRs' });
    return z.NEVER;
  }),
  /** base64-encoded 32-byte key for field-level encryption (bank account numbers). */
  DATA_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32,
    'DATA_ENCRYPTION_KEY must be base64 of exactly 32 bytes (generate: openssl rand -base64 32)'),

  // ---- processes. The API takes traffic and enqueues; the worker runs jobs and sends mail. Safe with several of each:
  // each run is claimed once in the database.
  PROCESS_ROLE: z.enum(['api', 'worker']).default('api'),
  JOBS_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),

  // ---- email (module notifications.email). Credentials from env / secret store only.
  MAIL_TRANSPORT: z.enum(['disabled', 'smtp', 'log']).default('disabled'),
  // SMS (module notifications.sms): the provider's HTTP API, with DLT sender and entity IDs.
  SMS_TRANSPORT: z.enum(['disabled', 'http', 'log']).default('disabled'),
  SMS_HTTP_URL: z.url().optional(),
  SMS_HTTP_AUTH_HEADER: z.string().optional(),           // "Name: value", e.g. "authkey: …" or "Authorization: Basic …"
  SMS_HTTP_CONTENT_TYPE: z.enum(['json', 'form']).default('json'),
  SMS_HTTP_BODY: z.string().optional(),                  // body with {{to}} {{to_digits}} {{message}} {{template_id}} {{sender_id}} {{entity_id}}
  SMS_SENDER_ID: z.string().regex(/^[A-Z0-9]{3,11}$/).optional(),
  SMS_DLT_ENTITY_ID: z.string().regex(/^[0-9]{10,25}$/).optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: bool('false'),          // true = implicit TLS (465); false = STARTTLS when offered
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM_ADDRESS: z.email().optional(),
  MAIL_FROM_NAME: z.string().trim().max(100).optional(),

  // ---- document storage (module core.documents): a local volume (Compose) or the installation's S3 bucket (AWS)
  STORAGE_DRIVER: z.enum(['disabled', 'local', 's3']).default('disabled'),
  STORAGE_PATH: z.string().optional(),
  STORAGE_MAX_FILE_MB: z.coerce.number().int().min(1).max(50).default(10),

  /** Minimum MFA enforcement for this installation (organizations may only make it stricter). */
  MFA_ENFORCEMENT: z.enum(['off', 'privileged', 'all']).default('privileged'),

  // ---- modules (see core/features/registry.ts). 'default' = the registry defaults.
  ENABLED_MODULES: z.string().default('default'),

  // ---- branding (public; shown in the UI, page title, documents)
  PRODUCT_NAME: z.string().trim().min(1).max(60).default('LabHRMS'),
  BRAND_NAME: z.string().trim().max(120).optional(),
  BRAND_SHORT_NAME: z.string().trim().max(40).optional(),
  BRAND_LOGO_URL: assetRef.optional(),
  BRAND_FAVICON_URL: assetRef.optional(),
  BRAND_PRIMARY_COLOR: hex.default('#1f5f8b'),
  BRAND_SECONDARY_COLOR: hex.default('#0f172a'),
  BRAND_ACCENT_COLOR: hex.default('#2e8b57'),
  BRAND_LOGIN_MESSAGE: z.string().trim().max(300).optional(),
  BRAND_SUPPORT_EMAIL: z.email().optional(),
  BRAND_SUPPORT_PHONE: z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/, 'invalid phone number').optional(),
  BRAND_HELP_URL: z.url().refine((v) => v.startsWith('https://'), 'must be https').optional(),
  /** Directory with deployment-specific branding files served at /branding/* (mounted volume). */
  BRANDING_DIR: z.string().optional(),

  // ---- organization identity (public)
  ORGANIZATION_NAME: z.string().trim().min(2).max(200).default('Demo Testing Laboratories'),
  ORGANIZATION_LEGAL_NAME: z.string().trim().max(200).optional(),
  ORGANIZATION_COUNTRY: z.string().regex(/^[A-Z]{2}$/).default('IN'),
  ORGANIZATION_TIMEZONE: z.string().refine((tz) => { try { new Intl.DateTimeFormat('en-IN', { timeZone: tz }); return true; } catch { return false; } }, 'unknown IANA timezone').default('Asia/Kolkata'),
  ORGANIZATION_CURRENCY: z.string().regex(/^[A-Z]{3}$/).default('INR'),
  ORGANIZATION_DATE_FORMAT: z.enum(['DD/MM/YYYY', 'DD-MM-YYYY', 'DD-MMM-YYYY', 'YYYY-MM-DD']).default('DD/MM/YYYY'),
  ORGANIZATION_FY_START_MONTH: z.coerce.number().int().min(1).max(12).default(4),

  /** If set, the API also serves the built web app (apps/web/dist) from this directory. */
  WEB_DIST_DIR: z.string().optional(),
  AWS_REGION: z.string().optional(),
  AWS_S3_BUCKET: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

/** Docker Compose passes unset optional variables as ''. Treat empty as "not set". */
const nonEmpty = (source: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(nonEmpty(source));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid deployment configuration:\n${issues}`);
  }
  const env = parsed.data;
  const problems: string[] = [];
  if (env.NODE_ENV === 'production') {
    if (!env.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true in production (serve over HTTPS)');
    if (!env.APP_URL.startsWith('https://')) problems.push('APP_URL must be https:// in production');
    // Must be a deliberate choice: 'disable' only for a database on a private network (Docker Compose).
    if (!env.DATABASE_SSL) problems.push("DATABASE_SSL must be set explicitly in production ('verify-full', or 'disable' for a database on a private Docker network)");
  }
  if (env.STORAGE_DRIVER === 'local' && !env.STORAGE_PATH) problems.push('STORAGE_DRIVER=local needs STORAGE_PATH (a persistent volume)');
  if (env.STORAGE_DRIVER === 's3' && (!env.AWS_S3_BUCKET || !env.AWS_REGION)) problems.push('STORAGE_DRIVER=s3 needs AWS_S3_BUCKET and AWS_REGION');
  if (env.MAIL_TRANSPORT === 'smtp' && (!env.SMTP_HOST || !env.MAIL_FROM_ADDRESS)) problems.push('MAIL_TRANSPORT=smtp needs SMTP_HOST and MAIL_FROM_ADDRESS');
  if (env.MAIL_TRANSPORT === 'smtp' && !!env.SMTP_USER !== !!env.SMTP_PASSWORD) problems.push('Set both SMTP_USER and SMTP_PASSWORD, or neither');
  if (env.MAIL_TRANSPORT === 'log' && env.NODE_ENV === 'production') problems.push("MAIL_TRANSPORT=log is for development only");
  if (env.SMS_TRANSPORT === 'http' && (!env.SMS_HTTP_URL || !env.SMS_HTTP_BODY)) problems.push('SMS_TRANSPORT=http needs SMS_HTTP_URL and SMS_HTTP_BODY');
  if (env.SMS_TRANSPORT === 'http' && env.NODE_ENV === 'production' && !env.SMS_HTTP_URL?.startsWith('https://')) problems.push('SMS_HTTP_URL must use https');
  if (env.SMS_TRANSPORT === 'log' && env.NODE_ENV === 'production') problems.push('SMS_TRANSPORT=log is for development only');
  if (env.BRAND_LOGO_URL?.startsWith('/branding/') || env.BRAND_FAVICON_URL?.startsWith('/branding/')) {
    if (!env.BRANDING_DIR) problems.push('BRANDING_DIR must be set to serve /branding/* logo or favicon files');
  }
  if (problems.length) throw new Error(`Invalid deployment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return env;
}

/** Hostnames this installation answers to: APP_URL host + APP_EXTRA_DOMAINS. */
export function deploymentDomains(env: Pick<Env, 'APP_URL' | 'APP_EXTRA_DOMAINS'>): string[] {
  return [...new Set([new URL(env.APP_URL).hostname.toLowerCase(), ...env.APP_EXTRA_DOMAINS.map((d) => d.toLowerCase())])];
}

/** The subset of deployment configuration needed by the bootstrap task (which has no runtime secrets). */
export const installationSchema = schema.pick({ NODE_ENV: true, APP_URL: true, APP_EXTRA_DOMAINS: true, ORGANIZATION_NAME: true, ORGANIZATION_TIMEZONE: true });
export type InstallationEnv = z.infer<typeof installationSchema>;
export function loadInstallationEnv(source: NodeJS.ProcessEnv = process.env): InstallationEnv {
  const parsed = installationSchema.safeParse(nonEmpty(source));
  if (!parsed.success) throw new Error(`Invalid deployment configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  return parsed.data;
}
