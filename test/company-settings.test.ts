import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Client, createTenant, flags, inApp, makeApp, multipart, ownerQuery, problem, PASSWORD, testCipher, type TenantFixture } from './helpers.js';
import { TINY_JPEG, TINY_PNG, PNG_WITH_METADATA, GPS_MARK, WEBP_WITH_METADATA } from './images.js';
import { gstinCheckDigit, isValidGstin } from '../src/core/settings/india.js';
import { loadCompanyProfile } from '../src/core/settings/company.js';
import { LocalStore, getStore, setStore } from '../src/core/storage/index.js';
import { withTenant } from '../src/db/tx.js';
import { hashPassword } from '../src/core/crypto/index.js';

const GSTIN = '27AAPFU0939F1ZV'; // the example in GST documentation
const PAN = 'BBBPU1234K'; const ACCOUNT = '000123456789012';
const VALID = { legalName: 'Verdantis Analytical Labs Pvt Ltd', gstin: GSTIN, pan: PAN, tan: 'PNEV01234F', cin: 'U74999MH2019PTC123456', registeredAddress: '12 Fictional Road, Pune 411001',
  pfRegistration: 'MH/PUN/0012345/000', esiRegistration: '12345678901234567', ptRegistration: 'PT-27-0099', bankAccountHolder: 'Verdantis Analytical Labs', bankName: 'Fictional Bank', bankIfsc: 'ZZZZ0000001', bankAccountNumber: ACCOUNT,
  signatoryName: 'Asha Fictional', signatoryDesignation: 'Director' };

let app: FastifyInstance; let T: TenantFixture; let admin: Client; let hr: Client; let emp: Client; let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hrms-company-'));
  setStore(new LocalStore(root));
  app = await makeApp({ ...flags('default,payroll,core.onboarding,core.offboarding') }, { storeOverride: true });
  T = await createTenant();
  admin = await Client.login(app, T.host, T.users.admin!.email);
  hr = await Client.login(app, T.host, T.users.hr!.email);
  emp = await Client.login(app, T.host, T.users.employee!.email);
});
afterAll(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });

describe('formats', () => {
  it('the GSTIN check digit is the published algorithm', () => {
    expect(gstinCheckDigit('27AAPFU0939F1Z')).toBe('V');
    expect(isValidGstin(GSTIN)).toBe(true);
    expect(isValidGstin('27AAPFU0939F1ZA')).toBe(false);
    expect(isValidGstin('27AAPFU0939F0ZV')).toBe(false); // the entity digit cannot be 0
  });

  it.each([['gstin', '27AAPFU0939F1ZA'], ['gstin', 'nonsense'], ['pan', 'AAPFU0939'], ['tan', 'AAPF01234'], ['cin', 'U74999MH2019PTC12345'], ['bankIfsc', 'ABCD1000001'], ['bankAccountNumber', '12AB'], ['esiRegistration', '123']])('refuses %s %s', async (field, value) => {
    const r = await admin.put('/api/v1/tenant/company', { [field]: value });
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(problem(r))).not.toContain(value);
  });

  it('refuses a field it does not know', async () => {
    expect((await admin.put('/api/v1/tenant/company', { nonsense: 'x' })).statusCode).toBe(400);
  });
});

describe('editing', () => {
  it('only company.manage may change it', async () => {
    expect((await emp.put('/api/v1/tenant/company', { tan: 'PNEV01234F' })).statusCode).toBe(403);
    expect((await hr.put('/api/v1/tenant/company', { tan: 'PNEV01234F' })).statusCode).toBe(403);
    expect((await emp.get('/api/v1/tenant/company')).statusCode).toBe(403);
  });

  it('seals PAN and the bank account; the row has no plaintext, the answer the last four', async () => {
    const r = await admin.put('/api/v1/tenant/company', VALID);
    expect(r.statusCode).toBe(200);
    const [row] = await ownerQuery<Record<string, string>>(`SELECT * FROM company_profile WHERE tenant_id=$1`, [T.id]);
    expect(JSON.stringify(row)).not.toContain(PAN);
    expect(JSON.stringify(row)).not.toContain(ACCOUNT);
    expect(testCipher.decrypt(row!.pan_enc!)).toBe(PAN);
    expect(testCipher.decrypt(row!.bank_account_enc!)).toBe(ACCOUNT);
    const g = (await admin.get('/api/v1/tenant/company')).json();
    expect(g).toMatchObject({ gstin: GSTIN, panMasked: 'XXXXXX234K', bankAccountMasked: 'XXXXXX9012', tan: 'PNEV01234F', hasSignature: false, editable: true });
    expect(JSON.stringify(g)).not.toContain(PAN);
    expect(JSON.stringify(g)).not.toContain(ACCOUNT);
  });

  it('audits old to new for what is not sensitive, and names only for what is, saying so', async () => {
    await admin.put('/api/v1/tenant/company', { tan: 'PNEV09999F', pan: 'BBBPU1234L', bankAccountNumber: '999988887777' });
    const [log] = await ownerQuery<{ change_metadata: Record<string, unknown>; category: string }>(`SELECT change_metadata, category FROM audit_logs WHERE tenant_id=$1 AND action='company.updated' ORDER BY created_at DESC LIMIT 1`, [T.id]);
    expect(log!.category).toBe('configuration');
    expect(log!.change_metadata).toMatchObject({ changes: { tan: { from: 'PNEV01234F', to: 'PNEV09999F' } }, sensitiveFields: expect.arrayContaining(['pan', 'bankAccountNumber']), note: expect.stringMatching(/without their values/) });
    const all = await ownerQuery<{ m: string }>(`SELECT change_metadata::text AS m FROM audit_logs WHERE tenant_id=$1`, [T.id]);
    for (const secret of ['BBBPU1234L', PAN, ACCOUNT, '999988887777', '7777']) expect(all.some((x) => x.m.includes(secret)), secret).toBe(false);
  });

  it('an unchanged sealed value is not a change', async () => {
    const r = (await admin.put('/api/v1/tenant/company', { pan: 'BBBPU1234L', tan: 'PNEV09999F' })).json();
    expect(r.changed).toEqual([]);
  });

  it('a stale version is refused, and null clears', async () => {
    const v = (await admin.get('/api/v1/tenant/company')).json().version as number;
    const stale = await admin.put('/api/v1/tenant/company', { tan: 'PNEV01111F', expectedVersion: v - 1 });
    expect(stale.statusCode).toBe(409);
    expect((await admin.put('/api/v1/tenant/company', { ptRegistration: null, expectedVersion: v })).statusCode).toBe(200);
    expect((await admin.get('/api/v1/tenant/company')).json().ptRegistration).toBeNull();
  });
});

describe('reading', () => {
  it('someone with settings.read only gets sealed fields in the masked shape', async () => {
    const g = (await hr.get('/api/v1/tenant/company?')).json();
    expect(g.gstin).toBe(GSTIN);
    // HR holds payroll.read in multi, not an L4 reader of the employer's account.
    expect(g).toMatchObject({ panMasked: null, bankAccountMasked: null, bankIfsc: null, masked: true });
    expect(g.maskedFields).toEqual(expect.arrayContaining(['panMasked', 'bankAccountMasked', 'bankIfsc', 'bankName', 'bankAccountHolder']));
  });

  it('reveal is for company.manage, gives the bank account whole and PAN never, and is audited', async () => {
    expect((await hr.get('/api/v1/tenant/company?reveal=1')).statusCode).toBe(403);
    const g = (await admin.get('/api/v1/tenant/company?reveal=1')).json();
    expect(g.bankAccountNumber).toBe('999988887777');
    expect(JSON.stringify(g)).not.toContain('BBBPU1234L');
    const rows = await ownerQuery<{ change_metadata: { fields: string[] }; category: string; actor_id: string }>(`SELECT change_metadata, category, actor_id FROM audit_logs WHERE tenant_id=$1 AND action='company.reveal'`, [T.id]);
    expect(rows).toEqual([expect.objectContaining({ category: 'access', actor_id: T.users.admin!.id, change_metadata: { fields: ['bankAccountNumber'] } })]);
  });

  it('loadCompanyProfile gives documents the settings, with the whole PAN', async () => {
    const p = await inApp(app, () => withTenant(app.deps.pool, T.id, (db) => loadCompanyProfile(db, T.id)));
    expect(p).toMatchObject({ legalName: VALID.legalName, gstin: GSTIN, pan: 'BBBPU1234L', tan: 'PNEV09999F', cin: VALID.cin, registeredAddress: VALID.registeredAddress, pfRegistration: VALID.pfRegistration, esiRegistration: VALID.esiRegistration, signatoryName: 'Asha Fictional', signatureKey: null });
  });

  it('with nothing set, the legal entity gives name, GSTIN and CIN', async () => {
    const X = await createTenant();
    await ownerQuery(`UPDATE legal_entities SET gstin=$2, cin='U11111MH2020PTC000001' WHERE tenant_id=$1`, [X.id, GSTIN]);
    const p = await inApp(app, () => withTenant(app.deps.pool, X.id, (db) => loadCompanyProfile(db, X.id)));
    expect(p).toMatchObject({ legalName: 'LE', gstin: GSTIN, cin: 'U11111MH2020PTC000001', pan: null, tan: null });
    const g = (await (await Client.login(app, X.host, X.users.admin!.email)).get('/api/v1/tenant/company')).json();
    expect(g).toMatchObject({ legalName: 'LE', gstin: GSTIN, stored: { legalName: null, gstin: null } });
  });
});

describe('signature and stamp', () => {
  const up = (c: Client, kind: string, file: { name: string; content: Buffer }) => { const m = multipart({}, file); return c.req('POST', `/api/v1/tenant/company/images/${kind}`, m.body, m.headers); };

  it('role protected', async () => {
    expect((await up(hr, 'signature', { name: 'a.png', content: TINY_PNG })).statusCode).toBe(403);
    expect((await emp.get('/api/v1/tenant/company/images/signature')).statusCode).toBe(403);
  });

  it('PNG and JPEG only: decided by content, and WebP and PDF are refused though the rest of the app takes them', async () => {
    expect((await up(admin, 'signature', { name: 'a.webp', content: WEBP_WITH_METADATA })).statusCode).toBe(415);
    expect((await up(admin, 'signature', { name: 'a.png', content: Buffer.from('%PDF-1.4 x') })).statusCode).toBe(415);
    expect((await up(admin, 'signature', { name: 'a.png', content: Buffer.from('not an image') })).statusCode).toBe(415);
    expect((await up(admin, 'nothing', { name: 'a.png', content: TINY_PNG })).statusCode).toBe(400);
  });

  it('stored through the store with its metadata stripped, audited, read back by who may print', async () => {
    const r = await up(admin, 'signature', { name: 'sig.png', content: PNG_WITH_METADATA });
    expect(r.statusCode).toBe(201);
    const [row] = await ownerQuery<{ signature_key: string }>(`SELECT signature_key FROM company_profile WHERE tenant_id=$1`, [T.id]);
    const stored = await getStore()!.get(row!.signature_key);
    expect(stored.includes(GPS_MARK)).toBe(false);
    const payroll = await Client.login(app, T.host, T.users.payroll!.email);
    const g = await payroll.get('/api/v1/tenant/company/images/signature');
    expect(g.statusCode).toBe(200);
    expect(g.headers['content-type']).toBe('image/png');
    expect(g.headers['cache-control']).toContain('no-store');
    expect(g.rawPayload.equals(stored)).toBe(true);
    const actions = (await ownerQuery<{ action: string }>(`SELECT action FROM audit_logs WHERE tenant_id=$1 AND action LIKE 'company.image%' ORDER BY created_at`, [T.id])).map((x) => x.action);
    expect(actions).toEqual(['company.image_uploaded', 'company.image_viewed']);
    expect((await admin.get('/api/v1/tenant/company')).json().hasSignature).toBe(true);
  });

  it('a replacement deletes the old file; removing clears it', async () => {
    const [{ signature_key: first }] = (await ownerQuery<{ signature_key: string }>(`SELECT signature_key FROM company_profile WHERE tenant_id=$1`, [T.id])) as [{ signature_key: string }];
    expect((await up(admin, 'signature', { name: 'sig.jpg', content: TINY_JPEG })).statusCode).toBe(201);
    await expect(getStore()!.get(first)).rejects.toThrow();
    const [{ signature_key: second }] = (await ownerQuery<{ signature_key: string }>(`SELECT signature_key FROM company_profile WHERE tenant_id=$1`, [T.id])) as [{ signature_key: string }];
    expect((await admin.del('/api/v1/tenant/company/images/signature')).statusCode).toBe(200);
    await expect(getStore()!.get(second)).rejects.toThrow();
    expect((await admin.get('/api/v1/tenant/company/images/signature')).statusCode).toBe(404);
  });

  it('the profile names the stamp for the document generator', async () => {
    await up(admin, 'stamp', { name: 'stamp.png', content: TINY_PNG });
    const p = await inApp(app, () => withTenant(app.deps.pool, T.id, (db) => loadCompanyProfile(db, T.id)));
    expect(p.stampKey).toMatch(new RegExp(`^${T.id}/company/`));
  });
});

describe('with payroll off', () => {
  it('its fields are not shown or editable, are kept, and come back', async () => {
    const X = await createTenant();
    const on = await Client.login(app, X.host, X.users.admin!.email);
    await on.put('/api/v1/tenant/company', { pfRegistration: 'MH/PUN/0012345/000', bankAccountNumber: ACCOUNT, tan: 'PNEV01234F' });
    const off = await makeApp({ ...flags('default') }, { storeOverride: true });
    const c = await Client.login(off, X.host, X.users.admin!.email);
    const g = (await c.get('/api/v1/tenant/company')).json();
    expect(g.tan).toBe('PNEV01234F');
    for (const k of ['pfRegistration', 'esiRegistration', 'ptRegistration', 'bankAccountMasked', 'bankIfsc', 'bankName']) expect(k in g, k).toBe(false);
    expect((await c.put('/api/v1/tenant/company', { pfRegistration: 'XX/YY/1' })).statusCode).toBe(400);
    expect((await c.get('/api/v1/tenant/company?reveal=1')).json().bankAccountNumber).toBeUndefined();
    const p = await inApp(off, () => withTenant(off.deps.pool, X.id, (db) => loadCompanyProfile(db, X.id)));
    expect(p.pfRegistration).toBeNull();
    await off.close();
    expect((await on.get('/api/v1/tenant/company')).json().pfRegistration).toBe('MH/PUN/0012345/000');
  });
});

describe.each(['single', 'single_hr'] as const)('in %s mode', (mode) => {
  it('the Owner can set everything; others cannot', async () => {
    const a = await makeApp({ ...flags('default,payroll'), ORG_MANAGEMENT_MODE: mode }, { storeOverride: true });
    const X = await createTenant();
    const pw = await hashPassword(PASSWORD);
    await ownerQuery(`UPDATE users SET password_hash=$2 WHERE id=$1`, [X.users.admin!.id, pw]);
    await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'owner')`, [X.users.admin!.id, X.id]);
    const owner = await Client.login(a, X.host, X.users.admin!.email);
    expect((await owner.put('/api/v1/tenant/company', VALID)).statusCode).toBe(200);
    expect((await owner.get('/api/v1/tenant/company')).json().panMasked).toBe('XXXXXX234K');
    const m = multipart({}, { name: 's.png', content: TINY_PNG });
    expect((await owner.req('POST', '/api/v1/tenant/company/images/stamp', m.body, m.headers)).statusCode).toBe(201);
    const e = await Client.login(a, X.host, X.users.employee!.email);
    expect((await e.put('/api/v1/tenant/company', { tan: 'PNEV01234F' })).statusCode).toBe(403);
    if (mode === 'single_hr') {
      const h = await Client.login(a, X.host, X.users.hr!.email);
      expect((await h.put('/api/v1/tenant/company', { tan: 'PNEV01234F' })).statusCode).toBe(403);
    }
    await a.close();
  });
});
