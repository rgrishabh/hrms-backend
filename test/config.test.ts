import { describe, it, expect } from 'vitest';
import { loadEnv, deploymentDomains, appUrl, organizationName } from '../src/config/env.js';
import { smtpSecurity } from '../src/core/notify/mailer.js';
import { TEST_BRAND } from './env.js';
import { buildPublicConfig } from '../src/config/installation.js';
import { FEATURE_BY_ENV, FEATURE_MAP } from '../src/core/features/registry.js';

const KEY = Buffer.alloc(32, 9).toString('base64');
const base = { DATABASE_URL: 'postgres://hrms_app:pw@db:5432/hrms', DATA_ENCRYPTION_KEY: KEY, ...TEST_BRAND };
const prod = { ...base, NODE_ENV: 'production', BRAND_DOMAIN: 'hrms.customer-a.in', DATABASE_SSL: 'disable' };

describe('deployment configuration', () => {
  it('requires everything the contract marks as required in Layer 2, naming each', () => {
    const { DATABASE_URL, DATA_ENCRYPTION_KEY } = base;
    try { loadEnv({ DATABASE_URL, DATA_ENCRYPTION_KEY }); throw new Error('should have failed'); } catch (e) {
      for (const k of Object.keys(TEST_BRAND)) expect((e as Error).message).toContain(k);
    }
  });

  it('requires the database URL and a proper encryption key, never defaulting secrets', () => {
    expect(() => loadEnv({ ...TEST_BRAND, DATA_ENCRYPTION_KEY: KEY })).toThrow(/DATABASE_URL/);
    expect(() => loadEnv({ ...TEST_BRAND, DATABASE_URL: 'x' })).toThrow(/DATA_ENCRYPTION_KEY/);
    expect(() => loadEnv({ ...base, DATA_ENCRYPTION_KEY: 'short' })).toThrow(/exactly 32 bytes/);
  });

  it('lists every invalid field in one actionable error, without echoing values', () => {
    try {
      loadEnv({ ...base, BRAND_PRIMARY_COLOR: 'green', BRAND_TIMEZONE: 'Mars/Base', BRAND_SUPPORT_EMAIL: 'nope', BRAND_FINANCIAL_YEAR_START: '13-01' });
      throw new Error('should have failed');
    } catch (e) {
      const m = (e as Error).message;
      for (const f of ['BRAND_PRIMARY_COLOR', 'BRAND_TIMEZONE', 'BRAND_SUPPORT_EMAIL', 'BRAND_FINANCIAL_YEAR_START']) expect(m).toContain(f);
      expect(m).not.toContain(KEY);
    }
  });

  it('accepts only https or /brand/ asset references', () => {
    for (const k of ['BRAND_LOGO_URL', 'BRAND_LOGO_DARK_URL', 'BRAND_FAVICON_URL']) {
      expect(() => loadEnv({ ...base, [k]: 'http://insecure/logo.png' })).toThrow(new RegExp(k));
      expect(() => loadEnv({ ...base, [k]: 'javascript:alert(1)' })).toThrow(new RegExp(k));
      expect(() => loadEnv({ ...base, [k]: '/brand/../etc/passwd' })).toThrow(new RegExp(k));
      expect(() => loadEnv({ ...base, [k]: '/branding/logo.svg' })).toThrow(new RegExp(k));
    }
    expect(loadEnv({ ...base, BRAND_LOGO_URL: '/brand/logo.svg', BRAND_FAVICON_URL: 'https://cdn.example.test/f.ico' }).BRAND_LOGO_URL).toBe('/brand/logo.svg');
  });

  it('validates the other brand values', () => {
    expect(() => loadEnv({ ...base, BRAND_NAME: 'x'.repeat(121) })).toThrow(/BRAND_NAME/);
    expect(() => loadEnv({ ...base, BRAND_PRODUCT_NAME: 'x'.repeat(61) })).toThrow(/BRAND_PRODUCT_NAME/);
    expect(() => loadEnv({ ...base, BRAND_LEGAL_NAME: 'x'.repeat(201) })).toThrow(/BRAND_LEGAL_NAME/);
    expect(() => loadEnv({ ...base, BRAND_FONT_FAMILY: 'Comic Sans' })).toThrow(/BRAND_FONT_FAMILY/);
    expect(loadEnv({ ...base, BRAND_FONT_FAMILY: 'Noto Sans' }).BRAND_FONT_FAMILY).toBe('Noto Sans');
    expect(() => loadEnv({ ...base, BRAND_DOMAIN: 'https://a.example.com' })).toThrow(/BRAND_DOMAIN/);
    expect(() => loadEnv({ ...base, BRAND_DOMAIN: 'a.example.com:8443' })).toThrow(/BRAND_DOMAIN/);
    expect(() => loadEnv({ ...base, BRAND_EXTRA_DOMAINS: 'ok.example.com,not a host' })).toThrow(/BRAND_EXTRA_DOMAINS/);
    expect(() => loadEnv({ ...base, BRAND_LOCALE: 'not_a_locale' })).toThrow(/BRAND_LOCALE/);
    expect(() => loadEnv({ ...base, BRAND_CURRENCY: 'rupees' })).toThrow(/BRAND_CURRENCY/);
    expect(() => loadEnv({ ...base, BRAND_COUNTRY: 'India' })).toThrow(/BRAND_COUNTRY/);
    expect(() => loadEnv({ ...base, BRAND_DATE_FORMAT: 'MM/DD/YY' })).toThrow(/BRAND_DATE_FORMAT/);
    expect(() => loadEnv({ ...base, BRAND_FINANCIAL_YEAR_START: '02-31' })).toThrow(/BRAND_FINANCIAL_YEAR_START/);
    expect(loadEnv({ ...base, BRAND_FINANCIAL_YEAR_START: '02-29' }).BRAND_FINANCIAL_YEAR_START).toBe('02-29');
  });

  it('SMTP_SECURE takes the contract\'s values; production refuses none; credentials come as a pair', () => {
    expect(loadEnv(base).SMTP_SECURE).toBe('starttls');
    expect(() => loadEnv({ ...base, SMTP_SECURE: 'true' })).toThrow(/SMTP_SECURE: must be starttls, tls or none/);
    expect(loadEnv({ ...base, SMTP_SECURE: 'none' }).SMTP_SECURE).toBe('none');
    expect(() => loadEnv({ ...prod, SMTP_SECURE: 'none' })).toThrow(/SMTP_SECURE=none is refused in production/);
    expect(() => loadEnv({ ...base, SMTP_USER: 'u' })).toThrow(/both SMTP_USER and SMTP_PASSWORD/);
    expect(smtpSecurity('tls')).toEqual({ secure: true });
    expect(smtpSecurity('starttls')).toEqual({ secure: false, requireTLS: true });
    expect(smtpSecurity('none')).toEqual({ secure: false, ignoreTLS: true });
  });

  it('enforces production rules', () => {
    expect(() => loadEnv(prod)).not.toThrow();
    expect(appUrl(loadEnv(prod))).toBe('https://hrms.customer-a.in');
    expect(() => loadEnv({ ...prod, COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    const { DATABASE_SSL: _omit, ...noSsl } = prod;
    expect(() => loadEnv(noSsl)).toThrow(/DATABASE_SSL must be set explicitly/);
  });

  it('derives the installation domains and URL from BRAND_DOMAIN', () => {
    const e = loadEnv({ ...base, BRAND_DOMAIN: 'HRMS.Customer-A.in', BRAND_EXTRA_DOMAINS: 'hr.customer-a.in, HRMS.customer-a.in' });
    expect(deploymentDomains(e)).toEqual(['hrms.customer-a.in', 'hr.customer-a.in']);
    expect(appUrl(e)).toBe('https://hrms.customer-a.in');
    expect(appUrl(loadEnv({ ...base, BRAND_DOMAIN: 'localhost' }))).toBe('http://localhost');
    expect(appUrl(loadEnv({ ...base, BRAND_DOMAIN: 'dev.example.test', COOKIE_SECURE: 'false' }))).toBe('http://dev.example.test');
  });

  it('the organization name is the legal name when there is one, else the brand name', () => {
    expect(organizationName({ BRAND_NAME: 'Acme', BRAND_LEGAL_NAME: undefined })).toBe('Acme');
    expect(organizationName({ BRAND_NAME: 'Acme', BRAND_LEGAL_NAME: 'Acme Testing Pvt Ltd' })).toBe('Acme Testing Pvt Ltd');
  });

  it('public config has the contract\'s shape and never includes secrets, connection details or descriptions', () => {
    const cfg = buildPublicConfig(loadEnv({ ...base, BRAND_NAME: 'Customer A', BRAND_PRODUCT_NAME: 'CustomerHR', FEATURE_LOANS: 'false' }));
    expect(Object.keys(cfg).sort()).toEqual(['brand', 'features', 'mfa', 'mode', 'product']);
    expect(cfg.product).toEqual({ name: 'CustomerHR' });
    expect(cfg.brand).toMatchObject({ name: 'Customer A', legalName: 'Customer A', logoUrl: null, logoDarkUrl: null, fontFamily: null, locale: 'en-IN', domain: 'localhost' });
    expect(cfg.mode).toBe('multi');
    expect(cfg.mfa).toEqual({ available: false, enforced: false, methods: [] });
    expect(cfg.features.FEATURE_LEAVE).toBe(true);
    expect(cfg.features.FEATURE_LOANS).toBe(false);
    expect(Object.keys(cfg.features)).toHaveLength(35);
    const json = JSON.stringify(cfg);
    expect(json).not.toContain('postgres://');
    expect(json).not.toContain(KEY);
    expect(json).not.toMatch(/instalments|description/i);
  });
});

describe('docker compose style environment', () => {
  it('treats empty optional variables as unset', () => {
    const e = loadEnv({ ...base, BRAND_LOGO_URL: '', BRAND_HELP_URL: '', FEATURE_LEAVE: '', ENABLED_MODULES: '', DATABASE_SSL: '' });
    expect(e.BRAND_LOGO_URL).toBeUndefined();
    expect(e.BRAND_HELP_URL).toBeUndefined();
    expect(e.enabledFeatures.has('leave')).toBe(true);
    expect(e.DATABASE_SSL).toBeUndefined();
  });
});

describe('feature flags', () => {
  const problems = (env: Record<string, string>) => { try { loadEnv({ ...base, ...env }); return ''; } catch (e) { return (e as Error).message; } };

  it('every flag of the contract is in the registry with the contract default and dependencies', () => {
    const table: [string, boolean, string[]][] = [
      ['FEATURE_DOCUMENTS', true, []], ['FEATURE_ONBOARDING', false, []], ['FEATURE_OFFBOARDING', false, []], ['FEATURE_POLICIES', false, []],
      ['FEATURE_ATTENDANCE', true, []], ['FEATURE_ATTENDANCE_WEB', true, ['ATTENDANCE']], ['FEATURE_ATTENDANCE_MOBILE', false, ['ATTENDANCE']],
      ['FEATURE_ATTENDANCE_GEOFENCE', false, ['ATTENDANCE']], ['FEATURE_ATTENDANCE_SELFIE', false, ['ATTENDANCE']], ['FEATURE_ATTENDANCE_BIOMETRIC', false, ['ATTENDANCE']],
      ['FEATURE_ATTENDANCE_REGULARIZATION', true, ['ATTENDANCE']], ['FEATURE_SHIFTS', true, ['ATTENDANCE']], ['FEATURE_HOLIDAYS', true, ['ATTENDANCE']], ['FEATURE_LEAVE', true, []],
      ['FEATURE_OVERTIME', false, ['ATTENDANCE']], ['FEATURE_COMP_OFF', false, ['LEAVE', 'OVERTIME']], ['FEATURE_FIELD_DUTY', false, ['ATTENDANCE']], ['FEATURE_PAYROLL', false, ['ATTENDANCE']],
      ['FEATURE_PAYSLIPS', false, ['PAYROLL']], ['FEATURE_PAYROLL_STATUTORY', false, ['PAYROLL']], ['FEATURE_LOANS', false, ['PAYROLL']], ['FEATURE_SALARY_ADVANCE', false, ['PAYROLL']],
      ['FEATURE_ACCOUNTING_EXPORTS', false, ['PAYROLL']], ['FEATURE_EXPENSE_CLAIMS', false, []], ['FEATURE_TRAVEL', false, ['EXPENSE_CLAIMS']], ['FEATURE_RECRUITMENT', false, []],
      ['FEATURE_PERFORMANCE_REVIEW', false, []], ['FEATURE_TRAINING', false, []], ['FEATURE_LAB_COMPETENCY', false, ['TRAINING']], ['FEATURE_ASSET_MANAGEMENT', false, []],
      ['FEATURE_GRIEVANCE', false, []], ['FEATURE_POSH', false, []], ['FEATURE_REPORTS_ADVANCED', false, []], ['FEATURE_EMAIL_NOTIFICATIONS', true, []], ['FEATURE_PUSH_NOTIFICATIONS', false, []],
    ];
    expect([...FEATURE_BY_ENV.keys()].sort()).toEqual(table.map((t) => t[0]).sort());
    for (const [name, def, deps] of table) {
      const d = FEATURE_BY_ENV.get(name)!;
      expect([name, d.defaultEnabled]).toEqual([name, def]);
      expect([name, d.dependencies.filter((k) => !FEATURE_MAP.get(k)!.core).map((k) => FEATURE_MAP.get(k)!.envName!.replace('FEATURE_', '')).sort()]).toEqual([name, [...deps].sort()]);
    }
  });

  it('refuses a typo, a value other than true or false, and a feature on without what it needs, all at once', () => {
    const m = problems({ FEATURE_PAYROL: 'true', FEATURE_LEAVE: 'yes', FEATURE_PAYSLIPS: 'true' });
    expect(m).toMatch(/FEATURE_PAYROL: not a known feature flag/);
    expect(m).toMatch(/FEATURE_LEAVE: must be true or false/);
    expect(m).toMatch(/FEATURE_PAYSLIPS: is on but requires FEATURE_PAYROLL/);
  });

  it('a feature on by default still needs what it depends on', () => {
    expect(problems({ FEATURE_ATTENDANCE: 'false' })).toMatch(/FEATURE_ATTENDANCE_WEB: is on by default but requires FEATURE_ATTENDANCE/);
  });

  it('comp off needs both leave and overtime', () => {
    expect(problems({ FEATURE_COMP_OFF: 'true' })).toMatch(/FEATURE_COMP_OFF: is on but requires FEATURE_OVERTIME/);
    expect(problems({ FEATURE_COMP_OFF: 'true', FEATURE_OVERTIME: 'true', FEATURE_LEAVE: 'false' })).toMatch(/requires FEATURE_LEAVE/);
    expect(problems({ FEATURE_COMP_OFF: 'true', FEATURE_OVERTIME: 'true' })).toBe('');
  });

  it('refuses the removed variables', () => {
    expect(problems({ ENABLED_MODULES: 'default' })).toMatch(/ENABLED_MODULES: removed/);
    expect(problems({ MFA_ENFORCEMENT: 'off' })).toMatch(/MFA_ENFORCEMENT: removed/);
    expect(problems({ SMS_TRANSPORT: 'log' })).toMatch(/SMS_TRANSPORT: removed/);
    expect(problems({ SMS_HTTP_URL: '' })).toBe('');
  });

  it('MFA flags: enforced needs available, methods are a subset, production defaults are on', () => {
    expect(problems({ MFA_AVAILABLE: 'false', MFA_ENFORCED: 'true' })).toMatch(/MFA_ENFORCED=true is invalid with MFA_AVAILABLE=false/);
    expect(problems({ MFA_METHODS: 'totp,carrier-pigeon' })).toMatch(/MFA_METHODS/);
    expect(loadEnv(base).MFA_AVAILABLE).toBe(false);
    expect(loadEnv(prod)).toMatchObject({ MFA_AVAILABLE: true, MFA_ENFORCED: false, MFA_METHODS: ['totp', 'email'] });
  });

  it('VAPID keys come as a pair, in the right shape', () => {
    const pub = Buffer.alloc(65, 4).toString('base64url');
    const priv = Buffer.alloc(32, 5).toString('base64url');
    expect(problems({ VAPID_PUBLIC_KEY: pub })).toMatch(/both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY/);
    expect(problems({ VAPID_PUBLIC_KEY: 'short', VAPID_PRIVATE_KEY: priv })).toMatch(/VAPID_PUBLIC_KEY/);
    expect(problems({ VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv })).toBe('');
  });
});
