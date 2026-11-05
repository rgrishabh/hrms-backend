import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { problem, makeApp, createTenant, Client, ownerQuery, PASSWORD, type TenantFixture, flags } from './helpers.js';
import { hashPassword } from '../src/core/crypto/index.js';
import { addDays, localDate } from '../src/modules/attendance/time.js';

const today = localDate(new Date(), 'Asia/Kolkata');
let app: FastifyInstance; let T: TenantFixture;
let hr: Client; let hrHead: Client; let it_: Client; let mgr: Client; let emp: Client; let other: Client;
let empId: string; let otherId: string;

async function user(key: string, roles: string[]) {
  const email = `${key}@${T.host}`;
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`, [T.id, email, key, await hashPassword(PASSWORD)]);
  for (const r of roles) await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,$3)`, [u!.id, T.id, r]);
  return Client.login(app, T.host, email);
}
const approve = async (c: Client, entityId: string) => {
  const item = (await c.get('/api/v1/approvals/inbox')).json().items.find((x: { entity_id: string }) => x.entity_id === entityId);
  expect(item, 'approval visible to approver').toBeTruthy();
  return c.post(`/api/v1/approvals/${item.id}/act`, { action: 'approve' });
};
const mine = async (c: Client) => (await c.get('/api/v1/lifecycle/tasks/mine')).json().items as { id: string; owner: string; title: string; employee_id: string }[];

beforeAll(async () => {
  app = await makeApp({ ...flags('default,core.onboarding,core.offboarding') });
  T = await createTenant();
  empId = T.users.employee!.employeeId!; otherId = T.users.other!.employeeId!;
  hr = await Client.login(app, T.host, T.users.hr!.email);
  it_ = await Client.login(app, T.host, T.users.it!.email);
  mgr = await Client.login(app, T.host, T.users.manager!.email);
  emp = await Client.login(app, T.host, T.users.employee!.email);
  other = await Client.login(app, T.host, T.users.other!.email);
  hrHead = await user('hrhead', ['hr_admin']);
});
afterAll(async () => { await app.close(); });

describe('onboarding checklists', () => {
  it('needs a template; tasks are dated from the joining date and routed to their owners', async () => {
    expect(problem((await hr.post('/api/v1/lifecycle/checklists', { employeeId: empId }))).detail).toMatch(/template/);
    expect((await emp.post('/api/v1/lifecycle/templates', { kind: 'onboarding', name: 'x', tasks: [{ title: 'x', owner: 'hr' }] })).statusCode).toBe(403);
    const t = await hr.post('/api/v1/lifecycle/templates', { kind: 'onboarding', name: 'Lab joiner', isDefault: true, tasks: [
      { title: 'Collect ID and address proof', owner: 'hr', offsetDays: -3 }, { title: 'Create HRMS and LIMS accounts', owner: 'it', offsetDays: -1 },
      { title: 'Lab safety induction', owner: 'manager', offsetDays: 0 }, { title: 'Read the quality manual', owner: 'employee', offsetDays: 2 }] });
    expect(t.statusCode).toBe(201);
    await ownerQuery(`UPDATE employees SET date_of_joining=$2 WHERE id=$1`, [empId, today]);
    const c = await hr.post('/api/v1/lifecycle/checklists', { employeeId: empId });
    expect(c.statusCode).toBe(201);
    expect((await hr.post('/api/v1/lifecycle/checklists', { employeeId: empId })).statusCode).toBe(409); // one open per kind
    const d = (await hr.get(`/api/v1/lifecycle/checklists/${c.json().id}`)).json();
    expect(d.tasks.map((x: { due_date: string }) => x.due_date)).toEqual([addDays(today, -3), addDays(today, -1), today, addDays(today, 2)]);
    expect((await mine(emp)).map((x) => x.owner)).toEqual(['employee']);
    expect((await mine(mgr)).map((x) => x.owner)).toEqual(['manager']);
    expect((await mine(it_)).map((x) => x.owner)).toEqual(['it']);
    expect((await mine(other))).toEqual([]);
    expect((await ownerQuery(`SELECT 1 FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND kind='lifecycle.onboarding'`, [T.id, T.users.it!.id])).length).toBe(1);
    expect((await other.get(`/api/v1/lifecycle/checklists/${c.json().id}`)).statusCode).toBe(404);
  });

  it('only the owner group completes a task; skipping needs HR and a note; the checklist closes when all are done', async () => {
    const itTask = (await mine(it_))[0]!; const mgrTask = (await mine(mgr))[0]!; const empTask = (await mine(emp))[0]!;
    expect((await mgr.post(`/api/v1/lifecycle/tasks/${itTask.id}/done`, {})).statusCode).toBe(404);
    expect((await it_.post(`/api/v1/lifecycle/tasks/${itTask.id}/done`, { note: 'Accounts created' })).statusCode).toBe(200);
    expect((await it_.post(`/api/v1/lifecycle/tasks/${itTask.id}/done`, {})).statusCode).toBe(409);
    expect((await mgr.post(`/api/v1/lifecycle/tasks/${mgrTask.id}/skip`, { note: 'n/a' })).statusCode).toBe(403);
    expect((await hr.post(`/api/v1/lifecycle/tasks/${mgrTask.id}/skip`, {})).statusCode).toBe(400);
    expect((await hr.post(`/api/v1/lifecycle/tasks/${mgrTask.id}/skip`, { note: 'Induction done at the previous site' })).statusCode).toBe(200);
    await emp.post(`/api/v1/lifecycle/tasks/${empTask.id}/done`, {});
    const hrTask = (await mine(hr)).find((x) => x.employee_id === empId)!;
    await hr.post(`/api/v1/lifecycle/tasks/${hrTask.id}/done`, {});
    const list = (await hr.get('/api/v1/lifecycle/checklists?kind=onboarding')).json().items.find((c: { employee_id: string }) => c.employee_id === empId);
    expect(list).toMatchObject({ status: 'completed', tasks: 4, done: 4 });
    expect((await hr.post(`/api/v1/lifecycle/tasks/${empTask.id}/reopen`, { note: 'Quiz not passed' })).statusCode).toBe(200);
    expect((await hr.get(`/api/v1/lifecycle/checklists/${list.id}`)).json().status).toBe('open');
    await emp.post(`/api/v1/lifecycle/tasks/${empTask.id}/done`, {});
  });

  it('confirms joining only on or after the joining date', async () => {
    await ownerQuery(`UPDATE employees SET status='pre_joining', date_of_joining=$2 WHERE id=$1`, [empId, addDays(today, 5)]);
    expect((await hr.post(`/api/v1/lifecycle/employees/${empId}/joined`)).statusCode).toBe(409);
    await ownerQuery(`UPDATE employees SET date_of_joining=$2 WHERE id=$1`, [empId, today]);
    expect((await hr.post(`/api/v1/lifecycle/employees/${empId}/joined`)).statusCode).toBe(200);
    expect((await ownerQuery<{ status: string }>(`SELECT status FROM employees WHERE id=$1`, [empId]))[0]!.status).toBe('active');
  });
});

describe('probation', () => {
  it('the job opens a review; the manager recommends; HR approval confirms', async () => {
    await ownerQuery(`UPDATE employees SET employment_type='probation', probation_end_date=$2, confirmation_date=NULL WHERE id=$1`, [empId, addDays(today, 10)]);
    expect((await hr.runJob('lifecycle.daily')).json().status).toBe('succeeded');
    const r = (await mgr.get('/api/v1/lifecycle/probation')).json().items.find((x: { employee_id: string }) => x.employee_id === empId);
    expect(r).toMatchObject({ status: 'open', probation_end: addDays(today, 10) });
    expect((await ownerQuery(`SELECT 1 FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND kind='lifecycle.probation'`, [T.id, T.users.manager!.id])).length).toBe(1);
    expect((await emp.get('/api/v1/lifecycle/probation')).json().items).toEqual([]);
    expect((await emp.post(`/api/v1/lifecycle/probation/${r.id}/submit`, { recommendation: 'confirm', comments: 'I deserve it, honestly' })).statusCode).toBe(404);
    expect((await mgr.post(`/api/v1/lifecycle/probation/${r.id}/submit`, { recommendation: 'extend', comments: 'Needs more time on ICP' })).statusCode).toBe(400);
    expect((await mgr.post(`/api/v1/lifecycle/probation/${r.id}/submit`, { recommendation: 'confirm', comments: 'Consistently meets method SOPs; PT results satisfactory' })).statusCode).toBe(200);
    expect((await approve(hr, r.id)).statusCode).toBe(200);
    const [e] = await ownerQuery<{ confirmation_date: string; employment_type: string }>(`SELECT confirmation_date::text, employment_type FROM employees WHERE id=$1`, [empId]);
    expect(e).toEqual({ confirmation_date: addDays(today, 10), employment_type: 'permanent' });
  });

  it('extension moves the end date; HR cannot approve its own submission', async () => {
    await ownerQuery(`UPDATE employees SET employment_type='probation', probation_end_date=$2, confirmation_date=NULL WHERE id=$1`, [otherId, addDays(today, 5)]);
    await hr.runJob('lifecycle.daily');
    const r = (await hr.get('/api/v1/lifecycle/probation?status=open')).json().items.find((x: { employee_id: string }) => x.employee_id === otherId);
    expect((await hr.post(`/api/v1/lifecycle/probation/${r.id}/submit`, { recommendation: 'extend', extendMonths: 3, comments: 'Not yet authorized on two methods' })).statusCode).toBe(200);
    expect((await hr.get('/api/v1/approvals/inbox')).json().items.some((x: { entity_id: string }) => x.entity_id === r.id)).toBe(false);
    await approve(hrHead, r.id);
    const [e] = await ownerQuery<{ probation_end_date: string; confirmation_date: string | null }>(`SELECT probation_end_date::text, confirmation_date::text FROM employees WHERE id=$1`, [otherId]);
    expect(e!.confirmation_date).toBeNull();
    expect(e!.probation_end_date > addDays(today, 80)).toBe(true);
  });
});

describe('separations', () => {
  let sepId: string;
  it('a resignation computes the notice shortfall and goes manager → HR; approval starts exit clearance', async () => {
    await hr.post('/api/v1/lifecycle/templates', { kind: 'offboarding', name: 'Standard exit', isDefault: true, tasks: [
      { title: 'Return lab coat, badge and keys', owner: 'manager', offsetDays: 0 }, { title: 'Disable LIMS access', owner: 'it', offsetDays: 0 },
      { title: 'Recover advances and settle expenses', owner: 'finance', offsetDays: 1 }, { title: 'Handover of open test reports', owner: 'employee', offsetDays: -2 }] });
    expect((await emp.post('/api/v1/lifecycle/separations/resign', { reason: 'x', requestedLwd: today })).statusCode).toBe(400);
    const r = await emp.post('/api/v1/lifecycle/separations/resign', { reason: 'Higher studies', requestedLwd: addDays(today, 10) });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ noticeDaysRequired: 30, shortfallDays: 20 });
    sepId = r.json().id;
    expect((await emp.post('/api/v1/lifecycle/separations/resign', { reason: 'Again', requestedLwd: addDays(today, 30) })).statusCode).toBe(409);
    expect((await hr.get('/api/v1/approvals/inbox')).json().items.some((x: { entity_id: string }) => x.entity_id === sepId)).toBe(false); // manager first
    await approve(mgr, sepId);
    expect((await hr.put(`/api/v1/lifecycle/separations/${sepId}/lwd`, { approvedLwd: addDays(today, 30), waiveShortfall: false })).json().shortfallDays).toBe(0);
    await approve(hr, sepId);
    const d = (await hr.get(`/api/v1/lifecycle/separations/${sepId}`)).json();
    expect(d).toMatchObject({ status: 'approved', approved_lwd: addDays(today, 30) });
    expect(d.checklist.tasks).toHaveLength(4);
    expect(d.employee.status).toBe('on_notice');
    expect((await mine(emp)).some((t) => t.title.startsWith('Handover'))).toBe(true);
  });

  it('exit interview is visible to HR only; completion needs the LWD and every clearance task; then access ends', async () => {
    expect((await emp.post(`/api/v1/lifecycle/separations/${sepId}/exit-interview`, { answers: { reason: 'Higher studies', wouldReturn: 'Yes' } })).statusCode).toBe(200);
    expect((await emp.get(`/api/v1/lifecycle/separations/${sepId}`)).json().exit_interview).toBeUndefined();
    expect((await hr.get(`/api/v1/lifecycle/separations/${sepId}`)).json().exit_interview.reason).toBe('Higher studies');
    expect((await other.get(`/api/v1/lifecycle/separations/${sepId}`)).statusCode).toBe(404);
    expect(problem((await hr.post(`/api/v1/lifecycle/separations/${sepId}/complete`, { rehireEligible: true }))).detail).toMatch(/last working day/);
    await ownerQuery(`UPDATE separations SET approved_lwd=$2::date - 1, notice_date=$2::date - 31 WHERE id=$1`, [sepId, today]);
    await ownerQuery(`UPDATE employees SET date_of_joining=$2::date - 400 WHERE id=$1`, [empId, today]); // joined long before leaving
    expect(problem((await hr.post(`/api/v1/lifecycle/separations/${sepId}/complete`, { rehireEligible: true }))).detail).toMatch(/clearance task/);
    const d = (await hr.get(`/api/v1/lifecycle/separations/${sepId}`)).json();
    for (const t of d.checklist.tasks) await hr.post(`/api/v1/lifecycle/tasks/${t.id}/done`, { note: 'Cleared' });
    expect((await hr.post(`/api/v1/lifecycle/separations/${sepId}/complete`, { rehireEligible: true })).statusCode).toBe(200);
    const [e] = await ownerQuery<{ status: string; exit_date: string }>(`SELECT status, exit_date::text FROM employees WHERE id=$1`, [empId]);
    expect(e).toEqual({ status: 'exited', exit_date: addDays(today, -1) });
    expect((await ownerQuery<{ status: string }>(`SELECT status FROM users WHERE id=$1`, [T.users.employee!.id]))[0]!.status).toBe('disabled');
    expect((await emp.get('/api/v1/auth/me')).statusCode).toBe(401);
  });

  it('HR-initiated separations need a second HR approver; the job ends access after the LWD', async () => {
    expect((await hr.post('/api/v1/lifecycle/separations', { employeeId: T.users.hr!.employeeId ?? otherId, kind: 'termination', reason: 'x self', noticeDate: today, requestedLwd: today })).statusCode)
      .toBe(T.users.hr!.employeeId ? 403 : 201);
    const s = T.users.hr!.employeeId ? (await hr.post('/api/v1/lifecycle/separations', { employeeId: otherId, kind: 'contract_end', reason: 'Contract ends', noticeDate: today, requestedLwd: addDays(today, 1) })).json()
      : { id: (await ownerQuery<{ id: string }>(`SELECT id FROM separations WHERE employee_id=$1 AND status='pending'`, [otherId]))[0]!.id };
    expect((await hr.get('/api/v1/approvals/inbox')).json().items.some((x: { entity_id: string }) => x.entity_id === s.id)).toBe(false);
    await approve(hrHead, s.id);
    await ownerQuery(`UPDATE separations SET approved_lwd=$2::date - 1, notice_date=$2::date - 2 WHERE id=$1`, [s.id, today]);
    const r = (await hr.runJob('lifecycle.daily')).json();
    expect(r.status).toBe('succeeded');
    expect((await ownerQuery<{ status: string }>(`SELECT status FROM users WHERE id=$1`, [T.users.other!.id]))[0]!.status).toBe('disabled');
    expect((await other.get('/api/v1/auth/me')).statusCode).toBe(401);
  });

  it('module off → 403', async () => {
    const off = await makeApp({ ...flags('default') });
    try { expect(problem((await (await Client.login(off, T.host, T.users.hr!.email)).get('/api/v1/lifecycle/separations'))).code).toBe('not_found'); }
    finally { await off.close(); }
  });
});
