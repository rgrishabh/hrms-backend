import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { problem, makeApp, createTenant, Client, ownerQuery, PASSWORD, type TenantFixture, flags } from './helpers.js';
import { hashPassword } from '../src/core/crypto/index.js';
import { addDays, localDate } from '../src/modules/attendance/time.js';

const today = localDate(new Date(), 'Asia/Kolkata');
let app: FastifyInstance; let T: TenantFixture;
let hr: Client; let lab: Client; let qm: Client; let emp: Client; let otherQ: Client;
let empId: string; let otherId: string;
const course: Record<string, string> = {};
let methodId: string;

async function user(key: string, roles: string[]) {
  const email = `${key}@${T.host}`;
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`, [T.id, email, key, await hashPassword(PASSWORD)]);
  for (const r of roles) await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,$3)`, [u!.id, T.id, r]);
  return Client.login(app, T.host, email);
}
const train = (employeeId: string, courseId: string, completedOn = today, result = 'passed') =>
  hr.post('/api/v1/competency/training-records', { employeeId, courseId, completedOn, result, trainer: 'QA team', hours: 4 });
const assess = (c: Client, employeeId: string, o: Record<string, unknown> = {}) =>
  c.post('/api/v1/competency/assessments', { employeeId, methodId, activity: 'perform', approach: 'replicate', assessedOn: today, result: 'competent',
    evidence: 'Six replicates on CRM; RSD 0.8 % within method limit', ...o });
const request = (c: Client, assessmentId: string) => c.post('/api/v1/competency/authorizations', { assessmentId });
const inboxItem = async (c: Client, entityId: string) => (await c.get('/api/v1/approvals/inbox')).json().items.find((x: { entity_id: string }) => x.entity_id === entityId);
const approve = async (c: Client, entityId: string) => c.post(`/api/v1/approvals/${(await inboxItem(c, entityId)).id}/act`, { action: 'approve' });
const check = (c: Client, employeeId: string) => c.get(`/api/v1/competency/check?employeeId=${employeeId}&methodCode=WAT-PH&activity=perform`);

beforeAll(async () => {
  app = await makeApp({ ...flags('default,training,lab.competency') });
  T = await createTenant();
  empId = T.users.employee!.employeeId!; otherId = T.users.other!.employeeId!;
  hr = await Client.login(app, T.host, T.users.hr!.email);
  emp = await Client.login(app, T.host, T.users.employee!.email);
  lab = await user('labmgr', ['laboratory_manager']);
  qm = await user('quality', ['quality_manager']);
  await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'quality_manager')`, [T.users.other!.id, T.id]);
  otherQ = await Client.login(app, T.host, T.users.other!.email); // a quality manager who is also an analyst
  for (const [code, o] of Object.entries({ SAFETY: { name: 'Chemical safety', kind: 'safety', validityMonths: 12 }, PH: { name: 'pH meter operation', kind: 'method', validityMonths: null } })) {
    const r = await hr.post('/api/v1/competency/courses', { code, ...o });
    expect(r.statusCode).toBe(201);
    course[code] = r.json().id;
  }
  const m = await qm.post('/api/v1/competency/methods', { code: 'WAT-PH', name: 'pH by electrometric method', standardRef: 'IS 3025 (Part 11)', discipline: 'Chemical', matrix: 'Water',
    reviewMonths: 12, requiredCourseIds: [course.SAFETY, course.PH] });
  expect(m.statusCode).toBe(201);
  methodId = m.json().id;
});
afterAll(async () => { await app.close(); });

describe('training records', () => {
  it('nobody records or revokes their own training', async () => {
    expect((await train(T.users.hr!.employeeId!, course.PH!)).statusCode).toBe(403);
  });

  it('computes expiry from the course, validates input, and scopes reading to the employee', async () => {
    expect((await emp.post('/api/v1/competency/courses', { code: 'X', name: 'Nope', kind: 'other' })).statusCode).toBe(403);
    expect((await train(empId, course.SAFETY!, addDays(today, 1))).statusCode).toBe(400);
    const r = await train(empId, course.SAFETY!);
    expect(r.statusCode).toBe(201);
    expect(r.json().expiresOn > today).toBe(true);
    const [row] = await ownerQuery<{ months: number }>(`SELECT (extract(year from age(expires_on, completed_on))*12 + extract(month from age(expires_on, completed_on)))::int AS months FROM training_records WHERE id=$1`, [r.json().id]);
    expect(row!.months).toBe(12);
    const mine = (await emp.get('/api/v1/competency/me')).json();
    expect(mine.training).toHaveLength(1);
    expect(mine.training[0]).toMatchObject({ course_code: 'SAFETY', validity: 'valid' });
    expect((await emp.get(`/api/v1/competency/training-records?employeeId=${otherId}`)).statusCode).toBe(404);
    expect((await emp.get('/api/v1/competency/training-records')).json().items.every((t: { employee_id: string }) => t.employee_id === empId)).toBe(true);
    expect((await emp.post('/api/v1/competency/training-records', { employeeId: empId, courseId: course.PH, completedOn: today, result: 'passed' })).statusCode).toBe(403);
    expect((await hr.get(`/api/v1/competency/training-records?employeeId=${empId}`)).json().total).toBe(1);
  });
});

describe('technical authorization', () => {
  let authId: string;
  it('requires every prerequisite training, a competent assessment, and a different quality approver', async () => {
    const s = (await assess(lab, empId)).json().id;
    const r1 = await request(lab, s);
    expect(r1.statusCode).toBe(409);
    expect(problem(r1).code).toBe('prerequisites_missing');
    expect(problem(r1).detail).toMatch(/PH/);
    expect((await train(empId, course.PH!)).statusCode).toBe(201);
    const r2 = await request(lab, s);
    expect(r2.statusCode).toBe(201);
    authId = r2.json().id;
    expect((await request(lab, s)).statusCode).toBe(409); // one pending per person/method/activity
    expect((await check(qm, empId)).json()).toMatchObject({ authorized: false });
    expect(await inboxItem(lab, authId)).toBeUndefined(); // requester never sees own request as approver
    expect((await approve(qm, authId)).statusCode).toBe(200);
    const d = (await qm.get(`/api/v1/competency/authorizations/${authId}`)).json();
    expect(d).toMatchObject({ status: 'authorized', valid_from: today });
    expect(d.review_due.slice(0, 4)).toBe(String(Number(today.slice(0, 4)) + 1));
    expect(d.events.map((e: { action: string }) => e.action)).toEqual(['requested', 'authorized']);
    expect(d.assessment.evidence).toMatch(/RSD/);
    expect(d.employee_user_id).toBeUndefined();
    expect((await check(emp, empId)).json()).toMatchObject({ authorized: true, reasons: [] });
    expect((await check(emp, otherId)).statusCode).toBe(404);
    const n = await ownerQuery(`SELECT 1 FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND kind='competency.authorization'`, [T.id, T.users.employee!.id]);
    expect(n.length).toBe(1);
  });

  it('nobody assesses, requests or grants their own competence', async () => {
    expect((await assess(otherQ, otherId)).statusCode).toBe(403);
    await train(otherId, course.SAFETY!); await train(otherId, course.PH!);
    const s = (await assess(lab, otherId)).json().id;
    const id = (await request(lab, s)).json().id;
    const self = await approve(otherQ, id);
    expect(self.statusCode).toBe(403);
    expect((await qm.get(`/api/v1/competency/authorizations/${id}`)).json().status).toBe('pending'); // rolled back
    expect((await approve(qm, id)).statusCode).toBe(200);
    expect((await otherQ.post(`/api/v1/competency/authorizations/${id}/suspend`, { reason: 'Self' })).statusCode).toBe(403);
    expect((await lab.post(`/api/v1/competency/authorizations/${authId}/suspend`, { reason: 'No permission' })).statusCode).toBe(403);
  });

  it('rejects unusable assessments', async () => {
    const bad = (await assess(lab, empId, { activity: 'review', result: 'not_yet_competent' })).json().id;
    expect(problem((await request(lab, bad))).detail).toMatch(/not find the person competent/);
    const old = (await assess(lab, empId, { activity: 'review', assessedOn: addDays(today, -200) })).json().id;
    expect(problem((await request(lab, old))).detail).toMatch(/older than 180 days/);
    const ok = (await assess(lab, empId, { activity: 'sampling', assessedOn: addDays(today, -10) })).json().id;
    await assess(lab, empId, { activity: 'sampling', assessedOn: addDays(today, -2), result: 'not_yet_competent' });
    expect(problem((await request(lab, ok))).detail).toMatch(/later assessment/);
    expect((await assess(lab, empId, { assessedOn: addDays(today, 1) })).statusCode).toBe(400);
  });

  it('lapsed training takes the authorization out of force; suspension and reinstatement are recorded', async () => {
    const [ph] = await ownerQuery<{ id: string }>(`SELECT id FROM training_records WHERE employee_id=$1 AND course_id=$2`, [empId, course.PH]);
    expect((await hr.post(`/api/v1/competency/training-records/${ph!.id}/revoke`, { reason: 'Recorded against the wrong course' })).statusCode).toBe(200);
    const c = (await check(qm, empId)).json();
    expect(c.authorized).toBe(false);
    expect(c.reasons).toContain('Required training PH not completed');
    const matrix = (await lab.get('/api/v1/competency/matrix')).json();
    const row = matrix.rows.find((r: { employeeId: string }) => r.employeeId === empId);
    expect(row.cells[methodId].perform).toMatchObject({ status: 'authorized', inForce: false });
    expect((await qm.post(`/api/v1/competency/authorizations/${authId}/suspend`, { reason: 'Training record withdrawn' })).statusCode).toBe(200);
    expect((await check(qm, empId)).json().reasons).toContain('Authorization is suspended');
    expect(problem((await qm.post(`/api/v1/competency/authorizations/${authId}/reinstate`, { reason: 'Back' }))).code).toBe('prerequisites_missing');
    await train(empId, course.PH!);
    expect((await qm.post(`/api/v1/competency/authorizations/${authId}/reinstate`, { reason: 'Retrained and verified' })).statusCode).toBe(200);
    expect((await check(qm, empId)).json().authorized).toBe(true);
    const ev = (await qm.get(`/api/v1/competency/authorizations/${authId}`)).json().events.map((e: { action: string; reason: string }) => e.action);
    expect(ev).toEqual(['requested', 'authorized', 'suspended', 'reinstated']);
    expect((await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='competency.authorization_suspended'`, [T.id])).length).toBe(1);
  });

  it('a renewal stays pending without interrupting the authorization in force, then supersedes it', async () => {
    const s = (await assess(lab, empId, { approach: 'proficiency_test', evidence: 'PT round 2026-3, z = 0.6' })).json().id;
    const renewal = (await request(lab, s)).json().id;
    expect((await check(qm, empId)).json().authorized).toBe(true);
    const cell = (await lab.get('/api/v1/competency/matrix')).json().rows.find((r: { employeeId: string }) => r.employeeId === empId).cells[methodId].perform;
    expect(cell.status).toBe('authorized');
    await approve(qm, renewal);
    expect((await qm.get(`/api/v1/competency/authorizations/${authId}`)).json().status).toBe('superseded');
    expect((await check(qm, empId)).json()).toMatchObject({ authorized: true, authorizationId: renewal });
    authId = renewal;
  });

  it('scheduled review expires overdue authorizations and training reminders are sent once', async () => {
    await ownerQuery(`UPDATE lab_authorizations SET review_due=$2::date - 1 WHERE id=$1`, [authId, today]);
    const r = await qm.runJob('competency.review');
    expect(r.json().status).toBe('succeeded');
    expect((await qm.get(`/api/v1/competency/authorizations/${authId}`)).json().status).toBe('expired');
    expect((await check(qm, empId)).json().reasons[0]).toMatch(/No technical authorization/);
    expect((await ownerQuery(`SELECT 1 FROM lab_authorization_events WHERE authorization_id=$1 AND action='expired' AND actor_id IS NULL`, [authId])).length).toBe(1);

    const [s] = await ownerQuery<{ id: string }>(`SELECT id FROM training_records WHERE employee_id=$1 AND course_id=$2 AND status='active'`, [otherId, course.SAFETY]);
    await ownerQuery(`UPDATE training_records SET expires_on=$2::date + 7 WHERE id=$1`, [s!.id, today]);
    expect((await emp.runJob('training.expiry')).statusCode).toBe(403);
    await hr.runJob('training.expiry');
    await hr.runJob('training.expiry');
    const n = await ownerQuery(`SELECT 1 FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND kind='training.expiring'`, [T.id, T.users.other!.id]);
    expect(n.length).toBe(1);
  });
});

describe('exited staff', () => {
  it('an authorization does not hold for someone who has left', async () => {
    const exitedReason = (r: { reasons: string[] }) => r.reasons.some((x) => /no longer employed/i.test(x));
    const first = await check(qm, empId); expect(first.statusCode, first.body).toBe(200); expect(exitedReason(first.json())).toBe(false);
    await ownerQuery(`UPDATE employees SET status='exited', exit_date=$2 WHERE id=$1`, [empId, addDays(today, -1)]);
    const r = (await check(qm, empId)).json();
    expect(r.authorized).toBe(false);
    expect(exitedReason(r)).toBe(true);
    await ownerQuery(`UPDATE employees SET status='active', exit_date=NULL WHERE id=$1`, [empId]);
  });
});

describe('module switch', () => {
  it('is unavailable when not enabled', async () => {
    const off = await makeApp({ ...flags('default') });
    try {
      const c = await Client.login(off, T.host, T.users.hr!.email);
      const r = await c.get('/api/v1/competency/courses');
      expect(r.statusCode).toBe(404);
    } finally { await off.close(); }
  });
});
