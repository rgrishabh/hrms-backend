import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStore, setStore } from '../src/core/storage/index.js';
import { TEST_BRAND } from './env.js';
import { Client, createTenant, makeApp, multipart, ownerQuery, type TenantFixture } from './helpers.js';
import { pdfPages, pdfText } from './pdf-text.js';

function realPng() {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 200, 30, 30]))), chunk('IEND', Buffer.alloc(0))]);
}
const T_SUPPORT = TEST_BRAND.BRAND_SUPPORT_EMAIL;
const images = (b: Buffer) => (b.toString('latin1').match(/\/Subtype \/Image/g) ?? []).length;

let app: FastifyInstance;
let T: TenantFixture;
let root: string;
let hr: Client;
let employee: Client;
const emp = (k: string) => T.users[k]!.employeeId!;
const photo = (c: Client, id: string, file: { name: string; content: Buffer }) => {
  const m = multipart({}, file);
  return c.req('PUT', `/api/v1/employees/${id}/photo`, m.body, m.headers);
};
const audits = (action: string) => ownerQuery<{ target_id: string | null; change_metadata: Record<string, unknown> }>(`SELECT target_id, change_metadata FROM audit_logs WHERE tenant_id=$1 AND action=$2 ORDER BY created_at`, [T.id, action]);

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hrms-cards-'));
  setStore(new LocalStore(root));
  app = await makeApp({}, { storeOverride: true });
  T = await createTenant();
  hr = await Client.login(app, T.host, T.users.hr!.email);
  employee = await Client.login(app, T.host, T.users.employee!.email);
});
afterAll(async () => {
  await app.close();
  setStore(null);
  await rm(root, { recursive: true, force: true });
});

describe('ID card', () => {
  it('prints the person, the employer and a box for the photo; recorded', async () => {
    const before = (await audits('employee.cards_printed')).length;
    const r = await hr.get(`/api/v1/employees/${emp('employee')}/id-card.pdf`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toBe('attachment; filename="id-card.pdf"');
    const [row] = await ownerQuery<{ employee_code: string; first_name: string }>('SELECT employee_code, first_name FROM employees WHERE id=$1', [emp('employee')]);
    const text = await pdfText(r.rawPayload);
    const [company] = await ownerQuery<{ name: string }>('SELECT name FROM legal_entities WHERE tenant_id=$1 ORDER BY created_at LIMIT 1', [T.id]);
    for (const want of [company!.name, row!.first_name, row!.employee_code, 'Affix photo', 'This card is the property of', 'Date of joining']) expect(text).toContain(want);
    expect((await pdfPages(r.rawPayload)).length).toBe(1);
    const rows = await audits('employee.cards_printed');
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)).toMatchObject({ target_id: emp('employee'), change_metadata: { kind: 'id', count: 1 } });
  });

  it('a photo prints on the card and is filed as a document; a new one archives the last', async () => {
    const r = await photo(hr, emp('employee'), { name: 'me.png', content: realPng() });
    expect(r.statusCode, r.body).toBe(200);
    const card = await hr.get(`/api/v1/employees/${emp('employee')}/id-card.pdf`);
    expect(await pdfText(card.rawPayload)).not.toContain('Affix photo');
    expect(images(card.rawPayload)).toBe(1);
    expect((await photo(hr, emp('employee'), { name: 'new.png', content: realPng() })).statusCode).toBe(200);
    const docs = await ownerQuery<{ status: string; code: string }>(
      `SELECT d.status, c.code FROM documents d JOIN document_categories c ON c.id=d.category_id WHERE d.tenant_id=$1 AND d.employee_id=$2 ORDER BY d.created_at`,
      [T.id, emp('employee')],
    );
    expect(docs).toEqual([{ status: 'archived', code: 'PHOTO' }, { status: 'active', code: 'PHOTO' }]);
    expect((await audits('employee.photo_updated')).at(-1)!.change_metadata).toMatchObject({ replaced: true });
  });

  it('only a JPEG or PNG photo of sensible size', async () => {
    const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
    const r = await photo(hr, emp('manager'), { name: 'x.pdf', content: pdf });
    expect(r.statusCode).toBe(415);
    const big = Buffer.concat([realPng(), Buffer.alloc(2 * 1024 * 1024 + 1)]);
    expect((await photo(hr, emp('manager'), { name: 'big.png', content: big })).statusCode).toBe(413);
    expect((await ownerQuery(`SELECT 1 FROM documents WHERE tenant_id=$1 AND employee_id=$2`, [T.id, emp('manager')])).length).toBe(0);
  });

  it('is refused for someone who has left, or was never here', async () => {
    const [{ id }] = await ownerQuery<{ id: string }>(
      `INSERT INTO employees (tenant_id, employee_code, first_name, legal_entity_id, branch_id, employment_type, status, date_of_joining, exit_date)
      SELECT tenant_id, 'LEFT-1', 'Gone', legal_entity_id, branch_id, employment_type, 'exited', date_of_joining, date_of_joining + 1 FROM employees WHERE id=$1 RETURNING id`,
      [emp('employee')],
    ) as [{ id: string }];
    expect((await hr.get(`/api/v1/employees/${id}/id-card.pdf`)).statusCode).toBe(409);
    expect((await hr.get(`/api/v1/employees/${id}/business-card.pdf`)).statusCode).toBe(409);
    expect((await hr.get('/api/v1/employees/00000000-0000-4000-8000-000000000000/id-card.pdf')).statusCode).toBe(404);
  });
});

describe('business card', () => {
  it("one person's card fills a sheet with their work email, role and phone", async () => {
    await ownerQuery(`UPDATE employees SET phone='+91 90000 12345', designation='Senior Analyst' WHERE id=$1`, [emp('employee')]);
    const r = await hr.get(`/api/v1/employees/${emp('employee')}/business-card.pdf`);
    expect(r.statusCode, r.body).toBe(200);
    const text = await pdfText(r.rawPayload);
    expect(text.match(/Senior Analyst/g)).toHaveLength(10);
    expect(text).toContain('Print both sides');
    expect(text).toContain('+91 90000 12345');
    const pages = await pdfPages(r.rawPayload);
    expect(pages.length).toBe(2);
    expect(pages[0]).toContain('Senior Analyst');
    expect(pages[1]).not.toContain('Senior Analyst');
    expect(pages[1]).toContain(T_SUPPORT);
    expect((await audits('employee.cards_printed')).at(-1)!.change_metadata).toMatchObject({ kind: 'business', count: 1, phonesPrinted: 1 });
  });

  it('a phone this reader may not see stays off the card', async () => {
    await ownerQuery(`UPDATE employees SET phone='+91 90000 77777' WHERE id=$1`, [emp('manager')]);
    await ownerQuery(`UPDATE users SET salary_access_level=95 WHERE id=$1`, [T.users.manager!.id]);
    try {
      const r = await hr.get(`/api/v1/employees/${emp('manager')}/business-card.pdf`);
      expect(r.statusCode, r.body).toBe(200);
      expect(await pdfText(r.rawPayload)).not.toContain('+91 90000 77777');
      expect((await audits('employee.cards_printed')).at(-1)!.change_metadata).toMatchObject({ phonesPrinted: 0 });
    } finally {
      await ownerQuery(`UPDATE users SET salary_access_level=0 WHERE id=$1`, [T.users.manager!.id]);
    }
  });
});

describe('everyone at once', () => {
  it('prints current employees only, one business card each, over as many pages as it takes', async () => {
    const [{ n }] = await ownerQuery<{ n: string }>(`SELECT count(*) AS n FROM employees WHERE tenant_id=$1 AND status IN ('active','on_notice') AND erased_at IS NULL`, [T.id]) as [{ n: string }];
    const ids = await hr.get('/api/v1/employees/cards/id-cards.pdf');
    expect(ids.statusCode, ids.body).toBe(200);
    expect(await pdfText(ids.rawPayload)).not.toContain('Gone');
    expect((await pdfPages(ids.rawPayload)).length).toBe(Math.ceil(Number(n) / 4));
    expect((await audits('employee.cards_printed')).at(-1)).toMatchObject({ target_id: null, change_metadata: { kind: 'id', count: Number(n) } });
    const cards = await hr.get('/api/v1/employees/cards/business-cards.pdf');
    expect(cards.statusCode, cards.body).toBe(200);
    expect((await pdfPages(cards.rawPayload)).length).toBe(Math.ceil(Number(n) / 10) * 2);
  });

  it('follows the branch and department chosen, and says so when nobody matches', async () => {
    const [{ branch_id }] = await ownerQuery<{ branch_id: string }>('SELECT branch_id FROM employees WHERE id=$1', [emp('employee')]) as [{ branch_id: string }];
    expect((await hr.get(`/api/v1/employees/cards/id-cards.pdf?branchId=${branch_id}`)).statusCode).toBe(200);
    const none = await hr.get('/api/v1/employees/cards/id-cards.pdf?departmentId=00000000-0000-4000-8000-000000000000');
    expect(none.statusCode).toBe(404);
    expect(none.json().detail).toContain('No current employees');
  });
});

describe('a logo on many cards', () => {
  it('is stored once in the file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hrms-cards-brand-'));
    await writeFile(path.join(dir, 'logo.png'), realPng());
    const branded = await makeApp({ BRAND_LOGO_URL: '/brand/logo.png' }, { storeOverride: true, brandDirOverride: dir });
    try {
      const c = await Client.login(branded, T.host, T.users.hr!.email);
      const r = await c.get(`/api/v1/employees/${emp('employee')}/business-card.pdf`);
      expect(r.statusCode, r.body).toBe(200);
      expect(images(r.rawPayload)).toBe(1);
    } finally {
      await branded.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('who may print', () => {
  it('nobody without employees.manage, not even for themselves', async () => {
    for (const url of [`/api/v1/employees/${emp('employee')}/id-card.pdf`, `/api/v1/employees/${emp('employee')}/business-card.pdf`, '/api/v1/employees/cards/id-cards.pdf', '/api/v1/employees/cards/business-cards.pdf'])
      expect((await employee.get(url)).statusCode, url).toBe(403);
    expect((await photo(employee, emp('employee'), { name: 'me.png', content: realPng() })).statusCode).toBe(403);
  });
});

describe('other organizations', () => {
  it('cannot print or change a card across organizations', async () => {
    const other = await createTenant();
    const theirs = await Client.login(app, other.host, other.users.hr!.email);
    expect((await theirs.get(`/api/v1/employees/${emp('employee')}/id-card.pdf`)).statusCode).toBe(404);
  });
});
