import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { problem, makeApp, createTenant, Client, ownerQuery, multipart, PASSWORD, type TenantFixture, flags } from './helpers.js';
import { readXlsx } from './helpers.js';
import { LocalStore, setStore } from '../src/core/storage/index.js';
import { hashPassword } from '../src/core/crypto/index.js';
import { localDate } from '../src/modules/attendance/time.js';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
const today = localDate(new Date(), 'Asia/Kolkata');
let app: FastifyInstance; let T: TenantFixture; let hr: Client; let qm: Client; let emp: Client; let other: Client;
let policyId: string;

const draft = (c: Client, id: string, f: Record<string, string>, file?: Buffer) => {
  const m = multipart({ changeSummary: 'Initial issue', effectiveFrom: today, ...f }, file ? { name: 'policy.pdf', content: file } : undefined);
  return c.req('POST', `/api/v1/policies/${id}/versions`, m.body, m.headers);
};
const ack = async (c: Client, versionId: string) => {
  const v = (await c.get(`/api/v1/policies/versions/${versionId}`)).json();
  return c.post(`/api/v1/policies/versions/${versionId}/acknowledge`, { contentSha256: v.contentSha256 });
};

beforeAll(async () => {
  setStore(new LocalStore(mkdtempSync(path.join(tmpdir(), 'hrms-pol-'))));
  app = await makeApp({ ...flags('default,core.policies') }, { storeOverride: true });
  T = await createTenant();
  hr = await Client.login(app, T.host, T.users.hr!.email);
  emp = await Client.login(app, T.host, T.users.employee!.email);
  other = await Client.login(app, T.host, T.users.other!.email);
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,'Quality',$3) RETURNING id`, [T.id, `qm@${T.host}`, await hashPassword(PASSWORD)]);
  await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'quality_manager')`, [u!.id, T.id]);
  qm = await Client.login(app, T.host, `qm@${T.host}`);
});
afterAll(async () => { await app.close(); setStore(null); });

describe('policies', () => {
  let v1: string; let v2: string;
  it('drafts need content; only PDFs; one draft at a time; employees cannot manage', async () => {
    expect((await emp.post('/api/v1/policies', { code: 'COC', title: 'Code of conduct', category: 'code_of_conduct' })).statusCode).toBe(403);
    const p = await hr.post('/api/v1/policies', { code: 'coc', title: 'Code of conduct', category: 'code_of_conduct', owner: 'HR' });
    expect(p.statusCode).toBe(201);
    policyId = p.json().id;
    expect(problem((await draft(hr, policyId, {}))).detail).toMatch(/text, a PDF/);
    expect((await draft(hr, policyId, {}, Buffer.from('MZ\x90\x00 not a pdf'))).statusCode).toBe(415);
    const d = await draft(hr, policyId, { body: 'Be honest. Report conflicts of interest.' }, PDF);
    expect(d.statusCode).toBe(201);
    v1 = d.json().id;
    expect((await draft(hr, policyId, { body: 'Another' })).statusCode).toBe(409);
    expect((await emp.get(`/api/v1/policies/versions/${v1}`)).statusCode).toBe(404); // drafts are not visible to staff
  });

  it('the author cannot publish; another publisher can, and the audience is notified', async () => {
    const self = await hr.post(`/api/v1/policies/versions/${v1}/publish`);
    expect(self.statusCode).toBe(403);
    const r = await qm.post(`/api/v1/policies/versions/${v1}/publish`);
    expect(r.statusCode).toBe(200);
    expect(r.json().notified).toBeGreaterThan(2);
    const n = await ownerQuery(`SELECT 1 FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND kind='policies.published'`, [T.id, T.users.employee!.id]);
    expect(n.length).toBe(1);
    const mine = (await emp.get('/api/v1/policies/mine')).json();
    expect(mine.pending).toBe(1);
    expect(mine.items[0]).toMatchObject({ code: 'COC', version_no: 1, requires_ack: true, acknowledged_at: null });
    const file = await emp.get(`/api/v1/policies/versions/${v1}/file`);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PDF)).toBe(true);
  });

  it('acknowledgement is bound to the content shown, once, and is reported', async () => {
    expect(problem((await emp.post(`/api/v1/policies/versions/${v1}/acknowledge`, { contentSha256: '0'.repeat(64) }))).detail).toMatch(/changed since you opened/);
    const r = await ack(emp, v1);
    expect(r.json()).toMatchObject({ ok: true, alreadyAcknowledged: false });
    expect((await ack(emp, v1)).json().alreadyAcknowledged).toBe(true);
    expect((await emp.get('/api/v1/policies/mine')).json().pending).toBe(0);
    const rep = (await hr.get(`/api/v1/policies/versions/${v1}/acknowledgements?status=acknowledged`)).json();
    expect(rep.total).toBe(1);
    expect(rep.items[0].employee_code).toBeTruthy();
    expect((await hr.get(`/api/v1/policies/versions/${v1}/acknowledgements?status=pending`)).json().total).toBeGreaterThan(0);
    expect((await emp.get(`/api/v1/policies/versions/${v1}/acknowledgements`)).statusCode).toBe(403);
    const csv = (await hr.get(`/api/v1/policies/versions/${v1}/acknowledgements.csv`)).body;
    expect(csv.split('\r\n')[0]).toBe('employee_code,name,branch,department,acknowledged_at,content_sha256');
    expect((await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='policies.acknowledgements_exported'`, [T.id])).length).toBe(1);
    const book = readXlsx((await hr.get(`/api/v1/policies/versions/${v1}/acknowledgements.xlsx`)).rawPayload);
    expect(book['xl/worksheets/sheet1.xml']).toContain('<t xml:space="preserve">Content SHA-256</t>');
    // Evidence cannot be altered by the application role.
    await expect(ownerQuery(`SET ROLE hrms_app; UPDATE policy_acknowledgements SET acknowledged_at=now()`)).rejects.toThrow(/permission denied/);
  });

  it('a new version supersedes the old one and needs a fresh acknowledgement; an old page cannot acknowledge', async () => {
    const before = (await emp.get(`/api/v1/policies/versions/${v1}`)).json();
    v2 = (await draft(hr, policyId, { changeSummary: 'Added gifts section', body: 'Be honest. No gifts above ₹1000.' })).json().id;
    await qm.post(`/api/v1/policies/versions/${v2}/publish`);
    expect(problem((await emp.post(`/api/v1/policies/versions/${v1}/acknowledge`, { contentSha256: before.contentSha256 }))).detail).toMatch(/no longer current/);
    expect((await emp.get(`/api/v1/policies/versions/${v1}`)).statusCode).toBe(200); // still readable: they acknowledged it
    expect((await other.get(`/api/v1/policies/versions/${v1}`)).statusCode).toBe(404); // superseded and never acknowledged
    const mine = (await emp.get('/api/v1/policies/mine')).json();
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({ version_no: 2, acknowledged_at: null });
    const list = (await hr.get('/api/v1/policies')).json().items.find((p: { id: string }) => p.id === policyId);
    expect(list).toMatchObject({ published_version: 2, acknowledged: 0 });
  });

  it('audiences limit who must acknowledge', async () => {
    const [d] = await ownerQuery<{ id: string }>(`INSERT INTO departments (tenant_id, code, name) VALUES ($1,'LABX','Lab X') RETURNING id`, [T.id]);
    await ownerQuery(`UPDATE employees SET department_id=$2 WHERE id=$1`, [T.users.employee!.employeeId, d!.id]);
    const pid = (await hr.post('/api/v1/policies', { code: 'LAB-SAFETY', title: 'Lab X safety rules', category: 'safety' })).json().id;
    const vid = (await draft(hr, pid, { body: 'Wear goggles.', audienceDepartmentIds: d!.id })).json().id;
    expect((await draft(hr, pid, { body: 'x', audienceDepartmentIds: 'not-a-uuid' })).statusCode).toBe(400);
    await qm.post(`/api/v1/policies/versions/${vid}/publish`);
    expect((await emp.get('/api/v1/policies/mine')).json().items.some((i: { code: string }) => i.code === 'LAB-SAFETY')).toBe(true);
    expect((await other.get('/api/v1/policies/mine')).json().items.some((i: { code: string }) => i.code === 'LAB-SAFETY')).toBe(false);
    expect((await other.post(`/api/v1/policies/versions/${vid}/acknowledge`, { contentSha256: 'a'.repeat(64) })).statusCode).toBe(404);
    expect((await hr.get(`/api/v1/policies/versions/${vid}/acknowledgements`)).json().total).toBe(1);
  });

  it('overdue reminders go out once a week; retiring removes the policy from staff lists', async () => {
    await ownerQuery(`UPDATE policy_versions SET published_at = now() - interval '20 days' WHERE id=$1`, [v2]);
    await qm.runJob('policies.ack_reminder');
    await qm.runJob('policies.ack_reminder');
    expect((await ownerQuery(`SELECT 1 FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND kind='policies.ack_overdue'`, [T.id, T.users.employee!.id])).length).toBe(1);
    expect((await emp.get('/api/v1/policies/mine')).json().overdue).toBe(1);
    expect((await emp.post(`/api/v1/policies/${policyId}/retire`, { reason: 'Replaced' })).statusCode).toBe(403); // publishers only
    expect((await qm.post(`/api/v1/policies/${policyId}/retire`, { reason: 'Merged into the employee handbook' })).statusCode).toBe(200);
    expect((await emp.get('/api/v1/policies/mine')).json().items.some((i: { code: string }) => i.code === 'COC')).toBe(false);
  });

  it('is unavailable when the module is off', async () => {
    const off = await makeApp({ ...flags('default') });
    try { expect(problem((await (await Client.login(off, T.host, T.users.hr!.email)).get('/api/v1/policies'))).code).toBe('not_found'); }
    finally { await off.close(); }
  });
});
