import { isIP } from 'node:net';
import { z } from 'zod';
import { resolveFeatures } from '../core/features/registry.js';

/**
 * Deployment configuration, as in docs/CONFIGURATION.md of hrms-deployment. One installation = one customer;
 * everything that identifies the installation (brand, enabled modules, domains) is set here by whoever deploys it (Docker Compose `.env`
 * or Terraform), validated once at startup, and cannot be changed by
 * administrators in the UI. Secrets are read from env (injected from Secrets
 * Manager on AWS) and are never exposed to the browser or logs.
 */
const bool = (def: 'true' | 'false') => z.enum(['true', 'false']).default(def).transform((v) => v === 'true');
// In .env files quote colours ("#14532D"): many parsers treat an unquoted # as a comment.
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a hex colour like "#14532D" (quote it in .env files)');
const list = z.string().default('').transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));
/** Logo/favicon: an https URL the browser loads (the server never fetches it), or a file of the /brand mount. */
const assetRef = z.string().refine((v) => /^https:\/\/[^\s"'<>]+$/.test(v) || /^\/brand\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v),
  'must be an https:// URL or /brand/<file>');
const hostname = z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/, 'must be a hostname, without scheme, port or path');
const timezone = z.string().refine((tz) => { try { new Intl.DateTimeFormat('en-IN', { timeZone: tz }); return true; } catch { return false; } }, 'unknown IANA timezone');
/** The fonts bundled with the frontend. It has the same list. */
export const BUNDLED_FONTS = ['Inter', 'Source Sans 3', 'Noto Sans'] as const;

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('127.0.0.1'),

  // ---- database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (runtime role hrms_app, no BYPASSRLS)'),
  DATABASE_MIGRATION_URL: z.string().optional(),
  DATABASE_SSL: z.enum(['disable', 'verify-full']).optional(),
  DATABASE_CA_FILE: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),

  // Optional cache for config and lookups. Without it the app reads the database: slower, still correct.
  /** Optional read replica: host or host:port, same database and role as DATABASE_URL. Reports and heavy reads go there. */
  DB_READ_HOST: z.string().regex(/^[A-Za-z0-9.-]+(:\d{1,5})?$/, 'must be a host or host:port').optional(),
  /** Bearer token for GET /metrics. Unset: the route does not exist. */
  METRICS_TOKEN: z.string().min(16, 'must be at least 16 characters').optional(),
  /** OTLP/HTTP endpoint for traces, such as http://collector:4318. Unset: no tracing. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis:// or rediss:// URL').optional(),

  // ---- security
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Login/password attempts per client IP per minute (account lockout is enforced separately). */
  // Per client IP across the whole API. A lab's staff often share one office NAT address, so keep this generous;
  // sign-in and password endpoints have their own strict limits (AUTH_RATE_LIMIT_PER_MINUTE).
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(60).max(100000).default(3000),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(20),
  // Sign-in attempts on one account per minute, whatever address they come from.
  AUTH_ACCOUNT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(10),
  // CSV, Excel and journal exports per user per minute. Per address, four times this.
  EXPORT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100000).default(30),
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
  /** Development: base64 of a 32-byte data key. Ignored when KMS_KEY_ID is set. */
  DATA_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32,
    'DATA_ENCRYPTION_KEY must be base64 of exactly 32 bytes (generate: openssl rand -base64 32)').optional(),
  /** Keys still needed to read old values during a rotation, comma separated. */
  DATA_ENCRYPTION_KEY_PREVIOUS: list,
  /** Production: the data key wrapped by this KMS key, unwrapped once at startup. */
  KMS_KEY_ID: z.string().optional(),
  DATA_KEY_CIPHERTEXT: z.string().optional(),
  DATA_KEY_CIPHERTEXT_PREVIOUS: list,

  // ---- processes. The API takes traffic and enqueues; the worker runs jobs and sends mail. Safe with several of each:
  // each run is claimed once in the database.
  PROCESS_ROLE: z.enum(['api', 'worker']).default('api'),
  JOBS_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),

  // ---- email (module notifications.email). On when SMTP_HOST is set and the flag is on. Credentials from env / secret store only.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: z.enum(['starttls', 'tls', 'none'], { error: 'must be starttls, tls or none' }).default('starttls'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),

  // ---- document storage (module core.documents): a local volume (Compose) or the installation's S3 bucket (AWS)
  STORAGE_DRIVER: z.enum(['disabled', 'local', 's3']).default('disabled'),
  STORAGE_PATH: z.string().optional(),
  STORAGE_MAX_FILE_MB: z.coerce.number().int().min(1).max(50).default(10),
  /** For MinIO or another S3-compatible store. */
  S3_ENDPOINT: z.url().optional(),

  // ---- malware scanning of uploads. Production with documents on refuses to start without it (see loadEnv).
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),

  // ---- security and modes. Dev leaves MFA off, production defaults to on (see loadEnv).
  MFA_AVAILABLE: z.enum(['true', 'false']).optional(),
  MFA_ENFORCED: bool('false'),
  MFA_METHODS: list,
  ORG_MANAGEMENT_MODE: z.enum(['single', 'single_hr', 'multi']).default('multi'),

  // ---- web push (notifications.push). Base64url of the raw P-256 keys; without them the feature answers feature_not_configured.
  VAPID_PUBLIC_KEY: z.string().regex(/^[A-Za-z0-9_-]+$/).refine((v) => Buffer.from(v, 'base64url').length === 65, 'must be base64url of a 65-byte P-256 public key').optional(),
  VAPID_PRIVATE_KEY: z.string().regex(/^[A-Za-z0-9_-]+$/).refine((v) => Buffer.from(v, 'base64url').length === 32, 'must be base64url of a 32-byte P-256 private key').optional(),
  VAPID_SUBJECT: z.string().regex(/^(mailto:\S+@\S+|https:\/\/\S+)$/, 'must be a mailto: or https:// contact').optional(),

  // ---- Layer 2: brand and client identity. Public: shown in the UI, page title, emails and documents.
  BRAND_NAME: z.string().trim().min(1).max(120),
  BRAND_PRODUCT_NAME: z.string().trim().min(1).max(60),
  BRAND_LEGAL_NAME: z.string().trim().max(200).optional(),
  BRAND_LOGO_URL: assetRef.optional(),
  BRAND_LOGO_DARK_URL: assetRef.optional(),
  BRAND_FAVICON_URL: assetRef.optional(),
  BRAND_PRIMARY_COLOR: hex,
  BRAND_SECONDARY_COLOR: hex.optional(),
  BRAND_ACCENT_COLOR: hex.optional(),
  BRAND_FONT_FAMILY: z.enum(BUNDLED_FONTS, { error: `must be one of the bundled fonts: ${BUNDLED_FONTS.join(', ')}` }).optional(),
  BRAND_SUPPORT_EMAIL: z.email(),
  BRAND_EMAIL_FROM: z.email(),
  BRAND_SUPPORT_PHONE: z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/, 'invalid phone number').optional(),
  BRAND_HELP_URL: z.url().refine((v) => v.startsWith('https://'), 'must be https').optional(),
  BRAND_LOGIN_MESSAGE: z.string().trim().max(300).optional(),
  /** The app's hostname. Sets the app URL and the only allowed CORS origin. */
  BRAND_DOMAIN: hostname,
  /** Other hostnames that serve this installation (comma separated). */
  BRAND_EXTRA_DOMAINS: z.string().default('').transform((v, ctx) => {
    const out = v.split(',').map((x) => x.trim()).filter(Boolean);
    for (const h of out) if (!hostname.safeParse(h).success) ctx.addIssue({ code: 'custom', message: 'must be comma-separated hostnames' });
    return out;
  }),
  BRAND_LOCALE: z.string().refine((v) => { try { return Intl.getCanonicalLocales(v).length === 1; } catch { return false; } }, 'must be a BCP 47 language tag, for example en-IN'),
  BRAND_TIMEZONE: timezone,
  BRAND_CURRENCY: z.string().regex(/^[A-Z]{3}$/, 'must be ISO 4217'),
  BRAND_DATE_FORMAT: z.enum(['DD/MM/YYYY', 'DD-MM-YYYY', 'DD-MMM-YYYY', 'YYYY-MM-DD']),
  BRAND_FINANCIAL_YEAR_START: z.string().refine((v) => {
    const m = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.exec(v);
    return !!m && new Date(Date.UTC(2024, Number(m[1]) - 1, Number(m[2]))).getUTCMonth() === Number(m[1]) - 1;
  }, 'must be MM-DD'),
  BRAND_COUNTRY: z.string().regex(/^[A-Z]{2}$/, 'must be ISO 3166-1 alpha-2'),

  /** If set, the API also serves the built web app (apps/web/dist) from this directory. */
  WEB_DIST_DIR: z.string().optional(),
  AWS_REGION: z.string().optional(),
  AWS_S3_BUCKET: z.string().optional(),
});

type ParsedEnv = z.infer<typeof schema>;
/** Parsed configuration, plus what the FEATURE_* variables resolve to and the MFA flags with their production defaults applied. */
export type Env = Omit<ParsedEnv, 'MFA_AVAILABLE'> & { MFA_AVAILABLE: boolean; enabledFeatures: ReadonlySet<string> };

/** Docker Compose passes unset optional variables as ''. Treat empty as "not set". */
const nonEmpty = (source: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));

/** Variables that must be gone: leaving one set means the deployment still believes in something that no longer exists. */
function removedVariables(source: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  if (source.ENABLED_MODULES) out.push('ENABLED_MODULES: removed; use one FEATURE_* variable per module');
  if (source.MFA_ENFORCEMENT) out.push('MFA_ENFORCEMENT: removed; use MFA_AVAILABLE and MFA_ENFORCED');
  for (const name of Object.keys(source)) if (name.startsWith('SMS_') && source[name]) out.push(`${name}: removed; there is no SMS channel`);
  return out;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const flags = resolveFeatures(source);
  const early = [...removedVariables(source), ...flags.problems];
  const parsed = schema.safeParse(nonEmpty(source));
  if (!parsed.success) {
    const issues = [...early, ...parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)].map((i) => `  - ${i}`).join('\n');
    throw new Error(`Invalid deployment configuration:\n${issues}`);
  }
  const { MFA_AVAILABLE, ...rest } = parsed.data;
  const prod = rest.NODE_ENV === 'production';
  const mfaAvailable = MFA_AVAILABLE === undefined ? prod : MFA_AVAILABLE === 'true';
  const env: Env = { ...rest, MFA_AVAILABLE: mfaAvailable, enabledFeatures: flags.features,
    MFA_METHODS: rest.MFA_METHODS.length ? rest.MFA_METHODS : ['totp', 'email'] };
  const problems: string[] = [...early];
  if (!!env.KMS_KEY_ID !== !!env.DATA_KEY_CIPHERTEXT) problems.push('Set both KMS_KEY_ID and DATA_KEY_CIPHERTEXT, or neither');
  if (!env.KMS_KEY_ID && !env.DATA_ENCRYPTION_KEY) problems.push('DATA_ENCRYPTION_KEY: set it, or KMS_KEY_ID and DATA_KEY_CIPHERTEXT (generate a key: openssl rand -base64 32)');
  if (env.MFA_ENFORCED && !env.MFA_AVAILABLE) problems.push('MFA_ENFORCED=true is invalid with MFA_AVAILABLE=false');
  // Everyone would have to enrol, in the one method nobody can complete.
  if (env.MFA_ENFORCED && !env.MFA_METHODS.includes('totp') && !(env.SMTP_HOST && env.enabledFeatures.has('notifications.email'))) problems.push('MFA_ENFORCED=true with only email codes needs SMTP_HOST and FEATURE_EMAIL_NOTIFICATIONS=true, or nobody could enrol');
  for (const m of env.MFA_METHODS) if (m !== 'totp' && m !== 'email') problems.push(`MFA_METHODS: '${m}' is not one of totp, email`);
  if (!!env.VAPID_PUBLIC_KEY !== !!env.VAPID_PRIVATE_KEY) problems.push('Set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or neither');
  if (env.NODE_ENV === 'production') {
    if (!env.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true in production (serve over HTTPS)');
    if (env.enabledFeatures.has('core.documents') && !env.CLAMAV_HOST) problems.push('CLAMAV_HOST is required in production while FEATURE_DOCUMENTS is on: uploads must be scanned');
    if (env.SMTP_SECURE === 'none') problems.push('SMTP_SECURE=none is refused in production: use starttls or tls');
    // Must be a deliberate choice: 'disable' only for a database on a private network (Docker Compose).
    if (!env.DATABASE_SSL) problems.push("DATABASE_SSL must be set explicitly in production ('verify-full', or 'disable' for a database on a private Docker network)");
  }
  if (env.STORAGE_DRIVER === 'local' && !env.STORAGE_PATH) problems.push('STORAGE_DRIVER=local needs STORAGE_PATH (a persistent volume)');
  if (env.STORAGE_DRIVER === 's3' && !env.AWS_S3_BUCKET) problems.push('STORAGE_DRIVER=s3 needs AWS_S3_BUCKET');
  if (env.STORAGE_DRIVER === 's3' && !env.AWS_REGION && !env.S3_ENDPOINT) problems.push('STORAGE_DRIVER=s3 needs AWS_REGION');
  if (!!env.SMTP_USER !== !!env.SMTP_PASSWORD) problems.push('Set both SMTP_USER and SMTP_PASSWORD, or neither');
  if (problems.length) throw new Error(`Invalid deployment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return env;
}

/** Hostnames this installation answers to: BRAND_DOMAIN + BRAND_EXTRA_DOMAINS. */
export function deploymentDomains(env: Pick<Env, 'BRAND_DOMAIN' | 'BRAND_EXTRA_DOMAINS'>): string[] {
  return [...new Set([env.BRAND_DOMAIN, ...env.BRAND_EXTRA_DOMAINS].map((d) => d.toLowerCase()))];
}

const isLocalHost = (h: string) => h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1';

/** The app's URL. BRAND_DOMAIN is a hostname, so the scheme follows: https in production, and elsewhere unless cookies are plain or it is this machine. */
export function appUrl(env: Pick<Env, 'NODE_ENV' | 'COOKIE_SECURE' | 'BRAND_DOMAIN'>): string {
  const https = env.NODE_ENV === 'production' || (env.COOKIE_SECURE && !isLocalHost(env.BRAND_DOMAIN));
  return `${https ? 'https' : 'http'}://${env.BRAND_DOMAIN}`;
}

/** Whether a browser origin may call the API: BRAND_DOMAIN only. Outside production any port, because the dev server has its own. */
export function allowedCorsOrigin(env: Pick<Env, 'NODE_ENV' | 'BRAND_DOMAIN'>, origin: string): boolean {
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  if (u.hostname !== env.BRAND_DOMAIN) return false;
  if (env.NODE_ENV === 'production') return u.protocol === 'https:' && !u.port;
  return u.protocol === 'https:' || u.protocol === 'http:';
}

/** The organization's name at bootstrap and on every start. */
export const organizationName = (env: Pick<Env, 'BRAND_NAME' | 'BRAND_LEGAL_NAME'>) => env.BRAND_LEGAL_NAME ?? env.BRAND_NAME;

/** The subset of deployment configuration needed by the bootstrap task (which has no runtime secrets). */
export const installationSchema = schema.pick({ NODE_ENV: true, COOKIE_SECURE: true, BRAND_DOMAIN: true, BRAND_EXTRA_DOMAINS: true, BRAND_NAME: true, BRAND_LEGAL_NAME: true, BRAND_TIMEZONE: true });
export type InstallationEnv = z.infer<typeof installationSchema>;
export function loadInstallationEnv(source: NodeJS.ProcessEnv = process.env): InstallationEnv {
  const parsed = installationSchema.safeParse(nonEmpty(source));
  if (!parsed.success) throw new Error(`Invalid deployment configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  return parsed.data;
}
