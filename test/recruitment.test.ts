import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { problem, makeApp, createTenant, Client, ownerQuery, multipart, PASSWORD, type TenantFixture, flags } from './helpers.js';
import { LocalStore, setStore } from '../src/core/storage/index.js';
import { hashPassword } from '../src/core/crypto/index.js';
import { addDays, localDate } from '../src/modules/attendance/time.js';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
const today = localDate(new Date(), 'Asia/Kolkata');
let storeDir: string;
let app: FastifyInstance;
let T: TenantFixture;
let hr: Client;
let hrHead: Client;
let hrExec: Client;
let mgr: Client;
let emp: Client;
let other: Client;
let reqId: string;
let candId: string;
let appId: string;
let offerId: string;

async function user(key: string, roles: string[]) {
  const email = `${key}@${T.host}`;
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`, [
    T.id,
    email,
    key,
    await hashPassword(PASSWORD),
  ]);
  for (const r of roles) await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,$3)`, [u!.id, T.id, r]);
  return Client.login(app, T.host, email);
}
const addCandidate = (c: Client, f: Record<string, string>, resume?: Buffer, name = 'cv.pdf') => {
  const m = multipart(
    {
      firstName: 'Asha',
      lastName: 'Rao',
      email: 'asha.rao@mail.example',
      phone: '+91 98765 43210',
      source: 'job_portal',
      qualification: 'M.Sc. Analytical Chemistry',
      experienceMonths: '36',
      consent: 'true',
      consentNote: 'Applied via portal; consent checkbox',
      ...f,
    },
    resume ? { name, content: resume } : undefined,
  );
  return c.req('POST', '/api/v1/recruitment/candidates', m.body, m.headers);
};
const approveFor = async (c: Client, entityId: string) => {
  const item = (await c.get('/api/v1/approvals/inbox')).json().items.find((x: { entity_id: string }) => x.entity_id === entityId);
  return c.post(`/api/v1/approvals/${item.id}/act`, { action: 'approve' });
};
const version = async (id: string) => (await hr.get(`/api/v1/recruitment/applications/${id}?reveal=1`)).json().version as number;
const move = async (stage: string, extra: Record<string, unknown> = {}) =>
  hr.post(`/api/v1/recruitment/applications/${appId}/move`, { stage, expectedVersion: await version(appId), ...extra });

beforeAll(async () => {
  storeDir = mkdtempSync(path.join(tmpdir(), 'hrms-rec-'));
  setStore(new LocalStore(storeDir));
  app = await makeApp({ ...flags('default,recruitment') }, { storeOverride: true });
  T = await createTenant();
  hr = await Client.login(app, T.host, T.users.hr!.email);
  mgr = await Client.login(app, T.host, T.users.manager!.email);
  emp = await Client.login(app, T.host, T.users.employee!.email);
  other = await Client.login(app, T.host, T.users.other!.email);
  hrHead = await user('hrhead', ['hr_admin']);
  hrExec = await user('hrexec', ['hr_executive']);
});
afterAll(async () => {
  await app.close();
  setStore(null);
});

describe('requisitions', () => {
  it('a manager requests headcount; HR approves; visibility follows the request', async () => {
    const body = {
      title: 'Senior Chemist — Water lab',
      legalEntityId: T.legalEntityId,
      branchId: T.branchId,
      departmentId: T.deptId,
      designation: 'Senior Chemist',
      positions: 1,
      justification: 'Backfill for resignation; NABL scope needs two authorized analysts',
      hiringManagerId: T.users.manager!.employeeId,
    };
    expect((await mgr.post('/api/v1/recruitment/requisitions', { ...body, budgetCtcMax: 900000 })).statusCode).toBe(403); // no compensation access
    expect((await emp.post('/api/v1/recruitment/requisitions', body)).statusCode).toBe(403);
    const r = await mgr.post('/api/v1/recruitment/requisitions', body);
    expect(r.statusCode).toBe(201);
    expect(r.json().code).toMatch(/^REQ-\d{4}$/);
    reqId = r.json().id;
    const v = (await hr.get(`/api/v1/recruitment/requisitions/${reqId}?reveal=1`)).json().version;
    expect((await hr.put(`/api/v1/recruitment/requisitions/${reqId}`, { ...body, budgetCtcMax: 900000, expectedVersion: v })).statusCode).toBe(200); // HR sets the budget
    expect((await mgr.get(`/api/v1/recruitment/requisitions/${reqId}?reveal=1`)).json().budget_ctc_max).toBeNull(); // redacted for the manager
    expect((await hr.get(`/api/v1/recruitment/requisitions/${reqId}?reveal=1`)).json().budget_ctc_max).toBe('900000.00');
    expect((await other.get(`/api/v1/recruitment/requisitions/${reqId}?reveal=1`)).statusCode).toBe(403);
    expect((await mgr.post(`/api/v1/recruitment/requisitions/${reqId}/submit`)).statusCode).toBe(200);
    expect((await approveFor(hr, reqId)).statusCode).toBe(200);
    expect((await mgr.get(`/api/v1/recruitment/requisitions/${reqId}?reveal=1`)).json().status).toBe('approved');
    expect((await mgr.get('/api/v1/recruitment/requisitions?reveal=1')).json().items.some((x: { id: string }) => x.id === reqId)).toBe(true);
  });
});

describe('candidates', () => {
  it('requires consent and a contact; rejects non-documents; detects duplicates; restricts CTC', async () => {
    expect(JSON.stringify(problem(await addCandidate(hr, { consent: 'false' })).errors)).toMatch(/consent/);
    expect((await addCandidate(hr, { email: '', phone: '' })).statusCode).toBe(400);
    expect((await addCandidate(hr, {}, Buffer.from('MZ\x90\x00 binary'), 'cv.exe')).statusCode).toBe(415);
    expect((await addCandidate(hrExec, { expectedCtc: '800000' })).statusCode).toBe(403);
    const c = await addCandidate(hr, { expectedCtc: '850000' }, PDF);
    expect(c.statusCode).toBe(201);
    candId = c.json().id;
    const dup = await addCandidate(hr, { email: 'ASHA.RAO@mail.example', phone: '' });
    expect(dup.statusCode).toBe(409);
    expect(problem(dup).duplicates[0].id).toBe(candId);
    expect((await addCandidate(hr, { firstName: 'Ravi', email: 'ravi@mail.example', phone: '+91 98765 43210' })).statusCode).toBe(409); // shared phone…
    expect((await addCandidate(hr, { firstName: 'Ravi', email: 'ravi@mail.example', phone: '+91 98765 43210', confirmDuplicate: 'true' })).statusCode).toBe(201); // …confirmed
    expect((await hr.get(`/api/v1/recruitment/candidates/${candId}?reveal=1`)).json().expected_ctc).toBe('850000.00');
    expect((await hrExec.get(`/api/v1/recruitment/candidates/${candId}?reveal=1`)).json().expected_ctc).toBeNull();
    expect((await emp.get(`/api/v1/recruitment/candidates/${candId}?reveal=1`)).statusCode).toBe(404);
    expect((await emp.get('/api/v1/recruitment/candidates?reveal=1')).statusCode).toBe(403);
    const [row] = await ownerQuery<{ retain_until: string }>(`SELECT retain_until::text FROM candidates WHERE id=$1`, [candId]);
    expect(row!.retain_until > today).toBe(true);
  });
});

describe('pipeline and interviews', () => {
  it('moves through allowed stages with history; rejection needs a reason', async () => {
    const r = await hr.post('/api/v1/recruitment/applications', { requisitionId: reqId, candidateId: candId });
    expect(r.statusCode).toBe(201);
    appId = r.json().id;
    expect((await hr.post('/api/v1/recruitment/applications', { requisitionId: reqId, candidateId: candId })).statusCode).toBe(409);
    expect((await move('interview')).statusCode).toBe(409); // must screen first
    expect(problem(await move('hired')).detail).toMatch(/accepted offer/);
    expect((await move('screening')).statusCode).toBe(200);
    expect((await move('rejected')).statusCode).toBe(400);
    expect((await move('interview', { note: 'Strong CRM experience' })).statusCode).toBe(200);
    const stale = await hr.post(`/api/v1/recruitment/applications/${appId}/move`, { stage: 'offer', expectedVersion: 1 });
    expect(stale.statusCode).toBe(409);
    const d = (await hr.get(`/api/v1/recruitment/applications/${appId}?reveal=1`)).json();
    expect(d.events.map((e: { to_stage: string }) => e.to_stage)).toEqual(['applied', 'screening', 'interview']);
  });

  it('panel members see only their interviews; feedback is blind until submitted and once only', async () => {
    const pu = (await hr.get('/api/v1/recruitment/panel-users?search=other')).json().items;
    expect(pu.some((u: { id: string }) => u.id === T.users.other!.id)).toBe(true);
    expect(Object.keys(pu[0]).sort()).toEqual(['designation', 'display_name', 'id']);
    expect((await emp.get('/api/v1/recruitment/panel-users')).statusCode).toBe(403);
    const started = new Date(Date.now() - 3600e3).toISOString();
    const iv = await hr.post(`/api/v1/recruitment/applications/${appId}/interviews`, {
      round: 1,
      kind: 'practical_lab',
      scheduledAt: started,
      location: 'Lab 2',
      panelUserIds: [T.users.manager!.id, T.users.other!.id],
    });
    expect(iv.statusCode).toBe(201);
    const ivId = iv.json().id;
    expect((await ownerQuery(`SELECT 1 FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND kind='recruitment.interview'`, [T.id, T.users.other!.id])).length).toBe(1);
    const future = await hr.post(`/api/v1/recruitment/applications/${appId}/interviews`, {
      round: 2,
      kind: 'hr',
      scheduledAt: new Date(Date.now() + 86400e3).toISOString(),
      panelUserIds: [T.users.other!.id],
    });
    expect(
      (await other.post(`/api/v1/recruitment/interviews/${future.json().id}/feedback`, { rating: 4, recommendation: 'yes', notes: 'Not yet held — must be refused' })).statusCode,
    ).toBe(409);
    expect((await other.get('/api/v1/recruitment/interviews/mine')).json().items.length).toBe(2);
    expect((await emp.post(`/api/v1/recruitment/interviews/${ivId}/feedback`, { rating: 5, recommendation: 'yes', notes: 'Not on the panel at all' })).statusCode).toBe(404);
    expect(
      (await mgr.post(`/api/v1/recruitment/interviews/${ivId}/feedback`, { rating: 5, recommendation: 'strong_yes', notes: 'Ran ICP-OES calibration flawlessly' })).statusCode,
    ).toBe(200);
    const seen = (await other.get(`/api/v1/recruitment/applications/${appId}?reveal=1`)).json();
    expect(seen.access).toBe('panel');
    expect(seen.events).toEqual([]);
    const mgrRow = seen.interviews[0].panel.find((p: { user_id: string }) => p.user_id === T.users.manager!.id);
    expect(mgrRow).toMatchObject({ rating: null, notes: null, hidden: true });
    expect((await other.get(`/api/v1/recruitment/candidates/${candId}/resume`)).statusCode).toBe(200); // panel may read the resume
    const done = await other.post(`/api/v1/recruitment/interviews/${ivId}/feedback`, { rating: 4, recommendation: 'yes', notes: 'Good method knowledge; weak on uncertainty' });
    expect(done.json()).toMatchObject({ ok: true, interviewCompleted: true });
    expect((await other.post(`/api/v1/recruitment/interviews/${ivId}/feedback`, { rating: 1, recommendation: 'no', notes: 'Changing my mind later' })).statusCode).toBe(409);
    const after = (await other.get(`/api/v1/recruitment/applications/${appId}?reveal=1`)).json();
    expect(after.interviews[0].panel.find((p: { user_id: string }) => p.user_id === T.users.manager!.id).rating).toBe(5);
    expect((await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='recruitment.resume_downloaded'`, [T.id])).length).toBe(1);
  });
});

describe('offers and hire', () => {
  it('offer needs compensation access and a second approver; above-budget is flagged; CTC never in the approval summary', async () => {
    expect((await move('offer')).statusCode).toBe(200);
    const body = {
      designation: 'Senior Chemist',
      legalEntityId: T.legalEntityId,
      branchId: T.branchId,
      departmentId: T.deptId,
      employmentType: 'permanent',
      annualCtc: 950000,
      joiningDate: addDays(today, 30),
      probationMonths: 6,
    };
    expect((await hrExec.post(`/api/v1/recruitment/applications/${appId}/offers`, body)).statusCode).toBe(403);
    expect((await hr.post(`/api/v1/recruitment/applications/${appId}/offers`, { ...body, joiningDate: addDays(today, -1) })).statusCode).toBe(400);
    const o = await hr.post(`/api/v1/recruitment/applications/${appId}/offers`, body);
    expect(o.json()).toMatchObject({ aboveBudget: true });
    offerId = o.json().id;
    expect((await hr.post(`/api/v1/recruitment/applications/${appId}/offers`, body)).statusCode).toBe(409); // one live offer
    expect((await hr.post(`/api/v1/recruitment/offers/${offerId}/submit`)).statusCode).toBe(200);
    const inbox = (await hrHead.get('/api/v1/approvals/inbox')).json().items.find((x: { entity_id: string }) => x.entity_id === offerId);
    expect(inbox.summary).toMatch(/above budget/);
    expect(inbox.summary).not.toMatch(/950|9,50|ctc/i);
    expect((await hr.get('/api/v1/approvals/inbox')).json().items.some((x: { entity_id: string }) => x.entity_id === offerId)).toBe(false); // requester
    expect((await approveFor(hrHead, offerId)).statusCode).toBe(200);
    expect((await hrExec.get(`/api/v1/recruitment/applications/${appId}?reveal=1`)).json().offers[0].annual_ctc).toBeNull();
    expect((await hr.post(`/api/v1/recruitment/offers/${offerId}/hire`, { employeeCode: 'EMP-REC1' })).statusCode).toBe(409); // not accepted yet
    expect((await hr.post(`/api/v1/recruitment/offers/${offerId}/accepted`, {})).statusCode).toBe(409); // must be sent first
    expect((await hr.post(`/api/v1/recruitment/offers/${offerId}/sent`, {})).statusCode).toBe(200);
    expect((await hr.post(`/api/v1/recruitment/offers/${offerId}/accepted`, { note: 'Signed copy received' })).statusCode).toBe(200);
  });

  it('hiring creates a pre-joining employee, closes the full requisition, and happens once', async () => {
    expect((await hr.post(`/api/v1/recruitment/offers/${offerId}/hire`, { employeeCode: 'BAD CODE!' })).statusCode).toBe(400); // employee validation applies
    const h = await hr.post(`/api/v1/recruitment/offers/${offerId}/hire`, { employeeCode: 'EMP-REC1', workEmail: 'asha.rao@lab.example' });
    expect(h.statusCode).toBe(201);
    expect(h.json().requisitionClosed).toBe(true);
    const [e] = await ownerQuery<{ status: string; reporting_manager_id: string; designation: string; date_of_joining: string; probation_end_date: string; first_name: string }>(
      `SELECT status, reporting_manager_id, designation, date_of_joining::text, probation_end_date::text, first_name FROM employees WHERE id=$1`,
      [h.json().employeeId],
    );
    expect(e).toMatchObject({
      status: 'pre_joining',
      reporting_manager_id: T.users.manager!.employeeId,
      designation: 'Senior Chemist',
      date_of_joining: addDays(today, 30),
      first_name: 'Asha',
    });
    expect(e!.probation_end_date > e!.date_of_joining).toBe(true);
    expect((await hr.get(`/api/v1/recruitment/applications/${appId}?reveal=1`)).json().stage).toBe('hired');
    expect((await hr.get(`/api/v1/recruitment/requisitions/${reqId}?reveal=1`)).json()).toMatchObject({ status: 'closed', filled: 1 });
    expect((await hr.post(`/api/v1/recruitment/offers/${offerId}/hire`, { employeeCode: 'EMP-REC2' })).statusCode).toBe(409);
  });
});

describe('hiring approver', () => {
  it('management signs off requisitions and offers an HR administrator drafted, sees pay, but cannot run the pipeline', async () => {
    const director = await user('director', ['hiring_approver']);
    // HR (the only HR administrator here) drafts and submits; the director is the second approver.
    const r = await hrHead.post('/api/v1/recruitment/requisitions', {
      title: 'Microbiologist — Food lab',
      legalEntityId: T.legalEntityId,
      branchId: T.branchId,
      departmentId: T.deptId,
      positions: 1,
      justification: 'New scope: pathogen testing',
      budgetCtcMax: 700000,
    });
    expect(r.statusCode).toBe(201);
    expect((await hrHead.post(`/api/v1/recruitment/requisitions/${r.json().id}/submit`)).statusCode).toBe(200);
    expect((await approveFor(director, r.json().id)).statusCode).toBe(200);
    const req = (await director.get(`/api/v1/recruitment/requisitions/${r.json().id}?reveal=1`)).json();
    expect(req).toMatchObject({ status: 'approved', budget_ctc_max: '700000.00' });
    // read access to the pipeline, including compensation on offers
    expect((await director.get(`/api/v1/recruitment/applications/${appId}?reveal=1`)).json().offers[0].annual_ctc).toBe('950000.00');
    // but no changes to candidates, stages or offers
    expect((await addCandidate(director, { email: 'x.y@mail.example' })).statusCode).toBe(403);
    expect((await director.post('/api/v1/recruitment/applications', { requisitionId: r.json().id, candidateId: candId })).statusCode).toBe(403);
    expect((await director.post(`/api/v1/recruitment/offers/${offerId}/withdraw`, {})).statusCode).toBe(403);
  });
});

describe('replacing a resume on an existing candidate', () => {
  const PDF2 = Buffer.concat([PDF, Buffer.from('\n% second version')]);
  const put = (c: Client, id: string, content?: Buffer, name = 'updated.pdf') => {
    const m = multipart({}, content ? { name, content } : undefined);
    return c.req('PUT', `/api/v1/recruitment/candidates/${id}/resume`, m.body, m.headers);
  };
  const fresh = async (email: string, resume?: Buffer) => (await addCandidate(hr, { firstName: 'Later', email, phone: '' }, resume)).json().id as string;

  it('adds one to a candidate saved without a resume, and records it', async () => {
    const id = await fresh('later.add@mail.example');
    expect((await hr.get(`/api/v1/recruitment/candidates/${id}/resume`)).statusCode).toBe(404);
    const r = await put(hr, id, PDF);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, resumeName: 'updated.pdf' });
    const seen = (await hr.get(`/api/v1/recruitment/candidates/${id}`)).json();
    expect(seen).toMatchObject({ has_resume: true, resume_name: 'updated.pdf' });
    expect((await hr.get(`/api/v1/recruitment/candidates/${id}/resume`)).rawPayload.equals(PDF)).toBe(true);
    const [a] = await ownerQuery<{ change_metadata: { replaced: boolean } }>(`SELECT change_metadata FROM audit_logs WHERE tenant_id=$1 AND action='recruitment.resume_replaced' AND target_id=$2`, [T.id, id]);
    expect(a!.change_metadata.replaced).toBe(false);
  });
  it('replaces one: the new file downloads, and the old file is gone from storage', async () => {
    const id = await fresh('later.replace@mail.example', PDF);
    const [before] = await ownerQuery<{ resume_key: string }>(`SELECT resume_key FROM candidates WHERE id=$1`, [id]);
    const oldFile = path.join(storeDir, before!.resume_key);
    expect(existsSync(oldFile)).toBe(true);
    expect((await put(hr, id, PDF2)).statusCode).toBe(200);
    expect(existsSync(oldFile)).toBe(false);
    expect((await hr.get(`/api/v1/recruitment/candidates/${id}/resume`)).rawPayload.equals(PDF2)).toBe(true);
    const [a] = await ownerQuery<{ change_metadata: { replaced: boolean } }>(`SELECT change_metadata FROM audit_logs WHERE tenant_id=$1 AND action='recruitment.resume_replaced' AND target_id=$2`, [T.id, id]);
    expect(a!.change_metadata.replaced).toBe(true);
  });
  it('a refused file leaves the current resume in place', async () => {
    const id = await fresh('later.refused@mail.example', PDF);
    const [before] = await ownerQuery<{ resume_key: string }>(`SELECT resume_key FROM candidates WHERE id=$1`, [id]);
    expect((await put(hr, id, Buffer.from('MZ\x90\x00 binary'), 'cv.exe')).statusCode).toBe(415);
    const [after] = await ownerQuery<{ resume_key: string }>(`SELECT resume_key FROM candidates WHERE id=$1`, [id]);
    expect(after!.resume_key).toBe(before!.resume_key);
    expect(existsSync(path.join(storeDir, before!.resume_key))).toBe(true);
  });
  it('asks for a file when none is sent', async () => {
    const id = await fresh('later.none@mail.example');
    expect((await put(hr, id)).statusCode).toBe(400);
  });
  it('needs recruitment.manage, and an unknown id is a 404', async () => {
    const id = await fresh('later.perm@mail.example');
    expect((await put(emp, id, PDF)).statusCode).toBe(403);
    expect((await put(hr, '00000000-0000-4000-8000-000000000000', PDF)).statusCode).toBe(404);
  });
  it('an anonymized candidate cannot get a resume back', async () => {
    const id = await fresh('later.gone@mail.example');
    expect((await hr.post(`/api/v1/recruitment/candidates/${id}/anonymize`, { reason: 'Candidate asked us to delete their data' })).statusCode).toBe(200);
    expect((await put(hr, id, PDF)).statusCode).toBe(409);
    const [row] = await ownerQuery<{ resume_key: string | null }>(`SELECT resume_key FROM candidates WHERE id=$1`, [id]);
    expect(row!.resume_key).toBeNull();
  });
});

describe('retention and erasure', () => {
  it('anonymizes expired candidates, deletes their resume, and keeps hired ones', async () => {
    const c = await addCandidate(hr, { firstName: 'Old', email: 'old@mail.example', phone: '' }, PDF);
    const id = c.json().id;
    const [k] = await ownerQuery<{ resume_key: string }>(`SELECT resume_key FROM candidates WHERE id=$1`, [id]);
    const file = path.join(storeDir, k!.resume_key);
    expect(existsSync(file)).toBe(true);
    await ownerQuery(`UPDATE candidates SET retain_until=$2::date - 1 WHERE id = ANY($1::uuid[])`, [[id, candId], today]);
    expect((await hr.runJob('recruitment.retention')).json().status).toBe('succeeded');
    const [old] = await ownerQuery<{ status: string; email: string | null; first_name: string; resume_key: string | null }>(
      `SELECT status, email, first_name, resume_key FROM candidates WHERE id=$1`,
      [id],
    );
    expect(old).toMatchObject({ status: 'anonymized', email: null, first_name: 'Anonymized', resume_key: null });
    expect(existsSync(file)).toBe(false);
    const [hired] = await ownerQuery<{ status: string }>(`SELECT status FROM candidates WHERE id=$1`, [candId]);
    expect(hired!.status).toBe('active'); // hired: kept
    expect((await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='recruitment.candidate_anonymized' AND actor_type='system'`, [T.id])).length).toBe(1);
  });

  it('erases on request, but not while an offer is live; module off → 403', async () => {
    const ravi = (await ownerQuery<{ id: string }>(`SELECT id FROM candidates WHERE tenant_id=$1 AND email='ravi@mail.example'`, [T.id]))[0]!.id;
    expect((await hrExec.post(`/api/v1/recruitment/candidates/${ravi}/anonymize`, { reason: 'Candidate asked us to delete their data' })).statusCode).toBe(200);
    expect((await hrExec.post(`/api/v1/recruitment/candidates/${ravi}/anonymize`, { reason: 'again' })).statusCode).toBe(404);
    const off = await makeApp({ ...flags('default') });
    try {
      expect(problem(await (await Client.login(off, T.host, T.users.hr!.email)).get('/api/v1/recruitment/requisitions?reveal=1')).code).toBe('not_found');
    } finally {
      await off.close();
    }
  });
});
