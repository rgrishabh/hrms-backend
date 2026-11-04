import { describe, it, expect } from 'vitest';
import { loadEnv, deploymentDomains } from '../src/config/env.js';
import { buildPublicConfig } from '../src/config/installation.js';
import { FEATURE_BY_ENV, FEATURE_MAP } from '../src/core/features/registry.js';

const KEY = Buffer.alloc(32, 9).toString('base64');
const base = { DATABASE_URL: 'postgres://hrms_app:pw@db:5432/hrms', DATA_ENCRYPTION_KEY: KEY };
const prod = { ...base, NODE_ENV: 'production', APP_URL: 'https://hrms.customer-a.in', DATABASE_SSL: 'disable' };

describe('deployment configuration', () => {
  it('applies safe defaults for non-sensitive settings only', () => {
    const e = loadEnv(base);
    expect(e).toMatchObject({ PRODUCT_NAME: 'LabHRMS', ORGANIZATION_COUNTRY: 'IN', ORGANIZATION_CURRENCY: 'INR', ORGANIZATION_TIMEZONE: 'Asia/Kolkata', ORGANIZATION_FY_START_MONTH: 4 });
  });

  it('requires the database URL and a proper encryption key, never defaulting secrets', () => {
    expect(() => loadEnv({ DATA_ENCRYPTION_KEY: KEY })).toThrow(/DATABASE_URL/);
    expect(() => loadEnv({ DATABASE_URL: 'x' })).toThrow(/DATA_ENCRYPTION_KEY/);
    expect(() => loadEnv({ ...base, DATA_ENCRYPTION_KEY: 'short' })).toThrow(/exactly 32 bytes/);
  });

  it('lists every invalid field in one actionable error, without echoing values', () => {
    try {
      loadEnv({ ...base, BRAND_PRIMARY_COLOR: 'green', ORGANIZATION_TIMEZONE: 'Mars/Base', BRAND_SUPPORT_EMAIL: 'nope', ORGANIZATION_FY_START_MONTH: '13' });
      throw new Error('should have failed');
    } catch (e) {
      const m = (e as Error).message;
      for (const f of ['BRAND_PRIMARY_COLOR', 'ORGANIZATION_TIMEZONE', 'BRAND_SUPPORT_EMAIL', 'ORGANIZATION_FY_START_MONTH']) expect(m).toContain(f);
      expect(m).not.toContain(KEY);
    }
  });

  it('accepts only https or /branding/ asset references, and needs BRANDING_DIR for the latter', () => {
    expect(() => loadEnv({ ...base, BRAND_LOGO_URL: 'http://insecure/logo.png' })).toThrow(/BRAND_LOGO_URL/);
    expect(() => loadEnv({ ...base, BRAND_LOGO_URL: 'javascript:alert(1)' })).toThrow(/BRAND_LOGO_URL/);
    expect(() => loadEnv({ ...base, BRAND_LOGO_URL: '/branding/../etc/passwd' })).toThrow(/BRAND_LOGO_URL/);
    expect(() => loadEnv({ ...base, BRAND_LOGO_URL: '/branding/logo.svg' })).toThrow(/BRANDING_DIR/);
    expect(loadEnv({ ...base, BRAND_LOGO_URL: '/branding/logo.svg', BRANDING_DIR: '/app/branding' }).BRAND_LOGO_URL).toBe('/branding/logo.svg');
  });

  it('enforces production rules', () => {
    expect(() => loadEnv(prod)).not.toThrow();
    expect(() => loadEnv({ ...prod, APP_URL: 'http://hrms.customer-a.in' })).toThrow(/APP_URL must be https/);
    expect(() => loadEnv({ ...prod, COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    const { DATABASE_SSL: _omit, ...noSsl } = prod;
    expect(() => loadEnv(noSsl)).toThrow(/DATABASE_SSL must be set explicitly/);
  });

  it('derives the installation domains from APP_URL and APP_EXTRA_DOMAINS', () => {
    expect(deploymentDomains(loadEnv({ ...base, APP_URL: 'https://HRMS.Customer-A.in:8443/x', APP_EXTRA_DOMAINS: 'hr.customer-a.in, HRMS.customer-a.in' })))
      .toEqual(['hrms.customer-a.in', 'hr.customer-a.in']);
  });

  it('public config falls back sensibly and never includes secrets or connection details', () => {
    const cfg = buildPublicConfig(loadEnv({ ...base, ORGANIZATION_NAME: 'Customer A Testing Laboratories' }));
    expect(cfg.brand).toMatchObject({ name: 'Customer A Testing Laboratories', shortName: 'Customer A Testing Laboratories', logoUrl: null });
    expect(cfg.organization.legalName).toBe('Customer A Testing Laboratories');
    const json = JSON.stringify(cfg);
    expect(json).not.toContain('postgres://');
    expect(json).not.toContain(KEY);
  });
});

describe('docker compose style environment', () => {
  it('treats empty optional variables as unset', () => {
    const e = loadEnv({ ...base, BRAND_LOGO_URL: '', BRAND_SUPPORT_EMAIL: '', FEATURE_LEAVE: '', ENABLED_MODULES: '', DATABASE_SSL: '' });
    expect(e.BRAND_LOGO_URL).toBeUndefined();
    expect(e.BRAND_SUPPORT_EMAIL).toBeUndefined();
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
    expect(problems({ MFA_METHODS: 'totp,sms-otp' })).toMatch(/MFA_METHODS/);
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
