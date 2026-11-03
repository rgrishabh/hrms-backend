import { describe, it, expect } from 'vitest';
import { loadEnv, deploymentDomains } from '../src/config/env.js';
import { buildPublicConfig } from '../src/config/installation.js';

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
    const e = loadEnv({ ...base, BRAND_LOGO_URL: '', BRAND_SUPPORT_EMAIL: '', ENABLED_MODULES: '', DATABASE_SSL: '' });
    expect(e.BRAND_LOGO_URL).toBeUndefined();
    expect(e.BRAND_SUPPORT_EMAIL).toBeUndefined();
    expect(e.ENABLED_MODULES).toBe('default');
    expect(e.DATABASE_SSL).toBeUndefined();
  });
});
