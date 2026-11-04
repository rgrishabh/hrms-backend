import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, multipart, type TenantFixture, flags } from './helpers.js';
import { TEST_OWNER_URL } from './env.js';
import { caseDeadlines } from '../src/modules/cases/routes.js';
import { addDays, localDate } from '../src/modules/attendance/time.js';
import type { Db } from '../src/db/tx.js';

const today = localDate(new Date(), 'Asia/Kolkata');
let app: FastifyInstance;
beforeAll(async () => { app = await makeApp({ ...flags('default,recruitment,posh,grievance') }); });
afterAll(async () => { await app.close(); });

describe('recruitment requisition checks', () => {
  let T: TenantFixture; let hr: Client; let mgr: Client; let reqId: string; let appId: string; let candId: string;
  const REQ = () => ({ title: 'Chemist', legalEntityId: T.legalEntityId, branchId: T.branchId, departmentId: T.deptId, designation: 'Chemist', positions: 2, justification: 'Fixture headcount need', hiringManagerId: T.users.manager!.employeeId });
  const offer = () => ({ designation: 'Chemist', legalEntityId: T.legalEntityId, branchId: T.branchId, departmentId: T.deptId, employmentType: 'permanent', annualCtc: 500000, joiningDate: addDays(today, 30) });
  const setReq = (status: string) => ownerQuery(`UPDATE job_requisitions SET status=$2 WHERE id=$1`, [reqId, status]);

  beforeAll(async () => {
    T = await createTenant();
    hr = await Client.login(app, T.host, T.users.hr!.email);
    mgr = await Client.login(app, T.host, T.users.manager!.email);
    reqId = (await hr.post('/api/v1/recruitment/requisitions', REQ())).json().id;
    const m = multipart({ firstName: 'Asha', email: 'asha@mail.example', source: 'job_portal', consent: 'true', consentNote: 'Consent recorded for the fixture' });
    candId = (await hr.req('POST', '/api/v1/recruitment/candidates', m.body, m.headers)).json().id;
  });

  it('only the requester or HR can submit a requisition, as with editing', async () => {
    const r = await mgr.post(`/api/v1/recruitment/requisitions/${reqId}/submit`);   // the named hiring manager, not its author
    expect(r.statusCode).toBe(403);
  });

  it('an offer needs an open requisition', async () => {
    await setReq('approved');
    appId = (await hr.post('/api/v1/recruitment/applications', { requisitionId: reqId, candidateId: candId })).json().id;
    await ownerQuery(`UPDATE job_applications SET stage='offer' WHERE id=$1`, [appId]);
    await setReq('on_hold');
    const r = await hr.post(`/api/v1/recruitment/applications/${appId}/offers`, offer());
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toMatch(/requisition/i);
    await setReq('approved');
    const o = await hr.post(`/api/v1/recruitment/applications/${appId}/offers`, offer());
    expect(o.statusCode, o.body).toBe(201);
    await setReq('cancelled');
    expect((await hr.post(`/api/v1/recruitment/offers/${o.json().id}/submit`)).statusCode).toBe(409);
    await setReq('approved');
    await ownerQuery(`UPDATE job_offers SET status='accepted' WHERE id=$1`, [o.json().id]);
    await setReq('on_hold');
    const hire = await hr.post(`/api/v1/recruitment/offers/${o.json().id}/hire`, { employeeCode: 'N1' });
    expect(hire.statusCode).toBe(409);
    expect(hire.json().error.message).toMatch(/requisition/i);
    await setReq('approved');
    expect((await hr.post(`/api/v1/recruitment/offers/${o.json().id}/hire`, { employeeCode: 'N1' })).statusCode).toBe(201);
  });
});

describe('cases: anonymity and respondents', () => {
  const DESC = 'Repeated unfair treatment in shift allocation over several months, with examples.';
  const noticesFor = (T: TenantFixture, userId: string, kind: string) => ownerQuery(`SELECT 1 FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND kind=$3`, [T.id, userId, kind]);

  it('assigning the complainant of an anonymous grievance gives no hint of who filed it', async () => {
    const T = await createTenant();
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    const c = await emp.post('/api/v1/cases', { kind: 'grievance', category: 'other', description: DESC, anonymous: true, respondentEmployeeId: T.users.other!.employeeId });
    expect(c.statusCode, c.body).toBe(201);
    const complainant = await hr.post(`/api/v1/cases/${c.json().id}/assign`, { userId: T.users.employee!.id });
    const respondent = await hr.post(`/api/v1/cases/${c.json().id}/assign`, { userId: T.users.other!.id });
    expect(complainant.statusCode).toBe(400);
    expect(respondent.statusCode).toBe(400);
    expect(complainant.json().error.message).toBe(respondent.json().error.message);
    expect(complainant.json().error.message).not.toMatch(/complainant/i);
  });

  it('a respondent holding grievance.manage is not told about the case, now or at its deadlines', async () => {
    const T = await createTenant();
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    const c = await emp.post('/api/v1/cases', { kind: 'grievance', category: 'other', description: DESC, respondentEmployeeId: T.users.hr!.employeeId });
    expect(c.statusCode, c.body).toBe(201);
    expect(await noticesFor(T, T.users.hr!.id, 'cases.grievance')).toHaveLength(0);
    await ownerQuery(`UPDATE cases SET sla_due=$2 WHERE id=$1`, [c.json().id, addDays(today, -1)]);
    const db = new pg.Client({ connectionString: TEST_OWNER_URL });
    await db.connect();
    await caseDeadlines(db as unknown as Db, T.id, today);
    await db.end();
    expect(await noticesFor(T, T.users.hr!.id, 'cases.overdue')).toHaveLength(0);
  });
});
