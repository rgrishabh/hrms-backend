import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture } from './helpers.js';
import { addDays, localDate } from '../src/modules/attendance/time.js';

const today = localDate(new Date(), 'Asia/Kolkata');
let app: FastifyInstance; let T: TenantFixture;
let admin: Client; let hr: Client; let emp: Client; let other: Client; let mgr: Client; let itU: Client;
let poshId: string;
const DESC = 'Repeated unwelcome remarks about appearance in the sample-prep room, in front of colleagues.';
const detail = async (c: Client, id: string) => c.get(`/api/v1/cases/${id}`);
const version = async (c: Client, id: string) => (await detail(c, id)).json().version as number;

beforeAll(async () => {
  app = await makeApp({ ENABLED_MODULES: 'default,posh,grievance' });
  T = await createTenant();
  admin = await Client.login(app, T.host, T.users.admin!.email);
  hr = await Client.login(app, T.host, T.users.hr!.email);
  emp = await Client.login(app, T.host, T.users.employee!.email);
  other = await Client.login(app, T.host, T.users.other!.email);
  mgr = await Client.login(app, T.host, T.users.manager!.email);
  itU = await Client.login(app, T.host, T.users.it!.email);
});
afterAll(async () => { await app.close(); });

describe('POSH', () => {
  it('needs an Internal Committee; administrators maintain it but cannot read complaints', async () => {
    const body = { kind: 'posh', category: 'verbal', description: DESC, incidentDate: addDays(today, -10), respondentEmployeeId: T.users.other!.employeeId };
    expect((await emp.post('/api/v1/cases', body)).statusCode).toBe(409);
    expect((await emp.put('/api/v1/cases/committee', { members: [{ userId: T.users.it!.id, role: 'presiding_officer' }], external: [] })).statusCode).toBe(403);
    expect((await admin.put('/api/v1/cases/committee', { members: [{ userId: T.users.it!.id, role: 'member' }], external: [] })).statusCode).toBe(400); // presiding officer required
    expect((await admin.put('/api/v1/cases/committee', { members: [{ userId: T.users.it!.id, role: 'presiding_officer' }, { userId: T.users.manager!.id, role: 'member' }],
      external: [{ name: 'A. Sharma', organization: 'Women Rights NGO, Pune', since: '2026-01-01' }] })).statusCode).toBe(200);
    expect((await emp.get('/api/v1/cases/committee')).json().members).toHaveLength(2);
    expect((await admin.get('/api/v1/cases/people?search=it')).json().items.some((u: { id: string }) => u.id === T.users.it!.id)).toBe(true);
    expect((await emp.get('/api/v1/cases/people')).statusCode).toBe(403); // composition is public within the organization
    expect((await emp.post('/api/v1/cases', { ...body, anonymous: true })).statusCode).toBe(400);
    expect((await emp.post('/api/v1/cases', { ...body, incidentDate: addDays(today, -120) })).json().error.message).toMatch(/three months/);
    const r = await emp.post('/api/v1/cases', body);
    expect(r.statusCode).toBe(201);
    expect(r.json().reference).toBe('IC-0001');
    poshId = r.json().id;
    const n = await ownerQuery<{ title: string; body: string }>(`SELECT title, body FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND kind='cases.posh'`, [T.id, T.users.it!.id]);
    expect(n[0]!.title).toBe('New POSH complaint IC-0001');
    expect(JSON.stringify(n)).not.toMatch(/remarks|Emp|Other/);
    const [row] = await ownerQuery<{ description_enc: string }>(`SELECT description_enc FROM cases WHERE id=$1`, [poshId]);
    expect(row!.description_enc).not.toContain('unwelcome');
    for (const c of [admin, hr, other]) expect((await detail(c, poshId)).statusCode).toBe(404);
    expect((await admin.get('/api/v1/cases?kind=posh&scope=handling')).statusCode).toBe(403);
    expect((await ownerQuery(`SELECT change_metadata::text AS m FROM audit_logs WHERE tenant_id=$1 AND action='cases.posh_filed'`, [T.id]))[0]!.m).not.toContain('unwelcome');
  });

  it('the IC works the case; the complainant sees only shared updates; timelines follow the Act', async () => {
    const d = (await detail(mgr, poshId)).json();
    expect(d).toMatchObject({ role: 'handler', description: DESC, respondentName: expect.any(String), inquiryDue: addDays(today, 90), allowedMoves: ['conciliation', 'inquiry'] });
    await mgr.post(`/api/v1/cases/${poshId}/events`, { text: 'Copy of the complaint sent to the respondent within 7 days (s.11).', expectedVersion: d.version });
    await itU.post(`/api/v1/cases/${poshId}/events`, { text: 'Inquiry started; hearings scheduled.', toStatus: 'inquiry', expectedVersion: await version(itU, poshId) });
    expect((await itU.post(`/api/v1/cases/${poshId}/events`, { text: 'Skip ahead', toStatus: 'closed', expectedVersion: await version(itU, poshId) })).statusCode).toBe(409);
    await itU.post(`/api/v1/cases/${poshId}/events`, { text: 'Inquiry completed; report to the employer.', toStatus: 'report_submitted', expectedVersion: await version(itU, poshId) });
    expect((await detail(itU, poshId)).json().reportDue).toBe(addDays(today, 10));
    expect((await itU.post(`/api/v1/cases/${poshId}/events`, { text: 'Closing', toStatus: 'closed', expectedVersion: await version(itU, poshId) })).statusCode).toBe(400);
    expect((await itU.post(`/api/v1/cases/${poshId}/events`, { text: 'Employer acted on the recommendations.', toStatus: 'closed', outcome: 'Allegations proved; written warning and transfer recommended.', expectedVersion: await version(itU, poshId) })).statusCode).toBe(201);
    const mine = (await detail(emp, poshId)).json();
    expect(mine.role).toBe('complainant');
    expect(mine.respondentName).toBeUndefined();
    expect(mine.events.map((e: { text: string }) => e.text)).not.toContain('Copy of the complaint sent to the respondent within 7 days (s.11).');
    expect(mine.events.every((e: { actor: string }) => ['Internal Committee', 'Complainant'].includes(e.actor))).toBe(true);
    expect(mine.status).toBe('closed');
    expect((await ownerQuery(`SELECT 1 FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND kind='cases.update'`, [T.id, T.users.employee!.id])).length).toBeGreaterThan(0);
    const rep = (await admin.get(`/api/v1/cases/posh/annual-report?year=${today.slice(0, 4)}`)).json();
    expect(rep).toMatchObject({ received: 1, disposed: 1, pending: 0 });
    expect((await emp.get(`/api/v1/cases/posh/annual-report?year=${today.slice(0, 4)}`)).statusCode).toBe(403);
  });

  it('a committee member who is a party to the case is excluded from it', async () => {
    const r = await itU.post('/api/v1/cases', { kind: 'grievance', category: 'facilities', description: 'The fume hood in lab 3 has not been serviced for months.' });
    expect(r.statusCode).toBe(400); // IT admin has no employee record → not anonymous → refused
    const c = await mgr.post('/api/v1/cases', { kind: 'posh', category: 'online', description: 'Offensive messages received on the team chat group after hours.', incidentDate: today });
    expect(c.statusCode).toBe(201);
    expect((await detail(mgr, c.json().id)).json().role).toBe('complainant'); // never handler of their own complaint
    expect((await mgr.get('/api/v1/cases?kind=posh&scope=handling')).json().items.some((x: { id: string }) => x.id === c.json().id)).toBe(false);
    expect((await detail(itU, c.json().id)).json().role).toBe('handler');
  });
});

describe('confidentiality of who filed and who handles', () => {
  it('audit history never names the complainant or their address; handlers stay accountable', async () => {
    const rows = await ownerQuery<{ action: string; actor_id: string | null; ip: string | null; m: { actor?: string; role?: string } }>(
      `SELECT action, actor_id, ip, change_metadata AS m FROM audit_logs WHERE tenant_id=$1 AND target_id=$2 ORDER BY created_at`, [T.id, poshId]);
    const byComplainant = rows.filter((r) => r.action === 'cases.posh_filed' || r.m.role === 'complainant');
    expect(byComplainant.length).toBeGreaterThan(0);
    for (const r of byComplainant) expect(r).toMatchObject({ actor_id: null, ip: null, m: { actor: 'complainant' } });
    expect(rows.some((r) => r.action === 'cases.viewed' && r.m.role === 'handler' && r.actor_id !== null)).toBe(true);
    const audit = (await admin.get('/api/v1/tenant/audit?action=cases.')).json();
    expect(JSON.stringify(audit)).not.toContain(T.users.employee!.email.split('@')[0]);
  });

  it('nobody adds themselves to the Internal Committee; every change is recorded and announced to members', async () => {
    const current = (await admin.get('/api/v1/cases/committee')).json().members.map((m: { user_id: string; role: string }) => ({ userId: m.user_id, role: m.role }));
    const external = [{ name: 'A. Sharma', organization: 'Women Rights NGO, Pune', since: '2026-01-01' }];
    const self = await admin.put('/api/v1/cases/committee', { members: [...current, { userId: T.users.admin!.id, role: 'member' }], external });
    expect(self.statusCode).toBe(403);
    expect((await hr.put('/api/v1/cases/committee', { members: [...current, { userId: T.users.admin!.id, role: 'member' }], external })).statusCode).toBe(200);
    const [a] = await ownerQuery<{ m: { added: string[]; removed: string[] } }>(`SELECT change_metadata AS m FROM audit_logs WHERE tenant_id=$1 AND action='posh.committee_updated' ORDER BY created_at DESC LIMIT 1`, [T.id]);
    expect(a!.m).toMatchObject({ added: [T.users.admin!.id], removed: [] });
    const n = await ownerQuery<{ body: string }>(`SELECT body FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND kind='cases.committee'`, [T.id, T.users.it!.id]);
    expect(n.at(-1)!.body).toMatch(/^Added: /);
    // restore (by another administrator; removing yourself is allowed)
    expect((await hr.put('/api/v1/cases/committee', { members: current, external })).statusCode).toBe(200);
  });
});

describe('grievances', () => {
  it('anonymous grievances reach HR; assignment, complainant comments, resolve, reopen, withdraw', async () => {
    const r = await emp.post('/api/v1/cases', { kind: 'grievance', category: 'safety', description: 'Spill kits in the solvent store are empty and nobody refills them.', anonymous: true });
    expect(r.statusCode).toBe(201);
    const id = r.json().id;
    const h = (await detail(hr, id)).json();
    expect(h).toMatchObject({ role: 'handler', anonymous: true, complainantName: null, slaDue: addDays(today, 15) });
    expect((await detail(mgr, id)).statusCode).toBe(404);
    expect((await hr.post(`/api/v1/cases/${id}/assign`, { userId: T.users.employee!.id })).statusCode).toBe(400); // the complainant
    expect((await hr.post(`/api/v1/cases/${id}/assign`, { userId: T.users.manager!.id })).statusCode).toBe(200);
    expect((await detail(mgr, id)).json().role).toBe('handler');
    await emp.post(`/api/v1/cases/${id}/events`, { text: 'Still empty this morning.', expectedVersion: await version(emp, id) });
    expect((await emp.post(`/api/v1/cases/${id}/events`, { text: 'Close it', toStatus: 'closed', expectedVersion: await version(emp, id) })).statusCode).toBe(403);
    await mgr.post(`/api/v1/cases/${id}/events`, { text: 'Kits refilled; monthly check added to the EHS calendar.', toStatus: 'resolved', expectedVersion: await version(mgr, id) });
    expect((await emp.post(`/api/v1/cases/${id}/events`, { text: 'Empty again after a week.', toStatus: 'reopened', expectedVersion: await version(emp, id) })).statusCode).toBe(201);
    expect((await detail(emp, id)).json().status).toBe('reopened');
    expect((await emp.post(`/api/v1/cases/${id}/withdraw`, { reason: 'Handled informally with the store keeper.' })).statusCode).toBe(200);
    expect((await mine(emp)).some((c) => c.id === id && c.status === 'withdrawn')).toBe(true);
    const stale = await mgr.post(`/api/v1/cases/${id}/events`, { text: 'late', expectedVersion: 1 });
    expect(stale.statusCode).toBe(409);
  });

  it('timeline reminders; module off → 403', async () => {
    const c = await emp.post('/api/v1/cases', { kind: 'posh', category: 'physical', description: 'Unwanted physical contact while handing over samples at the reception desk.', incidentDate: today });
    await ownerQuery(`UPDATE cases SET inquiry_due=$2::date + 7 WHERE id=$1`, [c.json().id, today]);
    expect((await hr.runJob('cases.deadlines')).json().status).toBe('succeeded');
    expect((await ownerQuery(`SELECT 1 FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND kind='cases.deadline'`, [T.id, T.users.it!.id])).length).toBe(1);
    const off = await makeApp({ ENABLED_MODULES: 'default' });
    try { expect((await (await Client.login(off, T.host, T.users.employee!.email)).get('/api/v1/cases?kind=grievance')).json().error.code).toBe('feature_unavailable'); }
    finally { await off.close(); }
  });
});

const mine = async (c: Client) => (await c.get('/api/v1/cases?kind=grievance&scope=mine')).json().items as { id: string; status: string }[];
