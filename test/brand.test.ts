import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, flags, inApp, type TenantFixture, seal } from './helpers.js';
import { TEST_APP_URL, TEST_BRAND } from './env.js';
import { loadEnv, allowedCorsOrigin } from '../src/config/env.js';
import { createMailer, getFrom } from '../src/core/notify/mailer.js';
import { S3Store } from '../src/core/storage/index.js';
import { money, setBrandFormats } from '../src/core/brand.js';
import { renderEmail } from '../src/core/notify/templates.js';
import { withTenant } from '../src/db/tx.js';
import { notifyUsers } from '../src/core/notify/service.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const envOf = (o: Record<string, string> = {}) => loadEnv({ DATABASE_URL: TEST_APP_URL, DATA_ENCRYPTION_KEY: KEY, ...TEST_BRAND, ...o });

describe('CORS', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await makeApp({ BRAND_DOMAIN: 'hrms.acme.test', NODE_ENV: 'production', DATABASE_SSL: 'disable', COOKIE_SECURE: 'true' }); });
  afterAll(async () => { await app.close(); });
  const preflight = (origin: string) => app.inject({ method: 'OPTIONS', url: '/api/v1/config/public', headers: { host: 'hrms.acme.test', origin, 'access-control-request-method': 'POST' } });

  it('BRAND_DOMAIN alone may call the API from a browser, with cookies', async () => {
    const ok = await preflight('https://hrms.acme.test');
    expect(ok.headers['access-control-allow-origin']).toBe('https://hrms.acme.test');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    for (const bad of ['https://evil.example.com', 'http://hrms.acme.test', 'https://hrms.acme.test:8443', 'https://hrms.acme.test.evil.com', 'null']) {
      expect([bad, (await preflight(bad)).headers['access-control-allow-origin']]).toEqual([bad, undefined]);
    }
  });

  it('outside production, any port on that host, for the dev server', () => {
    expect(allowedCorsOrigin({ NODE_ENV: 'development', BRAND_DOMAIN: 'localhost' }, 'http://localhost:5173')).toBe(true);
    expect(allowedCorsOrigin({ NODE_ENV: 'development', BRAND_DOMAIN: 'localhost' }, 'http://evil.test:5173')).toBe(false);
  });
});

describe('/brand files', () => {
  let app: FastifyInstance; let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'hrms-brand-'));
    writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(path.join(dir, 'secret.txt'), 'no');
    app = await makeApp({ BRAND_LOGO_DARK_URL: '/brand/logo.png' }, { brandDirOverride: dir });
  });
  afterAll(async () => { await app.close(); });

  it('are served from the mount, sandboxed; only images; the old path is gone', async () => {
    const r = await app.inject({ url: '/brand/logo.png', headers: { host: 'x' } });
    expect([r.statusCode, r.headers['content-type']]).toEqual([200, 'image/png']);
    expect(r.headers['content-security-policy']).toContain('sandbox');
    expect((await app.inject({ url: '/brand/secret.txt', headers: { host: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ url: '/branding/logo.png', headers: { host: 'x' } })).statusCode).toBe(404);
  });

  it('a /brand reference to a file that is not there stops the start; the dark logo counts', async () => {
    await expect(makeApp({ BRAND_LOGO_DARK_URL: '/brand/none.png' }, { brandDirOverride: dir })).rejects.toThrow(/none\.png not found/);
  });

  it('without the mount, there are simply no files', async () => {
    const a = await makeApp({}, { brandDirOverride: path.join(dir, 'absent') });
    expect((await a.inject({ url: '/brand/logo.png', headers: { host: 'x' } })).statusCode).toBe(404);
    await a.close();
  });
});

describe('SSRF', () => {
  it('a logo at any URL is never fetched by the server, at startup, on the config route or in an email', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const app = await makeApp({ ...flags('default'), BRAND_LOGO_URL: 'https://169.254.169.254/latest/meta-data', BRAND_LOGO_DARK_URL: 'https://internal.example.test/a.png', BRAND_FAVICON_URL: 'https://localhost:9/f.ico' }, { brandDirOverride: '/nonexistent' });
    const T = await createTenant();
    expect((await new Client(app, T.host).get('/api/v1/config/public')).json().brand.logoUrl).toBe('https://169.254.169.254/latest/meta-data');
    await inApp(app, () => withTenant(app.deps.pool, T.id, (db) => notifyUsers(db, T.id, [T.users.hr!.id], { kind: 'x.y', title: 'Hello' })));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    await app.close();
  });
});

describe('the config route', () => {
  it('is at /api/v1/config/public; the old address is gone; no auth', async () => {
    const app = await makeApp({ ...flags('default'), FEATURE_PAYROLL: 'false' });
    const T: TenantFixture = await createTenant();
    const anon = new Client(app, T.host);
    const r = await anon.get('/api/v1/config/public');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ product: { name: 'TestHRMS' }, features: { FEATURE_LEAVE: true, FEATURE_PAYROLL: false }, mode: 'multi', mfa: { available: false, enforced: false, methods: [] } });
    expect((await anon.get('/api/v1/public/config')).statusCode).toBe(404);
    await app.close();
  });
});

describe('SMTP', () => {
  /** Speaks enough SMTP to accept one message, and offers STARTTLS like a real server: Mailpit needs SMTP_SECURE=none to mean "do not try". */
  function fakeSmtp() {
    const seen: string[] = [];
    let inData = false;
    const server = createNetServer((sock) => {
      sock.write('220 fake ESMTP\r\n');
      sock.on('data', (buf) => {
        for (const line of buf.toString().split('\r\n').filter(Boolean)) {
          if (inData) { seen.push(line); if (line === '.') { inData = false; sock.write('250 ok\r\n'); } continue; }
          seen.push(line);
          if (line.startsWith('EHLO')) sock.write('250-fake\r\n250-STARTTLS\r\n250 OK\r\n');
          else if (line === 'DATA') { inData = true; sock.write('354 go\r\n'); }
          else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
          else if (line === 'STARTTLS') sock.write('454 no\r\n');
          else sock.write('250 ok\r\n');
        }
      });
    });
    return new Promise<{ port: number; seen: string[]; close: () => void }>((res) => server.listen(0, '127.0.0.1', () => res({ port: (server.address() as AddressInfo).port, seen, close: () => server.close() })));
  }

  it('none sends in the clear without ever trying STARTTLS, from the brand address in the product\'s name', async () => {
    const s = await fakeSmtp();
    const mailer = createMailer(envOf({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(s.port), SMTP_SECURE: 'none', BRAND_PRODUCT_NAME: 'Acme HR', BRAND_EMAIL_FROM: 'hr@acme.test' }))!;
    expect(getFrom()).toBe('"Acme HR" <hr@acme.test>');
    await mailer.send({ from: getFrom(), to: 'a@example.test', subject: 'Hi', text: 'Body', html: '<p>Body</p>' });
    s.close();
    expect(s.seen).not.toContain('STARTTLS');
    expect(s.seen.some((l) => l.startsWith('MAIL FROM:<hr@acme.test>'))).toBe(true);
    expect(s.seen.some((l) => l.includes('Acme HR') && l.startsWith('From:'))).toBe(true);
  });

  it('starttls refuses to send when the upgrade fails', async () => {
    const s = await fakeSmtp();
    const mailer = createMailer(envOf({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(s.port), SMTP_SECURE: 'starttls' }))!;
    await expect(mailer.send({ from: getFrom(), to: 'a@example.test', subject: 'Hi', text: 'Body', html: 'x' })).rejects.toThrow();
    s.close();
    expect(s.seen).toContain('STARTTLS');
    expect(s.seen.some((l) => l.startsWith('MAIL FROM'))).toBe(false);
  });

  it('email is on only with SMTP_HOST set and the flag on', () => {
    expect(createMailer(envOf())).toBeNull();
    expect(createMailer(envOf({ SMTP_HOST: 'mail.test', FEATURE_EMAIL_NOTIFICATIONS: 'false' }))).toBeNull();
    expect(createMailer(envOf({ SMTP_HOST: 'mail.test' }))).not.toBeNull();
  });
});

describe('S3_ENDPOINT', () => {
  it('talks to that endpoint, path style, with no KMS header (MinIO)', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'minio-test-key');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'minio-test-secret');
    const seen: { url: string; sse: string | undefined }[] = [];
    const server = createHttpServer((req, res) => { seen.push({ url: req.url!, sse: req.headers['x-amz-server-side-encryption'] as string | undefined }); req.resume(); req.on('end', () => { res.setHeader('etag', '"x"'); res.end(); }); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const store = new S3Store('hrms-documents', 'us-east-1', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const key = '00000000-0000-4000-8000-000000000001/company/00000000-0000-4000-8000-000000000002';
    await store.put(key, Buffer.from('x'), 'text/plain');
    server.close();
    vi.unstubAllEnvs();
    expect(seen[0]!.url.split('?')[0]).toBe(`/hrms-documents/${key}`);
    expect(seen[0]!.sse).toBeUndefined();
  });

  it('s3 needs a region only without an endpoint', () => {
    expect(() => envOf({ STORAGE_DRIVER: 's3', AWS_S3_BUCKET: 'b' })).toThrow(/needs AWS_REGION/);
    expect(envOf({ STORAGE_DRIVER: 's3', AWS_S3_BUCKET: 'b', S3_ENDPOINT: 'http://minio:9000' }).S3_ENDPOINT).toBe('http://minio:9000');
  });
});

describe('brand values reach what the server writes', () => {
  it('money follows the currency and locale', () => {
    setBrandFormats({ BRAND_LOCALE: 'en-US', BRAND_CURRENCY: 'USD' });
    expect(money(1500)).toBe('$1,500');
    expect(money('12.50')).toBe('$12.50');
    setBrandFormats({ BRAND_LOCALE: 'en-IN', BRAND_CURRENCY: 'INR' });
    expect(money(150000)).toBe('₹1,50,000');
  });

  it('emails carry the name, colour, link host, logo and language', () => {
    const r = renderEmail({ brandName: 'Acme', productName: 'Acme HR', primaryColor: '#14532D', supportEmail: 'help@acme.test', appUrl: 'https://hr.acme.test', locale: 'hi-IN', logoUrl: 'https://cdn.acme.test/l.png' },
      { title: 'Hello', link: '/leave' });
    expect(r.subject).toBe('Hello · Acme');
    expect(r.html).toContain('#14532D');
    expect(r.html).toContain('https://hr.acme.test/leave');
    expect(r.html).toContain('lang="hi-IN"');
    expect(r.html).toContain('src="https://cdn.acme.test/l.png"');
    expect(r.text).toContain('help@acme.test');
  });

  it('a payslip names the employer from the brand', async () => {
    const app = await makeApp({ ...flags('default,payroll,payroll.payslips'), BRAND_NAME: 'Acme', BRAND_LEGAL_NAME: 'Acme Testing Pvt Ltd', BRAND_CURRENCY: 'USD', BRAND_LOCALE: 'en-US' });
    const T = await createTenant();
    const [run] = await ownerQuery<{ id: string }>(`INSERT INTO payroll_runs (tenant_id, legal_entity_id, period, status, created_by) VALUES ($1,$2,'2026-01','computed',$3) RETURNING id`, [T.id, T.legalEntityId, T.users.payroll!.id]);
    const [item] = await ownerQuery<{ id: string }>(`INSERT INTO payroll_items (tenant_id, run_id, employee_id, days_in_period, employed_days, lop_days, paid_days, data_enc, calc_version) VALUES ($1,$2,$3,31,31,0,31,$4,1) RETURNING id`, [T.id, run!.id, T.users.employee!.employeeId, seal({ lines: [], gross: 100, deductions: 0, net: 100, employerCost: 100, warnings: [] })]);
    await ownerQuery(`UPDATE payroll_runs SET status='finalized' WHERE id=$1`, [run!.id]);
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    const slip = (await emp.get(`/api/v1/payroll/payslips/${item!.id}?reveal=1`)).json();
    expect(slip.brand).toMatchObject({ name: 'Acme', legalName: 'Acme Testing Pvt Ltd', currency: 'USD', locale: 'en-US' });
    await app.close();
  });
});
