import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { appUrl, loadEnv, loadInstallationEnv } from '../src/config/env.js';
import { demoLoginBanner } from '../src/db/demo.js';
import { setMailer, type OutgoingMail } from '../src/core/notify/mailer.js';
import { deliverOutbox } from '../src/core/notify/service.js';
import { Client, createTenant, makeApp, ownerQuery, type TenantFixture } from './helpers.js';
import { TEST_BRAND } from './env.js';

const base = { ...TEST_BRAND, DATABASE_URL: 'postgres://x@127.0.0.1/x', COOKIE_SECURE: 'false', DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };

describe('PUBLIC_URL', () => {
  it('is the app URL, whole', () => {
    expect(appUrl(loadEnv({ ...base, PUBLIC_URL: 'http://localhost:8088' }))).toBe('http://localhost:8088');
    expect(appUrl(loadEnv({ ...base, PUBLIC_URL: 'http://localhost:8088/' }))).toBe('http://localhost:8088');
    expect(appUrl(loadInstallationEnv({ ...base, PUBLIC_URL: 'http://localhost:8088' }))).toBe('http://localhost:8088');
  });

  it('left out, the URL still follows from BRAND_DOMAIN', () => {
    expect(appUrl(loadEnv({ ...base, PUBLIC_URL: '' }))).toBe('http://localhost');
  });

  it.each([
    ['not a url', /PUBLIC_URL/],
    ['ftp://localhost', /PUBLIC_URL/],
    ['localhost:8088', /PUBLIC_URL/],
    ['http://localhost:8088/app', /PUBLIC_URL/],
    ['http://localhost:8088/?a=1', /PUBLIC_URL/],
    ['http://user:pw@localhost:8088', /PUBLIC_URL/],
    ['http://evil.example:8088', /PUBLIC_URL.*BRAND_DOMAIN/],
  ])('refuses %s', (value, message) => {
    expect(() => loadEnv({ ...base, PUBLIC_URL: value })).toThrow(message);
    expect(() => loadInstallationEnv({ ...base, PUBLIC_URL: value })).toThrow(message);
  });

  it('a production installation is on https', () => {
    const prod = { ...base, NODE_ENV: 'production', COOKIE_SECURE: 'true', DATABASE_SSL: 'disable', FEATURE_DOCUMENTS: 'false', BRAND_DOMAIN: 'hr.customer.test' };
    expect(() => loadEnv({ ...prod, PUBLIC_URL: 'http://hr.customer.test' })).toThrow(/PUBLIC_URL.*https/);
    expect(appUrl(loadEnv({ ...prod, PUBLIC_URL: 'https://hr.customer.test:8443' }))).toBe('https://hr.customer.test:8443');
  });
});

describe('links in email', () => {
  let app: FastifyInstance;
  let T: TenantFixture;
  const sent: OutgoingMail[] = [];
  const SILENT = { error: () => undefined };
  beforeAll(async () => {
    app = await makeApp({ PUBLIC_URL: 'http://localhost:8088' }, { mailerOverride: true });
    setMailer({
      send: async (m: OutgoingMail) => {
        sent.push(m);
        return { messageId: 'x' };
      },
    } as never);
    T = await createTenant();
  });
  afterAll(() => app.close());

  it('a password reset keeps the port', async () => {
    const email = T.users.employee!.email;
    await app.inject({ method: 'POST', url: '/api/v1/auth/password/forgot', payload: { email }, headers: { host: T.host } });
    await deliverOutbox(app.deps.pool, SILENT);
    const mail = sent.find((m) => m.to === email)!;
    expect(mail.text).toMatch(/http:\/\/localhost:8088\/reset-password#token=[A-Za-z0-9_-]+/);
    expect(mail.html).toContain('href="http://localhost:8088/reset-password#token=');
  });

  it('an invitation keeps the port', async () => {
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    const r = await admin.post('/api/v1/tenant/users', { email: `new@${T.host}`, displayName: 'New Person', roles: ['employee'] });
    expect(r.statusCode, r.body).toBe(201);
    await deliverOutbox(app.deps.pool, SILENT);
    expect(sent.find((m) => m.to === `new@${T.host}`)!.text).toMatch(/http:\/\/localhost:8088\/setup#token=/);
  });

  it('every other mail keeps the port', async () => {
    const { notifyUsers } = await import('../src/core/notify/service.js');
    const { withTenant } = await import('../src/db/tx.js');
    const { inApp } = await import('./helpers.js');
    const to = T.users.hr!;
    await inApp(app, () =>
      withTenant(app.deps.pool, T.id, (db) =>
        notifyUsers(db, T.id, [to.id], { kind: 'test.link', title: 'Look', body: 'At this', link: '/approvals', feature: 'notifications.email' } as never),
      ),
    );
    await deliverOutbox(app.deps.pool, SILENT);
    const [row] = await ownerQuery<{ text_body: string }>(`SELECT text_body FROM email_outbox WHERE to_email=$1 AND kind='test.link'`, [to.email]);
    expect(row!.text_body).toContain('http://localhost:8088/approvals');
  });
});

describe('the demo credentials say where to go', () => {
  const logins = [{ login: 'a@x.test', name: 'A', role: 'R' }];
  it('the configured URL, as is', () => {
    expect(demoLoginBanner({ PUBLIC_URL: 'http://localhost:8088', BRAND_DOMAIN: 'localhost', COOKIE_SECURE: 'false' }, 'x.test', 'pw', logins)).toContain(
      'http://localhost:8088\n',
    );
  });
  it('an HTTP stack is not called https', () => {
    expect(demoLoginBanner({ BRAND_DOMAIN: 'localhost', COOKIE_SECURE: 'false', NODE_ENV: 'development' }, 'x.test', 'pw', logins)).toContain('http://localhost\n');
  });
  it('with no BRAND_DOMAIN in its environment, the domain the data was generated for', () => {
    expect(demoLoginBanner({}, 'demo.example.test', 'pw', logins)).toContain('https://demo.example.test\n');
  });
  it('an HTTPS one is', () => {
    expect(demoLoginBanner({ BRAND_DOMAIN: 'hr.customer.test', NODE_ENV: 'production' }, 'x.test', 'pw', logins)).toContain('https://hr.customer.test\n');
  });
});
