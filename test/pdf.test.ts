import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { get as httpGet, type IncomingHttpHeaders } from 'node:http';
import { deflateSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { Client, createTenant, flags, makeApp, ownerQuery, problem, seal, testCipher, type TenantFixture } from './helpers.js';
import { pdfPages, pdfText } from './pdf-text.js';
import { TEST_BRAND } from './env.js';
import { isExportRoute } from '../src/core/http/limits.js';
import { drawableImage, formatDate, loadPdfContext, printableText, type PdfContext } from '../src/core/pdf/writer.js';
import { ReportTable } from '../src/core/pdf/table.js';
import { payslipPdf, type PayslipData } from '../src/modules/payroll/payslip-pdf.js';
import { LocalStore, newKey, setStore } from '../src/core/storage/index.js';

const FLAGS = 'default,payroll,payroll.payslips,core.onboarding,core.offboarding,reports.advanced';
const FULL_PAN = 'ABCDE1234F';
const ACCOUNT = '501234569876';

/** A real picture: pdfkit reads its structure. */
function realPng(colour: 2 | 6 = 2, filter = 0) {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = colour;
  const row = Buffer.from(colour === 2 ? [filter, 200, 30, 30] : [filter, 200, 30, 30, 128]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(row)), chunk('IEND', Buffer.alloc(0))]);
}
const REAL_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
const images = (b: Buffer) => (b.toString('latin1').match(/\/Subtype \/Image/g) ?? []).length;

let app: FastifyInstance;
let T: TenantFixture;
let run: string;
let root: string;
let paidItem: string;
const c: Record<string, Client> = {};
const emp = (k: string) => T.users[k]!.employeeId!;

async function item(runId: string, employeeId: string, gross = 71111, o: { hold?: boolean } = {}) {
  const [i] = await ownerQuery<{ id: string }>(
    `INSERT INTO payroll_items (tenant_id, run_id, employee_id, days_in_period, employed_days, paid_days, data_enc, calc_version, hold) VALUES ($1,$2,$3,31,31,30,$4,6,$5) RETURNING id`,
    [
      T.id,
      runId,
      employeeId,
      seal({
        lines: [
          { code: 'BASIC', name: 'Basic pay', kind: 'earning', amount: gross },
          { code: 'PF_EE', name: 'Provident fund', kind: 'deduction', amount: 1800 },
          { code: 'PF_ER', name: 'Employer share', kind: 'employer', amount: 4242 },
        ],
        gross,
        deductions: 1800,
        net: gross - 1800,
        employerCost: gross + 4242,
        warnings: [],
      }),
      !!o.hold,
    ],
  );
  return i!.id;
}
const newRun = async (period: string, status: string) => {
  const [r] = await ownerQuery<{ id: string }>(`INSERT INTO payroll_runs (tenant_id, legal_entity_id, period, created_by, totals_enc) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
    T.id,
    T.legalEntityId,
    period,
    T.users.payroll!.id,
    seal({ employees: 1, gross: 1, deductions: 0, net: 1, employerCost: 1, held: 0 }),
  ]);
  return {
    id: r!.id,
    seal: () =>
      status === 'draft'
        ? Promise.resolve([])
        : ownerQuery(`UPDATE payroll_runs SET status=$2, computed_at=now(), finalized_at=now(), paid_at=CASE WHEN $2='paid' THEN now() END WHERE id=$1`, [r!.id, status]),
  };
};
const auditRows = (action: string, target?: string) =>
  ownerQuery<{ target_id: string; change_metadata: { path: string; fields: string[]; letter?: string; l4?: boolean; format?: string } }>(
    `SELECT target_id, change_metadata FROM audit_logs WHERE tenant_id=$1 AND action=$2 AND ($3::text IS NULL OR target_id::text=$3) ORDER BY created_at`,
    [T.id, action, target ?? null],
  );

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hrms-pdf-'));
  app = await makeApp({ ...flags(FLAGS), RATE_LIMIT_PER_MINUTE: '100000', BRAND_NAME: 'Northwind Assays', BRAND_LEGAL_NAME: 'Northwind Assays Private Limited' });
  T = await createTenant();
  await ownerQuery(`UPDATE legal_entities SET name='Northwind Assays Private Limited', cin='U12345MH2020PTC000001', gstin='27AAAAA0000A1Z5' WHERE id=$1`, [T.legalEntityId]);
  await ownerQuery(`UPDATE employees SET first_name='Asha', last_name='Verma', designation='Senior Analyst' WHERE id=$1`, [emp('employee')]);
  await ownerQuery(`INSERT INTO employee_statutory (tenant_id, employee_id, uan, pan_enc, pan_last4) VALUES ($1,$2,'100200300400',$3,'1234')`, [
    T.id,
    emp('employee'),
    testCipher.encrypt(FULL_PAN),
  ]);
  await ownerQuery(
    `INSERT INTO employee_bank_accounts (employee_id, tenant_id, account_holder, account_number_enc, account_last4, ifsc) VALUES ($1,$2,'Asha Verma',$3,$4,'HDFC0001234')`,
    [emp('employee'), T.id, testCipher.encrypt(ACCOUNT), ACCOUNT.slice(-4)],
  );
  await ownerQuery(
    `INSERT INTO employee_salaries (tenant_id, employee_id, effective_from, amounts_enc, annual_ctc_enc, reason, status, created_by, approved_at) VALUES ($1,$2,'2025-01-01',$3,$4,'fixture','active',$5,now())`,
    [T.id, emp('employee'), seal({ BASIC: 71111 }), seal(853332), T.users.payroll!.id],
  );
  const r = await newRun('2026-01', 'paid');
  run = r.id;
  paidItem = await item(run, emp('employee'));
  await item(run, emp('other'), 62222);
  await r.seal();
  for (const k of ['employee', 'other', 'manager', 'hr', 'admin', 'payroll']) c[k] = await Client.login(app, T.host, T.users[k]!.email);
}, 60000);
afterAll(async () => {
  await app.close();
  setStore(null);
  await rm(root, { recursive: true, force: true });
});

const paid = () => paidItem;
const slip = (id = paid()) => `/api/v1/payroll/payslips/${id}/payslip.pdf`;
const letter = (kind: string, id: string, q = '') => `/api/v1/lifecycle/employees/${id}/letters/${kind}.pdf${q}`;

describe('payslip PDF', () => {
  it('your own: brand, employer, name and the figures, with the employer share left out', async () => {
    const r = await c.employee!.get(slip());
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const text = await pdfText(r.rawPayload);
    for (const want of [
      'Northwind Assays',
      'Northwind Assays Private Limited',
      'U12345MH2020PTC000001',
      '27AAAAA0000A1Z5',
      'Asha Verma',
      'Senior Analyst',
      'January 2026',
      'Basic pay',
      '71,111.00',
      'Provident fund',
      '1,800.00',
      'INR 69,311.00',
    ])
      expect(text).toContain(want);
    expect(text).not.toContain('Employer share');
    expect(text).not.toContain('₹');
  });

  it('PAN and bank number are the last four, and the file name and URL carry no L4', async () => {
    const r = await c.employee!.get(slip());
    const text = await pdfText(r.rawPayload);
    expect(text).toContain('XXXXXX1234X');
    expect(text).toContain('XXXXXX9876');
    expect(text).not.toContain(FULL_PAN);
    expect(text).not.toContain(ACCOUNT);
    expect(r.headers['content-disposition']).toBe('attachment; filename="payslip-2026-01.pdf"');
    expect(String(r.headers['content-disposition'])).not.toMatch(/asha|verma|1234|9876|71111/i);
    expect(slip()).not.toMatch(/asha|verma|1234F|9876/i);
    expect(r.rawPayload.toString('latin1')).not.toContain('Asha'); // Neither in the document's own title, which viewers show.
  });

  it('is audited as an export, one row for the person, and as seen by them, before the file leaves', async () => {
    const before = (await auditRows('l4.export', emp('employee'))).length;
    const seen = (await auditRows('payroll.payslip_viewed', paid())).length;
    expect((await c.employee!.get(slip())).statusCode).toBe(200);
    const rows = await auditRows('l4.export', emp('employee'));
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)!.change_metadata.path).toBe('payroll.payslip');
    expect(rows.at(-1)!.change_metadata.fields).toContain('net');
    expect((await auditRows('payroll.payslip_viewed', paid())).length).toBe(seen + 1);
  });

  it('staff above them: allowed and audited under their name, without a viewed-by-self row', async () => {
    const seen = (await auditRows('payroll.payslip_viewed', paid())).length;
    const before = (await auditRows('l4.export', emp('employee'))).length;
    const r = await c.hr!.get(slip());
    expect(r.statusCode, r.body).toBe(200);
    expect(await pdfText(r.rawPayload)).toContain('Asha Verma');
    expect((await auditRows('l4.export', emp('employee'))).length).toBe(before + 1);
    expect((await auditRows('payroll.payslip_viewed', paid())).length).toBe(seen);
  });

  it('404 for a peer, a manager, and staff not above in the hierarchy, and no row is written', async () => {
    const before = (await auditRows('l4.export')).length;
    for (const k of ['other', 'manager']) {
      const r = await c[k]!.get(slip());
      expect(r.statusCode, k).toBe(404);
      expect(problem(r).code).toBeTruthy();
      expect(r.body).not.toContain('Asha');
    }
    // HR, at 40, and a person who is at an administrator's level.
    const [e] = await ownerQuery<{ id: string }>(
      `INSERT INTO employees (tenant_id, employee_code, first_name, legal_entity_id, branch_id, date_of_joining, user_id) VALUES ($1,'TOP','Top',$2,$3,'2024-01-01',$4) RETURNING id`,
      [T.id, T.legalEntityId, T.branchId, T.users.admin!.id],
    );
    T.users.admin!.employeeId = e!.id;
    const draft = await newRun('2026-06', 'draft');
    expect((await c.hr!.get(slip(await item(draft.id, e!.id, 99999)))).statusCode).toBe(404);
    expect((await auditRows('l4.export')).length).toBe(before);
  });

  it('401 when not signed in, 404 for an unknown id, 400 for a bad one after the sign-in check', async () => {
    const anon = new Client(app, T.host);
    const r = await anon.get(slip());
    expect(r.statusCode).toBe(401);
    expect(problem(r).status).toBe(401);
    expect((await anon.get(slip('not-a-uuid'))).statusCode).toBe(401);
    expect(problem(await c.employee!.get(slip('not-a-uuid'))).status).toBe(400);
    expect((await c.employee!.get(slip('00000000-0000-4000-8000-000000000000'))).statusCode).toBe(404);
  });

  it('a GET needs no CSRF token', async () => {
    const bare = new Client(app, T.host);
    bare.cookie = c.employee!.cookie;
    bare.device = c.employee!.device;
    expect(bare.csrf).toBe('');
    expect((await bare.get(slip())).statusCode).toBe(200);
  });

  it('a held payslip and a run not yet final answer as the JSON route does: 404 for the employee, marked as such for staff', async () => {
    const heldRun = await newRun('2026-02', 'paid');
    const held = await item(heldRun.id, emp('employee'), 71111, { hold: true });
    await heldRun.seal();
    const draftRun = await newRun('2026-03', 'draft');
    const draft = await item(draftRun.id, emp('employee'));
    for (const [id, mark] of [
      [held, 'ON HOLD'],
      [draft, 'NOT FINAL'],
    ] as const) {
      const json = await c.employee!.get(`/api/v1/payroll/payslips/${id}`);
      expect(json.statusCode).toBe(404);
      const own = await c.employee!.get(slip(id));
      expect(own.statusCode).toBe(404);
      expect(problem(own).status).toBe(404);
      const staff = await c.hr!.get(slip(id));
      expect((await c.hr!.get(`/api/v1/payroll/payslips/${id}`)).statusCode).toBe(200);
      expect(staff.statusCode, staff.body).toBe(200);
      expect(await pdfText(staff.rawPayload)).toContain(mark);
    }
  });

  it('counts as an export for the rate limit, and the limit bites', async () => {
    expect(isExportRoute('GET', '/api/v1/payroll/payslips/:id/payslip.pdf')).toBe(true);
    expect(isExportRoute('GET', '/api/v1/reports/:key/export.pdf')).toBe(true);
    expect(isExportRoute('POST', '/x.pdf')).toBe(false);
    const tight = await makeApp({ ...flags(FLAGS), RATE_LIMIT_PER_MINUTE: '100000', EXPORT_RATE_LIMIT_PER_MINUTE: '1' });
    try {
      const u = await Client.login(tight, T.host, T.users.employee!.email);
      expect((await u.get(slip())).statusCode).toBe(200);
      const second = await u.get(slip());
      expect(second.statusCode).toBe(429);
      expect(problem(second).code).toBe('rate_limited');
    } finally {
      await tight.close();
    }
  });

  it('feature off is 404, whoever asks', async () => {
    const off = await makeApp({ ...flags('default,payroll,core.onboarding,core.offboarding') });
    try {
      for (const k of ['employee', 'hr']) {
        const u = await Client.login(off, T.host, T.users[k]!.email);
        const r = await u.get(slip());
        expect(r.statusCode, k).toBe(404);
        expect(problem(r).status).toBe(404);
      }
    } finally {
      await off.close();
    }
  });

  it('a name the fonts cannot draw does not crash: it prints as ? with the code beside it, and says so', async () => {
    const [e] = await ownerQuery<{ id: string }>(
      `INSERT INTO employees (tenant_id, employee_code, first_name, last_name, legal_entity_id, branch_id, date_of_joining, reporting_manager_id) VALUES ($1,'DEVA1','रमेश','الكتاب 李雷',$2,$3,'2024-01-01',NULL) RETURNING id`,
      [T.id, T.legalEntityId, T.branchId],
    );
    const r0 = await newRun('2026-04', 'paid');
    const id = await item(r0.id, e!.id);
    await r0.seal();
    const res = await c.hr!.get(slip(id));
    expect(res.statusCode, res.body).toBe(200);
    const text = await pdfText(res.rawPayload);
    expect(text).toContain('DEVA1');
    expect(text).toContain('71,111.00');
    expect(text).toContain('????');
    expect(text).toContain('could not be printed');
  });
});

describe('brand input', () => {
  const data: PayslipData = {
    period: '2026-01',
    kind: 'regular',
    days_in_period: '31',
    employed_days: '31',
    lop_days: '0',
    paid_days: '31',
    employee_code: 'E1',
    name: 'Asha Verma',
    designation: null,
    date_of_joining: '2024-01-05',
    department: null,
    branch: 'HQ',
    legal_entity: 'LE',
    uan: null,
    ifsc: null,
    pan: null,
    account: null,
    lines: [{ code: 'B', name: 'Basic', kind: 'earning', amount: 100 }],
    gross: '100.00',
    deductions: '0.00',
    net: '100.00',
  };
  const company = {
    legalName: null,
    gstin: null,
    pan: null,
    tan: null,
    cin: null,
    registeredAddress: null,
    pfRegistration: null,
    esiRegistration: null,
    ptRegistration: null,
    signatoryName: null,
    signatoryDesignation: null,
    signatureKey: null,
    stampKey: null,
  };
  const fakeApp = (over: Record<string, unknown>, brandDirOverride?: string) => ({ deps: { env: { ...TEST_BRAND, ...over }, brandDirOverride } }) as unknown as FastifyInstance;
  const body = async (doc: PDFKit.PDFDocument) => {
    const parts: Buffer[] = [];
    for await (const p of doc) parts.push(p as Buffer);
    return Buffer.concat(parts);
  };

  it('a PNG or JPEG in the mount is drawn, and the brand name stays in the footer', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hrms-brand-'));
    await writeFile(path.join(dir, 'logo.png'), realPng());
    await writeFile(path.join(dir, 'alpha.png'), realPng(6));
    await writeFile(path.join(dir, 'logo.jpg'), REAL_JPEG);
    for (const [file, count] of [
      ['logo.png', 1],
      ['alpha.png', 2],
      ['logo.jpg', 1],
    ] as const) {
      const ctx = await loadPdfContext(fakeApp({ BRAND_LOGO_URL: `/brand/${file}` }, dir), { company, dateFormat: 'DD/MM/YYYY' });
      expect(ctx.images.logo, file).not.toBeNull();
      const out = await body(payslipPdf(ctx, data, { status: 'paid', hold: false }));
      expect(images(out), file).toBe(count); // A PNG with alpha is an image and its mask.
      expect(await pdfText(out)).toContain(TEST_BRAND.BRAND_NAME);
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('SVG, https, a missing or a broken file all fall back to the name, without fetching anything', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hrms-brand-'));
    await writeFile(path.join(dir, 'logo.svg'), '<svg/>');
    await writeFile(path.join(dir, 'broken.png'), Buffer.from('not a png at all'));
    await writeFile(path.join(dir, 'filter.png'), realPng(6, 9));
    for (const ref of ['/brand/logo.svg', '/brand/broken.png', '/brand/filter.png', '/brand/absent.png', 'https://cdn.example.test/logo.png']) {
      const ctx = await loadPdfContext(fakeApp({ BRAND_LOGO_URL: ref }, dir), { company, dateFormat: 'DD/MM/YYYY' });
      expect(ctx.images.logo, ref).toBeNull();
      const out = await body(payslipPdf(ctx, data, { status: 'paid', hold: false }));
      expect(images(out), ref).toBe(0);
      expect(await pdfText(out)).toContain(TEST_BRAND.BRAND_NAME);
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('the checks in front of the drawing library refuse what it would throw on out of reach', () => {
    expect(drawableImage(realPng())).toBe(true);
    expect(drawableImage(realPng(6))).toBe(true);
    expect(drawableImage(realPng(6, 9))).toBe(false);
    expect(drawableImage(Buffer.concat([realPng().subarray(0, 40)]))).toBe(false);
    expect(drawableImage(Buffer.alloc(0))).toBe(false);
  });

  it('signature, stamp, signatory and company details from the profile are drawn; a key that cannot be read is left out', async () => {
    const store = new LocalStore(root);
    setStore(store);
    const sig = newKey(T.id, null);
    const stamp = newKey(T.id, null);
    await store.put(sig, realPng());
    await store.put(stamp, REAL_JPEG);
    const profile = {
      ...company,
      legalName: 'Profile Legal Name Ltd',
      cin: 'CIN-XYZ',
      gstin: 'GST-XYZ',
      tan: 'TAN-XYZ',
      registeredAddress: '12 Mill Road, Pune',
      pfRegistration: 'PF-XYZ',
      esiRegistration: 'ESI-XYZ',
      signatoryName: 'Meera Rao',
      signatoryDesignation: 'Director',
      signatureKey: sig,
      stampKey: stamp,
    };
    const ctx = await loadPdfContext(fakeApp({}), { company: profile, dateFormat: 'DD/MM/YYYY' });
    const out = await body(payslipPdf(ctx, data, { status: 'paid', hold: false }));
    expect(images(out)).toBe(2);
    const text = await pdfText(out);
    for (const want of ['Profile Legal Name Ltd', 'CIN-XYZ', 'GST-XYZ', 'TAN-XYZ', '12 Mill Road, Pune', 'PF-XYZ', 'ESI-XYZ', 'Meera Rao', 'Director'])
      expect(text).toContain(want);
    const gone = await loadPdfContext(fakeApp({}), { company: { ...profile, signatureKey: newKey(T.id, null), stampKey: 'not/a/key' }, dateFormat: 'DD/MM/YYYY' });
    expect(gone.images.signature).toBeNull();
    expect(gone.images.stamp).toBeNull();
    setStore(null);
  });

  it('date format, locale and currency come from the deployment; null company fields are simply absent', async () => {
    const ctx = await loadPdfContext(fakeApp({ BRAND_CURRENCY: 'USD', BRAND_LOCALE: 'en-US' }), { company, dateFormat: 'DD-MMM-YYYY' });
    const text = await pdfText(await body(payslipPdf(ctx, { ...data, net: '1234567.50' }, { status: 'paid', hold: false })));
    expect(text).toContain('USD 1,234,567.50');
    expect(text).toContain('05-Jan-2024');
    expect(text).not.toContain('null');
    expect(text).not.toContain('CIN');
    expect(formatDate('2024-01-05', 'DD/MM/YYYY')).toBe('05/01/2024');
    expect(formatDate('2024-01-05', 'DD-MM-YYYY')).toBe('05-01-2024');
    expect(formatDate('2024-01-05', 'YYYY-MM-DD')).toBe('2024-01-05');
  });

  it('text the fonts cannot draw', () => {
    expect(printableText('Ramesh')).toEqual({ text: 'Ramesh', lossy: false });
    expect(printableText('José Müller')).toEqual({ text: 'José Müller', lossy: false });
    expect(printableText('Rāmēsh')).toEqual({ text: 'Ramesh', lossy: false });
    expect(printableText('₹500').text).toBe('INR 500');
    expect(printableText('a b\nc')).toEqual({ text: 'a b c', lossy: false });
    expect(printableText('李')).toEqual({ text: '?', lossy: true });
    expect(printableText('😀')).toEqual({ text: '?', lossy: true });
  });
});

describe('report PDF', () => {
  const ctx = (): PdfContext => ({
    brandName: 'Northwind Assays',
    productName: 'P',
    legalName: 'Northwind Assays Pvt Ltd',
    primaryColor: '#1f5f8b',
    locale: 'en-IN',
    currency: 'INR',
    dateFormat: 'DD/MM/YYYY',
    images: { logo: null, signature: null, stamp: null },
    company: {
      legalName: null,
      gstin: null,
      pan: null,
      tan: null,
      cin: null,
      registeredAddress: null,
      pfRegistration: null,
      esiRegistration: null,
      ptRegistration: null,
      signatoryName: null,
      signatoryDesignation: null,
      signatureKey: null,
      stampKey: null,
    },
  });
  const wide = {
    title: 'Wide',
    subtitle: ['Generated today'],
    notes: ['Your reporting team only.'],
    columns: [
      { key: 'code', label: 'Code', type: 'text' as const },
      { key: 'name', label: 'Employee name', type: 'text' as const },
      { key: 'joined', label: 'Joined', type: 'date' as const },
      ...Array.from({ length: 14 }, (_, i) => ({ key: `m${i}`, label: `Month ${i} gross`, type: 'money' as const })),
    ],
    totals: { code: 'x', m0: 98765432.1 },
  };
  const rowsOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      code: `E${i}`,
      name: `A person with an exceedingly long name that cannot fit in any column ${i}`,
      joined: '2024-02-03',
      ...Object.fromEntries(Array.from({ length: 14 }, (_, k) => [`m${k}`, 1234567.89 + i])),
    }));
  const read = async (t: ReportTable) => {
    const parts: Buffer[] = [];
    const done = (async () => {
      for await (const p of t.w.doc) parts.push(p as Buffer);
    })();
    t.start();
    const stats = await t.finish();
    await done;
    return { file: Buffer.concat(parts), stats };
  };

  it('wide tables fit on landscape pages: the header repeats, numbers are whole, long text is cut with a note', async () => {
    const { file, stats } = await read(new ReportTable(ctx(), { ...wide, rows: rowsOf(300) }));
    const pages = await pdfPages(file);
    expect(pages.length).toBeGreaterThan(3);
    for (const p of pages) {
      expect(p).toContain('Employee');
      expect(p).toContain('Month 13');
      expect(p).toContain('Page ');
    }
    const all = pages.join('\n');
    expect(all).toContain('12,34,567.89');
    expect(all).toContain('03/02/2024');
    expect(all).toContain('E299');
    expect(all).toContain('Total');
    expect(all).toContain('9,87,65,432.10');
    expect(all).toContain('Your reporting team only.');
    expect(all).toContain('cut to fit');
    expect(all).not.toContain('cannot fit in any column');
    expect(stats.truncated).toBe(true);
    expect(file.toString('latin1')).toMatch(/\/MediaBox \[0 0 841\.89 595\.28\]/);
  });

  it(`at the row limit it lets the event loop through, so the longest stall stays short`, async () => {
    const gaps: number[] = [];
    let last = performance.now();
    const beat = setInterval(() => {
      const n = performance.now();
      gaps.push(n - last);
      last = n;
    }, 1);
    const { file, stats } = await read(new ReportTable(ctx(), { ...wide, rows: rowsOf(5000) }));
    clearInterval(beat);
    expect(stats.yields).toBeGreaterThan(5);
    // Far above what it measures (D52), since this machine is shared with other tests: a stall of the whole render would be seconds.
    expect(Math.max(...gaps)).toBeLessThan(400);
    const pages = await pdfPages(file);
    expect(pages.length).toBeGreaterThan(50);
    expect(pages.at(-1)).toContain('E4999');
  }, 60000);

  it('stops drawing when the client goes away', async () => {
    const t = new ReportTable(ctx(), { ...wide, rows: rowsOf(5000) });
    t.start();
    t.w.doc.on('error', () => undefined);
    t.w.doc.destroy();
    const stats = await t.finish();
    expect(stats.yields).toBe(0);
  });

  it('waits for a slow reader instead of piling the file up in memory', async () => {
    const t = new ReportTable(ctx(), { ...wide, rows: rowsOf(5000) });
    t.start();
    let finished = false;
    const drawing = t.finish().then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(finished).toBe(false);
    expect(t.w.doc.readableLength).toBeLessThan(512 * 1024);
    for await (const part of t.w.doc) expect(part).toBeTruthy();
    await drawing;
    expect(finished).toBe(true);
  }, 30000);

  it('over a real socket the report is a stream: chunked, with no length announced', async () => {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const u = new URL(address);
    const { headers, file } = await new Promise<{ headers: IncomingHttpHeaders; file: Buffer }>((resolve, reject) => {
      httpGet(
        {
          host: u.hostname,
          port: u.port,
          path: '/api/v1/reports/payroll_cost/export.pdf?from=2026-01&to=2026-01',
          headers: { host: T.host, cookie: [c.hr!.cookie, c.hr!.device].filter(Boolean).join('; ') },
        },
        (m) => {
          const parts: Buffer[] = [];
          m.on('data', (b: Buffer) => parts.push(b));
          m.on('end', () => resolve({ headers: m.headers, file: Buffer.concat(parts) }));
        },
      ).on('error', reject);
    });
    expect(headers['transfer-encoding']).toBe('chunked');
    expect(headers['content-length']).toBeUndefined();
    expect(file.subarray(0, 5).toString()).toBe('%PDF-');
    expect(file.subarray(-6).toString()).toContain('%%EOF');
  });

  it('no rows, and a report with a name the fonts cannot draw, are still a file', async () => {
    const { file } = await read(new ReportTable(ctx(), { ...wide, title: 'Empty', rows: [], totals: null }));
    expect(await pdfText(file)).toContain('No rows.');
    const { file: odd } = await read(new ReportTable(ctx(), { ...wide, rows: [{ code: '李雷', name: 'Rāmēsh', joined: null }], totals: null }));
    const text = await pdfText(odd);
    expect(text).toContain('??');
    expect(text).toContain('Ramesh');
    expect(text).toContain('could not be printed');
  });

  it('through the route: same audit and excluded header as the CSV, and a file named after the report', async () => {
    const q = 'from=2026-01&to=2026-01';
    const costRows = async () => (await auditRows('l4.export')).filter((x) => x.change_metadata.path === 'reports.payroll_cost').map((x) => x.target_id);
    const before = await costRows();
    const exported = (await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='reports.exported'`, [T.id])).length;
    const r = await c.hr!.get(`/api/v1/reports/payroll_cost/export.pdf?${q}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(String(r.headers['content-disposition'])).toMatch(/^attachment; filename="payroll_cost-\d{4}-\d{2}-\d{2}\.pdf"$/);
    expect(r.headers['cache-control']).toBe('private, no-store');
    const csv = await c.hr!.get(`/api/v1/reports/payroll_cost/export.csv?${q}`);
    expect(r.headers['x-excluded-subjects']).toBe(csv.headers['x-excluded-subjects']);
    expect(await pdfText(r.rawPayload)).toContain('Northwind Assays');
    // Each export wrote the same rows, one for each person whose pay went in.
    const added = await costRows();
    const count = (list: string[], id: string) => list.filter((x) => x === id).length;
    expect(added.length).toBeGreaterThan(before.length);
    for (const id of new Set(added)) expect(count(added, id) - count(before, id), id).toBe(2);
    const log = await ownerQuery<{ change_metadata: { format: string } }>(
      `SELECT change_metadata FROM audit_logs WHERE tenant_id=$1 AND action='reports.exported' ORDER BY created_at`,
      [T.id],
    );
    expect(log.length).toBe(exported + 2);
    expect(log.map((x) => x.change_metadata.format)).toContain('pdf');
  });

  it('through the route: a reader with no access gets the same refusal as the CSV', async () => {
    const pdf = await c.other!.get('/api/v1/reports/payroll_cost/export.pdf?from=2026-01&to=2026-01');
    const csvOne = await c.other!.get('/api/v1/reports/payroll_cost/export.csv?from=2026-01&to=2026-01');
    expect(pdf.statusCode).toBe(csvOne.statusCode);
    expect(problem(pdf).code).toBe(problem(csvOne).code);
    expect((await c.hr!.get('/api/v1/reports/no_such_report/export.pdf')).statusCode).toBe(404);
  });

  it('a scheduled copy as a PDF: its recipient only, and audited', async () => {
    const data = seal({ rows: [{ grp: 'Lab', n: 3 }], totals: { grp: 'x', n: 3 }, subjects: [] });
    const [s] = await ownerQuery<{ id: string }>(
      `INSERT INTO report_snapshots (tenant_id, owner_id, report_key, name, params, scope, columns, data_enc, row_count, recipient_ids, expires_at)
      VALUES ($1,$2,'headcount','Weekly headcount','{}','all',$3,$4,1,$5, now()+interval '1 day') RETURNING id`,
      [
        T.id,
        T.users.hr!.id,
        JSON.stringify([
          { key: 'grp', label: 'Group', type: 'text' },
          { key: 'n', label: 'People', type: 'int' },
        ]),
        data,
        [T.users.hr!.id],
      ],
    );
    const r = await c.hr!.get(`/api/v1/reports/snapshots/${s!.id}/export.pdf`);
    expect(r.statusCode, r.body).toBe(200);
    const text = await pdfText(r.rawPayload);
    expect(text).toContain('Weekly headcount');
    expect(text).toContain('People');
    expect(String(r.headers['content-disposition'])).toMatch(/headcount-\d{4}-\d{2}-\d{2}\.pdf/);
    expect((await c.other!.get(`/api/v1/reports/snapshots/${s!.id}/export.pdf`)).statusCode).toBe(404);
    const rows = await ownerQuery<{ change_metadata: { format: string } }>(
      `SELECT change_metadata FROM audit_logs WHERE tenant_id=$1 AND action='reports.exported' AND target_id=$2`,
      [T.id, s!.id],
    );
    expect(rows.map((x) => x.change_metadata.format)).toEqual(['pdf']);
  });
});

describe('letters', () => {
  const separate = async (employeeId: string, status: string, lwd: string, kind = 'resignation') => {
    await ownerQuery(`DELETE FROM separations WHERE tenant_id=$1 AND employee_id=$2`, [T.id, employeeId]);
    await ownerQuery(
      `INSERT INTO separations (tenant_id, employee_id, kind, reason, notice_date, requested_lwd, notice_days_required, status, initiated_by) VALUES ($1,$2,$5,'A private reason','2026-01-01',$3,30,$4,$6)`,
      [T.id, employeeId, lwd, status, kind, T.users.hr!.id],
    );
  };

  it('appointment: HR above them gets it with brand, employer and role; audited; no salary unless asked and allowed', async () => {
    const before = (await auditRows('lifecycle.letter_issued', emp('employee'))).length;
    const r = await c.hr!.get(letter('appointment', emp('employee')));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['content-disposition']).toBe('attachment; filename="appointment-letter.pdf"');
    expect(r.headers['x-pay-included']).toBe('0');
    const text = await pdfText(r.rawPayload);
    for (const want of ['Northwind Assays Private Limited', 'Asha Verma', 'Senior Analyst', '01/01/2024', 'Letter of appointment', 'Authorised signatory'])
      expect(text).toContain(want);
    expect(text).not.toContain('8,53,332');
    const rows = await auditRows('lifecycle.letter_issued', emp('employee'));
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)!.change_metadata).toMatchObject({ letter: 'appointment', l4: false });
  });

  it('salary on an appointment letter: only a reader who passes L4, and then an L4 export', async () => {
    const before = (await auditRows('l4.export', emp('employee'))).length;
    const r = await c.hr!.get(letter('appointment', emp('employee'), '?includePay=1'));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['x-pay-included']).toBe('1');
    expect(await pdfText(r.rawPayload)).toContain('INR 8,53,332.00');
    expect((await auditRows('l4.export', emp('employee'))).length).toBe(before + 1);
    // HR without any pay permission gets the letter and no figure, and no L4 row is written.
    const [u] = await ownerQuery<{ id: string }>(
      `INSERT INTO users (tenant_id, email, display_name, password_hash) SELECT tenant_id, $2, 'Exec', password_hash FROM users WHERE id=$1 RETURNING id`,
      [T.users.hr!.id, `exec@${T.host}`],
    );
    await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'hr_executive')`, [u!.id, T.id]);
    const exec = await Client.login(app, T.host, `exec@${T.host}`);
    const noPay = await exec.get(letter('appointment', emp('employee'), '?includePay=1'));
    expect(noPay.statusCode, noPay.body).toBe(200);
    expect(noPay.headers['x-pay-included']).toBe('0');
    expect(await pdfText(noPay.rawPayload)).not.toContain('8,53,332');
    expect((await auditRows('l4.export', emp('employee'))).length).toBe(before + 1);
    expect(problem(await c.hr!.get(letter('appointment', emp('employee'), '?includePay=yes'))).status).toBe(400);
  });

  it('appointment: 403 without the permission, 404 out of reach, and nobody issues their own', async () => {
    const r = await c.employee!.get(letter('appointment', emp('employee')));
    expect(r.statusCode).toBe(403);
    expect(problem(r).status).toBe(403);
    expect((await c.manager!.get(letter('appointment', emp('employee')))).statusCode).toBe(403);
    expect(problem(await c.hr!.get(letter('appointment', emp('hr')))).status).toBe(404);
    await ownerQuery(`UPDATE users SET salary_access_level=95 WHERE id=$1`, [T.users.manager!.id]);
    await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'tenant_admin')`, [T.users.manager!.id, T.id]);
    try {
      expect((await c.hr!.get(letter('appointment', emp('manager')))).statusCode).toBe(404);
    } finally {
      await ownerQuery(`DELETE FROM user_roles WHERE user_id=$1 AND role_key='tenant_admin'`, [T.users.manager!.id]);
      await ownerQuery(`UPDATE users SET salary_access_level=0 WHERE id=$1`, [T.users.manager!.id]);
    }
    expect((await new Client(app, T.host).get(letter('appointment', emp('employee')))).statusCode).toBe(401);
  });

  it('experience: from the last working day of an approved separation, for HR and for the person, never a peer; the reason is not printed', async () => {
    const id = emp('other');
    await ownerQuery(`DELETE FROM separations WHERE tenant_id=$1 AND employee_id=$2`, [T.id, id]);
    expect((await c.other!.get(letter('experience', id))).statusCode).toBe(409);
    await separate(id, 'approved', '2999-01-01');
    expect(problem(await c.hr!.get(letter('experience', id))).status).toBe(409);
    await separate(id, 'pending', '2026-01-31');
    expect((await c.other!.get(letter('experience', id))).statusCode).toBe(409);
    await separate(id, 'approved', '2026-01-31');
    for (const u of [c.other!, c.hr!]) {
      const r = await u.get(letter('experience', id));
      expect(r.statusCode, r.body).toBe(200);
      expect(r.headers['content-disposition']).toBe('attachment; filename="experience-letter.pdf"');
      const text = await pdfText(r.rawPayload);
      expect(text).toContain('Emp N3');
      expect(text).toContain('31/01/2026');
      expect(text).not.toContain('A private reason');
    }
    expect((await c.employee!.get(letter('experience', id))).statusCode).toBe(404);
    expect((await c.manager!.get(letter('experience', id))).statusCode).toBe(404);
    expect((await auditRows('lifecycle.letter_issued', id)).length).toBeGreaterThanOrEqual(2);
  });

  it('relieving: only after completion, since it says clearance is done; not for a death or an absconding', async () => {
    const id = emp('other');
    await separate(id, 'approved', '2026-01-31');
    const early = await c.hr!.get(letter('relieving', id));
    expect(early.statusCode).toBe(409);
    expect(problem(early).detail).toContain('complete');
    await separate(id, 'completed', '2026-01-31');
    for (const u of [c.other!, c.hr!]) {
      const r = await u.get(letter('relieving', id));
      expect(r.statusCode, r.body).toBe(200);
      expect(r.headers['content-disposition']).toBe('attachment; filename="relieving-letter.pdf"');
      expect(await pdfText(r.rawPayload)).toContain('has been relieved');
    }
    expect((await c.employee!.get(letter('relieving', id))).statusCode).toBe(404);
    for (const kind of ['death', 'absconding']) {
      await separate(id, 'completed', '2026-01-31', kind);
      expect((await c.hr!.get(letter('relieving', id))).statusCode, kind).toBe(409);
    }
    await ownerQuery(`DELETE FROM separations WHERE tenant_id=$1 AND employee_id=$2`, [T.id, id]);
  });

  it('feature off is 404 for each', async () => {
    const off = await makeApp({ ...flags('default,payroll'), FEATURE_ONBOARDING: 'false', FEATURE_OFFBOARDING: 'false' });
    const only = await makeApp({ ...flags('default,payroll,core.onboarding'), FEATURE_OFFBOARDING: 'false' });
    try {
      const u = await Client.login(off, T.host, T.users.hr!.email);
      for (const k of ['appointment', 'experience', 'relieving']) expect((await u.get(letter(k, emp('employee')))).statusCode, k).toBe(404);
      const o = await Client.login(only, T.host, T.users.hr!.email);
      expect((await o.get(letter('appointment', emp('employee')))).statusCode).toBe(200);
      for (const k of ['experience', 'relieving']) expect((await o.get(letter(k, emp('employee')))).statusCode, k).toBe(404);
    } finally {
      await off.close();
      await only.close();
    }
  });

  it('a GET needs no CSRF token', async () => {
    const bare = new Client(app, T.host);
    bare.cookie = c.hr!.cookie;
    bare.device = c.hr!.device;
    expect((await bare.get(letter('appointment', emp('employee')))).statusCode).toBe(200);
  });
});
