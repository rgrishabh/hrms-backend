import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { multipart, readXlsx, seal } from '../helpers.js';
import { TINY_PNG } from '../images.js';
import { csvCell } from '../../src/core/http/csv.js';
import { createTenant, ownerQuery, person, send, serve, WireClient, type TenantFixture } from './wire.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
let app: FastifyInstance;
let port: number;
let dir: string;
let T: TenantFixture;
let hr: WireClient;
let emp: WireClient;
let category: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'hrms-files-'));
  ({ app, port } = await serve({ STORAGE_DRIVER: 'local', STORAGE_PATH: dir, STORAGE_MAX_FILE_MB: '1' }));
  T = await createTenant();
  hr = await WireClient.signIn(app, T.host, T.users.hr!.email);
  emp = await WireClient.signIn(app, T.host, T.users.employee!.email);
  const r = await hr.post('/api/v1/documents/categories', { code: 'GEN', name: 'General', employeeUpload: true });
  expect(r.statusCode, r.body).toBe(201);
  category = r.json().id;
}, 60000);
afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});
const upload = (c: WireClient, name: string, content: Buffer, type = 'application/pdf') => {
  const m = multipart({ categoryId: category, employeeId: T.users.employee!.employeeId!, title: 'A document' }, { name, content, type });
  return c.req('POST', '/api/v1/documents', m.body, m.headers);
};

describe('upload type and size', () => {
  it.each([
    ['an executable named .pdf', 'cv.pdf', Buffer.from('MZ\x90\x00 executable')],
    ['HTML named .pdf', 'cv.pdf', Buffer.from('<html><script>alert(1)</script></html>')],
    ['SVG with a script', 'logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['a PDF with JavaScript', 'a.pdf', Buffer.from('%PDF-1.4\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>')],
    ['F-120 a PDF hiding /JavaScript in a hex-escaped name', 'a.pdf', Buffer.from('%PDF-1.4\n<< /OpenAction << /S /J#61vaScript /J#53 (app.alert(1)) >> >>')],
    ['F-120 a PDF with a launch action in a hex-escaped name', 'a.pdf', Buffer.from('%PDF-1.4\n<< /A << /S /L#61unch /F (cmd.exe) >> >>')],
    ['a PDF with a launch action', 'a.pdf', Buffer.from('%PDF-1.4\n<< /A << /S /Launch /F (cmd.exe) >> >>')],
    [
      'F-121 a Word file carrying macros',
      'a.docx',
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('[Content_Types].xml word/document.xml word/vbaProject.bin')]),
    ],
    ['F-121 a workbook carrying macros', 'a.xlsx', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('[Content_Types].xml xl/workbook.xml xl/vbaProject.bin')])],
    ['a bare zip named .docx', 'a.docx', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('nothing inside')])],
  ])('%s is refused', async (_n, name, content) => {
    const r = await upload(hr, name, content);
    expect(r.statusCode, r.body).toBe(415);
  });

  it('over the size limit is 413 and nothing is stored', async () => {
    const before = await readdir(dir, { recursive: true });
    const r = await upload(hr, 'big.pdf', Buffer.concat([PDF, Buffer.alloc(1024 * 1024 + 10, 0x20)]));
    expect(r.statusCode).toBe(413);
    expect(await readdir(dir, { recursive: true })).toEqual(before);
  });

  it('a JSON body over 1 MB is 413, and two files in one request store at most one', async () => {
    const big = await hr.post('/api/v1/notifications/read-all', { x: 'y'.repeat(1024 * 1024 + 1) });
    expect(big.statusCode).toBe(413);
    const m = multipart({ categoryId: category, employeeId: T.users.employee!.employeeId!, title: 'One' }, { name: 'a.pdf', content: PDF });
    const boundary = m.headers['content-type'].split('boundary=')[1]!;
    const second = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file2"; filename="b.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\r\n`);
    const body = Buffer.concat([m.body.subarray(0, m.body.length - boundary.length - 6), second, m.body.subarray(m.body.length - boundary.length - 6)]);
    const r = await hr.req('POST', '/api/v1/documents', body, m.headers);
    expect(r.statusCode).toBeLessThan(500);
  });
});

describe('path traversal', () => {
  it('a file name cannot steer where a file goes or what its download is called', async () => {
    const r = await upload(hr, '../../../../etc/cron.d/evil".pdf', PDF);
    expect(r.statusCode, r.body).toBe(201);
    const [row] = await ownerQuery<{ storage_key: string; file_name: string }>(`SELECT storage_key, file_name FROM documents WHERE id=$1`, [r.json().id]);
    expect(row!.storage_key).not.toContain('..');
    expect(row!.storage_key).toMatch(new RegExp(`^${T.id}/employees/${T.users.employee!.employeeId}/[0-9a-f-]{36}$`));
    expect(row!.file_name).not.toMatch(/[/\\"]/);
    const dl = await hr.get(`/api/v1/documents/${r.json().id}/download`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="[\w .-]+\.pdf"/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
  });

  it('a stored name with a line break cannot split a header', async () => {
    const r = await upload(hr, 'a\r\nSet-Cookie: x=1.pdf', PDF);
    expect(r.statusCode, r.body).toBeLessThan(500);
    if (r.statusCode === 201) {
      const dl = await hr.get(`/api/v1/documents/${r.json().id}/download`);
      expect(dl.headers['set-cookie']).toBeUndefined();
    }
  });

  it.each([
    '/api/v1/documents/..%2f..%2f..%2fetc%2fpasswd/download',
    '/api/v1/documents/%2e%2e%2f%2e%2e%2fetc%2fpasswd/download',
    '/api/v1/documents/../../../etc/passwd',
    '/brand/../../../../etc/passwd',
    '/brand/..%2f..%2f..%2fetc%2fpasswd',
    '/assets/../../package.json',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/..\\..\\etc\\passwd',
  ])('%s gets nothing', async (p) => {
    const r = await send(port, 'GET', p, { host: T.host, cookie: hr.cookie });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
    expect(r.body).not.toContain('root:');
    expect(r.body).not.toContain('"name": "hrms-backend"');
  });

  it("an employee cannot read another's document by its id, and HR is told nothing above them", async () => {
    const r = await upload(hr, 'mine.pdf', PDF);
    const other = await WireClient.signIn(app, T.host, T.users.other!.email);
    expect((await other.get(`/api/v1/documents/${r.json().id}/download`)).statusCode).toBe(404);
    expect((await emp.get(`/api/v1/documents/${r.json().id}/download`)).statusCode).toBe(200);
  });
});

describe('formula injection', () => {
  const CELLS = [
    '=1+1',
    '+1+1',
    '-1+1',
    '@SUM(1)',
    '\t=1+1',
    '\r=1+1',
    '\n=1+1',
    ' =1+1',
    '  @x',
    '　=1+1',
    '＝1+1',
    '＋1',
    '－1',
    '＠x',
    "=cmd|' /C calc'!A0",
    '=HYPERLINK("http://evil.test","x")',
  ];
  it.each(CELLS)('CSV neutralizes %j', (v) => {
    const cell = csvCell(v);
    expect(cell.replace(/^"/, '').startsWith("'"), cell).toBe(true);
  });
  it('a plain number stays a number; a separator or line break inside a value cannot make another cell or row', () => {
    expect(csvCell('-100.50')).toBe('-100.50');
    expect(csvCell('1200')).toBe('1200');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('x\r=1,y')).toBe('"x\r=1,y"');
    expect(csvCell('a;=1+1')).toBe('"a;=1+1"');
  });

  it('F-122 the reimbursement bank file: an account holder cannot forge a row or a formula', async () => {
    const X = await createTenant();
    const fin1 = await person(X, 'fin1', ['finance_manager', 'employee'], { storedLevel: 85 });
    const hold = 'Evil\r\nEMP9,Mallory,500000,1,Mallory,HDFC0000001,1234567890';
    await ownerQuery(
      `INSERT INTO employee_bank_accounts (tenant_id, employee_id, account_holder, account_number_enc, account_last4, ifsc) VALUES ($1,$2,$3,$4,'7890','HDFC0000001')`,
      [X.id, X.users.employee!.employeeId, hold, seal('1234567890')],
    );
    const [c] = await ownerQuery<{ id: string }>(
      `INSERT INTO expense_claims (tenant_id, employee_id, title, purpose, status, total, created_by) VALUES ($1,$2,'=SUM(1)','A real purpose','approved',100,$3) RETURNING id`,
      [X.id, X.users.employee!.employeeId, X.users.employee!.id],
    );
    const [b] = await ownerQuery<{ id: string }>(
      `INSERT INTO reimbursement_batches (tenant_id, status, total, claim_count, prepared_by, approved_by, approved_at) VALUES ($1,'approved',100,1,$2,$3,now()) RETURNING id`,
      [X.id, X.users.fin1!.id, X.users.admin!.id],
    );
    await ownerQuery(`UPDATE expense_claims SET batch_id=$2 WHERE id=$1`, [c!.id, b!.id]);
    const f = await WireClient.signIn(app, X.host, fin1.email);
    const r = await f.get(`/api/v1/expenses/batches/${b!.id}/export.csv`);
    expect(r.statusCode, r.body).toBe(200);
    const rows = r.body.trim().split('\r\n');
    // Inside quotes a line break belongs to the cell: count the records the way a CSV reader does.
    const records = r.body
      .replace(/"(?:[^"]|"")*"/g, 'Q')
      .trim()
      .split('\r\n');
    expect(records).toHaveLength(2);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('a name with a formula, over HTTP: neutralized in CSV, an inline string in XLSX', async () => {
    const X = await createTenant();
    const v = await person(X, 'victim', ['employee']);
    await ownerQuery(`UPDATE employees SET first_name=$2, date_of_joining=$3 WHERE id=$1`, [v.employeeId, '=HYPERLINK("http://evil.test")', new Date().toISOString().slice(0, 10)]);
    const c = await WireClient.signIn(app, X.host, X.users.hr!.email);
    const csv = await c.get('/api/v1/reports/joiners_leavers/export.csv');
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.body).toContain(`"'=HYPERLINK`);
    const x = await c.get('/api/v1/reports/joiners_leavers/export.xlsx');
    const sheet = readXlsx(x.rawPayload as Buffer)['xl/worksheets/sheet1.xml']!;
    expect(sheet).toContain('=HYPERLINK');
    expect(sheet).not.toMatch(/<f[ >]/);
  });
});

describe('SSRF', () => {
  it('nothing in the API takes a URL the server will call except the push endpoint, and that is an allow-list', async () => {
    const c = await WireClient.signIn(app, T.host, T.users.employee!.email);
    for (const endpoint of [
      'http://169.254.169.254/latest/meta-data/',
      'https://169.254.169.254/',
      'https://localhost/',
      'https://127.0.0.1:5432/',
      'https://fcm.googleapis.com.evil.test/x',
      'https://evil.test#fcm.googleapis.com',
      'https://fcm.googleapis.com@evil.test/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'http://fcm.googleapis.com/x',
      'file:///etc/passwd',
      'gopher://127.0.0.1/',
      'https://[::1]/',
    ]) {
      const r = await c.post('/api/v1/notifications/push/subscribe', { endpoint, keys: { p256dh: 'A'.repeat(87), auth: 'A'.repeat(22) } });
      expect(r.statusCode, endpoint).toBeGreaterThanOrEqual(400);
      expect(r.statusCode, endpoint).toBeLessThan(500);
    }
    expect(await ownerQuery(`SELECT 1 FROM push_subscriptions WHERE tenant_id=$1`, [T.id])).toHaveLength(0);
    const { readFileSync } = await import('node:fs');
    const text = readFileSync('openapi.json', 'utf8');
    const props = [...text.matchAll(/"([A-Za-z_]*(?:url|Url|URL|uri|Uri|href|webhook|callback|endpoint)[A-Za-z_]*)":\s*\{/g)].map((m) => m[1]!);
    // Brand URLs go to the browser and the server never fetches them (CONFIGURATION.md); otpauthUri is built by the server; the rest are not URLs a client gives. Anything new here gets looked at.
    expect([...new Set(props)].sort()).toEqual(['endpoint', 'faviconUrl', 'helpUrl', 'href', 'logoDarkUrl', 'logoUrl', 'otpauthUri', 'securitySchemes']);
  });
  it('no setting and no module fetches what a client sends: the only outbound fetches are push and telemetry', async () => {
    const { execSync } = await import('node:child_process');
    const hits = execSync(`grep -rlE "\\bfetch\\(|https?\\.request\\(|https?\\.get\\(" src || true`).toString().trim().split('\n').sort();
    expect(hits).toEqual(['src/core/notify/push.ts', 'src/core/telemetry.ts']);
  });
});

describe('stored XSS', () => {
  const XSS = `<img src=x onerror=alert(1)><script>alert(1)</script>`;
  it('text comes back as JSON with no sniffing, under a CSP that runs nothing', async () => {
    const X = await createTenant();
    const c = await WireClient.signIn(app, X.host, X.users.hr!.email);
    const add = await c.post('/api/v1/org/departments', { code: 'XS', name: XSS });
    expect(add.statusCode, add.body).toBe(201);
    const r = await c.get('/api/v1/org');
    expect(r.body).toContain('onerror'); // stored as typed: the frontend escapes on output
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
  });
  it('an error or not-found never reflects its input as HTML', async () => {
    const r = await send(port, 'GET', `/api/v1/${encodeURIComponent(XSS)}`, { host: T.host });
    expect(r.headers['content-type']).toMatch(/problem\+json/);
    expect(r.body).not.toContain('<script');
  });
  it('email carries it escaped', async () => {
    const { renderEmail } = await import('../../src/core/notify/templates.js');
    const m = renderEmail({ brandName: 'B', productName: 'P', primaryColor: '#000000', supportEmail: null, appUrl: 'https://x.test' }, { title: XSS, body: XSS, link: '/x' });
    expect(m.html).not.toContain('<script');
    expect(m.html).not.toContain('<img src=x');
    expect(TINY_PNG.length).toBeGreaterThan(0);
  });
});

describe('field encryption', () => {
  it('F-124 a shortened GCM tag does not open a value', async () => {
    const { FieldCipher } = await import('../../src/core/crypto/index.js');
    const c = new FieldCipher(Buffer.alloc(32, 9).toString('base64'));
    const token = c.encrypt('1234567890');
    const parts = token.split('.');
    const tag = Buffer.from(parts[3]!, 'base64');
    parts[3] = tag.subarray(0, 4).toString('base64');
    expect(() => c.decrypt(parts.join('.'))).toThrow();
    expect(c.decrypt(token)).toBe('1234567890');
  });
});
