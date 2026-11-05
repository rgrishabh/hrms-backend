import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setMailer } from '../../src/core/notify/mailer.js';
import { deliverOutbox } from '../../src/core/notify/service.js';
import { LocalStore, setStore } from '../../src/core/storage/index.js';
import { base32Decode, hotp, timeStep } from '../../src/core/auth/totp.js';
import { addDays } from '../../src/modules/attendance/time.js';
import { Client, createTenant, makeApp, multipart, ownerQuery, type TenantFixture } from '../helpers.js';
import { ALL_ON, person } from '../security/wire.js';

/**
 * The routes no other suite takes to a success. makeApp refuses an answer its declared response does not describe, so reaching each one here proves its schema, and the first thing asked of each is
 * only that it answers 2xx. What these routes do is tested with their modules.
 */
const today = new Date().toISOString().slice(0, 10);
let app: FastifyInstance;
let T: TenantFixture;
let admin: Client;
let hr: Client;
let pay: Client;
let fin: Client;
let qm: Client;
let lab: Client;
let emp: Client;
const ok = <R extends { statusCode: number; body: string }>(r: R) => {
  expect(r.statusCode, r.body).toBeLessThan(300);
  return r;
};
const idOf = (r: { statusCode: number; body: string; json: () => unknown }) => (ok(r).json() as { id: string }).id;

beforeAll(async () => {
  setStore(new LocalStore(mkdtempSync(path.join(tmpdir(), 'hrms-remaining-'))));
  app = await makeApp({ ...ALL_ON, MFA_AVAILABLE: 'true', MFA_METHODS: 'totp,email' }, { storeOverride: true, mailerOverride: true });
  T = await createTenant();
  [admin, hr, pay, emp] = (await Promise.all(['admin', 'hr', 'payroll', 'employee'].map((k) => Client.login(app, T.host, T.users[k]!.email)))) as [Client, Client, Client, Client];
  const as = async (key: string, role: string) => Client.login(app, T.host, (await person(T, key, [role])).email);
  [fin, qm, lab] = (await Promise.all([as('fin', 'finance_manager'), as('qm', 'quality_manager'), as('lab', 'laboratory_manager')])) as [Client, Client, Client];
}, 60000);
afterAll(async () => {
  setStore(null);
  setMailer(null);
  await app.close();
  await ownerQuery(`DELETE FROM email_outbox WHERE status <> 'sent'`);
});

describe('organization', () => {
  it('legal entities, branches, departments', async () => {
    const le = idOf(await admin.post('/api/v1/org/legal-entities', { name: 'Second Entity' }));
    ok(await admin.put(`/api/v1/org/legal-entities/${le}`, { name: 'Second Entity Pvt' }));
    const br = { legalEntityId: le, code: 'BR2', name: 'Second', state: 'Maharashtra' };
    const b = idOf(await admin.post('/api/v1/org/branches', br));
    ok(await admin.put(`/api/v1/org/branches/${b}`, { ...br, name: 'Second Branch' }));
    const d = idOf(await admin.post('/api/v1/org/departments', { code: 'QC', name: 'Quality' }));
    ok(await admin.put(`/api/v1/org/departments/${d}`, { code: 'QC', name: 'Quality Control' }));
  });
});

describe('attendance', () => {
  it('shifts, holidays, geofences, devices', async () => {
    const shift = { code: 'SPL', name: 'Split', startTime: '08:00', endTime: '16:00', halfDayMinMinutes: 240, fullDayMinMinutes: 420 };
    const s = idOf(await hr.post('/api/v1/attendance/shifts', shift));
    ok(await hr.put(`/api/v1/attendance/shifts/${s}`, { ...shift, name: 'Split day' }));
    const h = idOf(await hr.post('/api/v1/attendance/holidays', { holidayDate: `${today.slice(0, 4)}-12-25`, name: 'Christmas' }));
    ok(await hr.req('DELETE', `/api/v1/attendance/holidays/${h}`));
    ok(await admin.put(`/api/v1/attendance/geofences/${T.branchId}`, { latitude: 19, longitude: 72.8, radiusMeters: 500 }));
    ok(await admin.req('DELETE', `/api/v1/attendance/geofences/${T.branchId}`));
    const it_ = await Client.login(app, T.host, T.users.it!.email);
    const dev = idOf(await it_.post('/api/v1/attendance/devices', { branchId: T.branchId, serialNumber: 'ZK-9', name: 'Gate', adapterKey: 'generic_push_v1' }));
    ok(await it_.post(`/api/v1/attendance/devices/${dev}/rotate-key`));
  });
});

describe('leave and expenses', () => {
  it('a leave type', async () => {
    const lt = { code: 'SPL', name: 'Special' };
    const id = idOf(await hr.post('/api/v1/leave/types', lt));
    ok(await hr.put(`/api/v1/leave/types/${id}`, { ...lt, name: 'Special leave' }));
  });

  it('a category, an item taken off a claim, a batch cancelled', async () => {
    const cat = { code: 'TAXI', name: 'Taxi', requiresReceipt: false };
    const category = idOf(await fin.post('/api/v1/expenses/categories', cat));
    ok(await fin.put(`/api/v1/expenses/categories/${category}`, { ...cat, name: 'Taxi fare' }));
    const claim = idOf(await emp.post('/api/v1/expenses/claims', { title: 'Client visit', purpose: 'Sampling at site' }));
    const m = multipart({ categoryId: category, expenseDate: today, amount: '120', description: 'To the site' });
    const item = idOf(await emp.req('POST', `/api/v1/expenses/claims/${claim}/items`, m.body, m.headers));
    ok(await emp.req('DELETE', `/api/v1/expenses/claims/${claim}/items/${item}`));
    const [b] = await ownerQuery<{ id: string }>(`INSERT INTO reimbursement_batches (tenant_id, prepared_by) VALUES ($1,$2) RETURNING id`, [T.id, T.users.admin!.id]);
    ok(await fin.post(`/api/v1/expenses/batches/${b!.id}/cancel`));
  });
});

describe('competency', () => {
  it('courses, methods, an authorization cancelled and one withdrawn', async () => {
    const course = { code: 'PH', name: 'pH meter', kind: 'method' };
    const c = idOf(await hr.post('/api/v1/competency/courses', course));
    ok(await hr.put(`/api/v1/competency/courses/${c}`, { ...course, name: 'pH meter operation' }));
    const method = { code: 'WAT-PH', name: 'pH by electrometric method', reviewMonths: 12 };
    const mth = idOf(await qm.post('/api/v1/competency/methods', method));
    ok(await qm.put(`/api/v1/competency/methods/${mth}`, { ...method, name: 'pH, electrometric' }));
    const employeeId = T.users.employee!.employeeId!;
    const assessment = idOf(
      await lab.post('/api/v1/competency/assessments', {
        employeeId,
        methodId: mth,
        activity: 'perform',
        approach: 'replicate',
        assessedOn: today,
        result: 'competent',
        evidence: 'Six replicates on CRM',
      }),
    );
    const authorization = idOf(await lab.post('/api/v1/competency/authorizations', { assessmentId: assessment }));
    ok(await lab.post(`/api/v1/competency/authorizations/${authorization}/cancel`));
    const [active] = await ownerQuery<{ id: string }>(
      `INSERT INTO lab_authorizations (tenant_id, employee_id, method_id, activity, assessment_id, requested_by, status, authorized_at, authorized_by, review_due)
       VALUES ($1,$2,$3,'perform',$4,$5,'authorized',now(),$6,$7) RETURNING id`,
      [T.id, employeeId, mth, assessment, T.users.admin!.id, T.users.hr!.id, addDays(today, 300)],
    );
    ok(await qm.post(`/api/v1/competency/authorizations/${active!.id}/withdraw`, { reason: 'Left the method for good' }));
  });
});

describe('policies', () => {
  it('a policy edited, a draft discarded', async () => {
    const id = idOf(await hr.post('/api/v1/policies', { code: 'COC', title: 'Conduct', category: 'code_of_conduct' }));
    ok(await hr.put(`/api/v1/policies/${id}`, { title: 'Code of conduct', category: 'code_of_conduct' }));
    const m = multipart({ body: 'Be kind.', effectiveFrom: today, changeSummary: 'First' });
    const version = idOf(await hr.req('POST', `/api/v1/policies/${id}/versions`, m.body, m.headers));
    ok(await hr.post(`/api/v1/policies/versions/${version}/discard`));
  });
});

describe('recruitment', () => {
  it('a requisition cancelled, an interview cancelled, an offer edited', async () => {
    const requisition = {
      title: 'Chemist',
      legalEntityId: T.legalEntityId,
      branchId: T.branchId,
      departmentId: T.deptId,
      designation: 'Chemist',
      positions: 1,
      justification: 'Backfill for a resignation',
      hiringManagerId: T.users.manager!.employeeId,
    };
    const spare = idOf(await hr.post('/api/v1/recruitment/requisitions', requisition));
    ok(await hr.post(`/api/v1/recruitment/requisitions/${spare}/cancel`, { reason: 'Not needed after all' }));
    const reqId = idOf(await hr.post('/api/v1/recruitment/requisitions', requisition));
    await ownerQuery(`UPDATE job_requisitions SET status='approved' WHERE id=$1`, [reqId]);
    const m = multipart({ firstName: 'Asha', lastName: 'Rao', email: 'asha@mail.example', source: 'job_portal', consent: 'true', consentNote: 'Portal checkbox' });
    const candidate = idOf(await hr.req('POST', '/api/v1/recruitment/candidates', m.body, m.headers));
    const application = idOf(await hr.post('/api/v1/recruitment/applications', { requisitionId: reqId, candidateId: candidate }));
    await ownerQuery(`UPDATE job_applications SET stage='interview' WHERE id=$1`, [application]);
    const interview = await hr.post(`/api/v1/recruitment/applications/${application}/interviews`, {
      round: 1,
      kind: 'hr',
      scheduledAt: new Date(Date.now() + 86400e3).toISOString(),
      panelUserIds: [T.users.other!.id],
    });
    ok(await hr.post(`/api/v1/recruitment/interviews/${idOf(interview)}/cancel`));
    await ownerQuery(`UPDATE job_applications SET stage='offer' WHERE id=$1`, [application]);
    const offer = {
      designation: 'Chemist',
      legalEntityId: T.legalEntityId,
      branchId: T.branchId,
      employmentType: 'permanent',
      annualCtc: 600000,
      joiningDate: addDays(today, 30),
    };
    const o = idOf(await hr.post(`/api/v1/recruitment/applications/${application}/offers`, offer));
    ok(await hr.put(`/api/v1/recruitment/offers/${o}`, { ...offer, annualCtc: 650000 }));
  });
});

describe('lifecycle', () => {
  it('a template edited, a checklist cancelled', async () => {
    const template = { kind: 'onboarding', name: 'Joining', isDefault: true, tasks: [{ title: 'Desk', owner: 'hr' }] };
    const id = idOf(await hr.post('/api/v1/lifecycle/templates', template));
    ok(await hr.put(`/api/v1/lifecycle/templates/${id}`, { ...template, name: 'Joining day' }));
    const checklist = idOf(await hr.post('/api/v1/lifecycle/checklists', { employeeId: T.users.other!.employeeId }));
    ok(await hr.post(`/api/v1/lifecycle/checklists/${checklist}/cancel`, { reason: 'Started by mistake' }));
  });

  it('a resignation withdrawn; a separation with its settlement noted, then cancelled', async () => {
    const lwd = addDays(today, 40);
    const resigned = idOf(await emp.post('/api/v1/lifecycle/separations/resign', { reason: 'A better offer', requestedLwd: lwd }));
    ok(await emp.post(`/api/v1/lifecycle/separations/${resigned}/withdraw`));
    const sep = idOf(await emp.post('/api/v1/lifecycle/separations/resign', { reason: 'A better offer', requestedLwd: lwd }));
    ok(await hr.post(`/api/v1/lifecycle/separations/${sep}/fnf`, { status: 'in_progress', note: 'Dues being worked out' }));
    await ownerQuery(`UPDATE approval_requests SET status='cancelled' WHERE tenant_id=$1 AND entity_type='separation' AND entity_id=$2`, [T.id, sep]);
    await ownerQuery(`UPDATE separations SET status='approved', approved_lwd=$2 WHERE id=$1`, [sep, lwd]);
    ok(await hr.post(`/api/v1/lifecycle/separations/${sep}/cancel`, { reason: 'Withdrawn by agreement' }));
  });
});

describe('payroll', () => {
  it('a component and a rule edited, a rule retired, an adjustment taken back', async () => {
    const component = { code: 'SPECIAL', name: 'Special', kind: 'earning' };
    const c = idOf(await pay.post('/api/v1/payroll/components', component));
    ok(await pay.put(`/api/v1/payroll/components/${c}`, { ...component, name: 'Special allowance' }));
    const rule = {
      kind: 'pt',
      scope: 'Maharashtra',
      effectiveFrom: '2026-04-01',
      params: { slabs: [{ upTo: null, amount: 200 }] },
      sourceReference: 'Test fixture, not a statutory source',
    };
    const r = idOf(await pay.post('/api/v1/payroll/statutory-rules', rule));
    ok(await pay.put(`/api/v1/payroll/statutory-rules/${r}`, { ...rule, sourceReference: 'Test fixture, edited' }));
    ok(await pay.post(`/api/v1/payroll/statutory-rules/${r}/retire`));
    await ownerQuery(`INSERT INTO pay_components (tenant_id, code, name, kind) VALUES ($1,'BASIC','Basic','earning') ON CONFLICT DO NOTHING`, [T.id]);
    const run = idOf(await pay.post('/api/v1/payroll/runs', { period: addDays(today, -40).slice(0, 7), legalEntityId: T.legalEntityId }));
    ok(await pay.post(`/api/v1/payroll/runs/${run}/compute`));
    const adj = idOf(
      await pay.post(`/api/v1/payroll/runs/${run}/adjustments`, { employeeId: T.users.employee!.employeeId, kind: 'earning', label: 'Night allowance', amount: 1500 }),
    );
    ok(await pay.req('DELETE', `/api/v1/payroll/runs/${run}/adjustments/${adj}`));
  });
});

describe('the rest', () => {
  it('a review cycle closed', async () => {
    const id = idOf(await hr.post('/api/v1/performance/cycles', { name: 'FY', periodStart: '2026-04-01', periodEnd: '2027-03-31' }));
    ok(await hr.post(`/api/v1/performance/cycles/${id}/activate`));
    await ownerQuery(`UPDATE performance_reviews SET status='finalized' WHERE tenant_id=$1 AND cycle_id=$2`, [T.id, id]);
    ok(await hr.post(`/api/v1/performance/cycles/${id}/close`));
  });

  it('a trip and a loan withdrawn, a loan cancelled', async () => {
    const trip = {
      purpose: 'Stack monitoring at the plant',
      origin: 'Pune',
      destination: 'Taloja',
      travelMode: 'road',
      startDate: addDays(today, 10),
      endDate: addDays(today, 11),
      estimate: { travel: 3000 },
    };
    ok(await emp.post(`/api/v1/travel/requests/${idOf(await emp.post('/api/v1/travel/requests', trip))}/withdraw`));
    const loan = { kind: 'salary_advance', amount: 10000, installments: 3, firstPeriod: addDays(today, 40).slice(0, 7), purpose: 'Medical expenses for a family member' };
    const salary = await ownerQuery(`SELECT 1 FROM employee_salaries WHERE employee_id=$1`, [T.users.employee!.employeeId]);
    if (!salary.length) {
      const { activeSalary } = await import('../payroll-helpers.js');
      await activeSalary(T, T.users.employee!.employeeId!, '2024-01-01', { BASIC: 50000 });
    }
    const l = idOf(await emp.post('/api/v1/loans/requests', loan));
    ok(await emp.post(`/api/v1/loans/requests/${l}/withdraw`));
    const [approved] = await ownerQuery<{ id: string }>(
      `INSERT INTO employee_loans (tenant_id, employee_id, kind, amount, installments, installment_amount, first_period, purpose, status, created_by) VALUES ($1,$2,'loan',10000,5,2000,'2030-01','Fixture','approved',$3) RETURNING id`,
      [T.id, T.users.employee!.employeeId, T.users.hr!.id],
    );
    ok(await pay.post(`/api/v1/loans/requests/${approved!.id}/cancel`, { reason: 'No longer needed' }));
  });

  it('a saved report and its schedule deleted', async () => {
    const id = idOf(await hr.post('/api/v1/reports/saved', { reportKey: 'headcount', name: 'Heads' }));
    ok(await hr.put(`/api/v1/reports/saved/${id}/schedule`, { frequency: 'daily', recipientIds: [T.users.payroll!.id] }));
    ok(await hr.req('DELETE', `/api/v1/reports/saved/${id}/schedule`));
    ok(await hr.req('DELETE', `/api/v1/reports/saved/${id}`));
  });

  it('an erasure request read back', async () => {
    const m = multipart({ firstName: 'Ravi', lastName: 'Shah', email: 'ravi@mail.example', source: 'job_portal', consent: 'true', consentNote: 'Portal checkbox' });
    const candidate = idOf(await hr.req('POST', '/api/v1/recruitment/candidates', m.body, m.headers));
    const base = '/api/v1/tenant/data-rights/erasure-requests';
    const r = await hr.post(base, { subjectType: 'candidate', subjectId: candidate });
    ok(await hr.get(`${base}/${idOf(r)}`));
  });

  it('new recovery codes, and an email code sent again', async () => {
    const X = await createTenant();
    const c = await Client.login(app, X.host, X.users.employee!.email);
    const setup = (await c.post('/api/v1/auth/mfa/setup')).json() as { secret: string };
    const code = () => hotp(base32Decode(setup.secret), timeStep(Date.now()));
    ok(await c.post('/api/v1/auth/mfa/enable', { code: code() }));
    await ownerQuery(`UPDATE users SET mfa_last_step = mfa_last_step - 2 WHERE id=$1`, [X.users.employee!.id]);
    ok(await c.post('/api/v1/auth/mfa/recovery-codes', { code: code() }));

    const sent: { to: string; text: string }[] = [];
    setMailer({ send: async (m) => void sent.push(m) }, 'test@test');
    const other = await Client.login(app, X.host, X.users.other!.email);
    ok(await other.post('/api/v1/auth/mfa/email/setup'));
    await deliverOutbox(app.deps.pool, { error: () => undefined });
    const emailed = /Your code is (\d{6})/.exec(sent.findLast((m) => m.to === X.users.other!.email)!.text)![1];
    ok(await other.post('/api/v1/auth/mfa/email/enable', { code: emailed }));
    const pending = new Client(app, X.host);
    ok(await pending.post('/api/v1/auth/login', { email: X.users.other!.email, password: 'Test-Password-123!' }));
    await ownerQuery(`UPDATE email_otps SET created_at = created_at - interval '5 minutes' WHERE user_id=$1`, [X.users.other!.id]);
    ok(await pending.post('/api/v1/auth/mfa/email/send'));
  });
});

describe('lists with something in them', () => {
  const items = async (c: Client, url: string) => {
    const r = ok(await c.get(url));
    const list = (r.json() as { items: unknown[] }).items;
    expect(list.length, url).toBeGreaterThan(0);
    return list;
  };

  it('attendance', async () => {
    await ok(
      await emp.post('/api/v1/attendance/regularizations', { workDate: addDays(today, -1), requestedIn: `${addDays(today, -1)}T04:00:00.000Z`, reason: 'Forgot to punch in' }),
    );
    await items(emp, '/api/v1/attendance/regularizations');
    await items(emp, '/api/v1/approvals/mine');
    ok(await admin.put(`/api/v1/attendance/geofences/${T.branchId}`, { latitude: 19, longitude: 72.8, radiusMeters: 500 }));
    await items(admin, '/api/v1/attendance/geofences');
    ok(await pay.post('/api/v1/attendance/locks', { periodStart: '2024-01-01', periodEnd: '2024-01-31' }));
    await items(pay, '/api/v1/attendance/locks');
    const it_ = await Client.login(app, T.host, T.users.it!.email);
    ok(await it_.put('/api/v1/attendance/device-mappings/1001', { employeeId: T.users.employee!.employeeId }));
    await items(it_, '/api/v1/attendance/device-mappings');
  });

  it('a leave type limited to some employment types', async () => {
    ok(await hr.post('/api/v1/leave/types', { code: 'PRM', name: 'Permanent only', applicableEmploymentTypes: ['permanent'] }));
    await items(hr, '/api/v1/leave/types');
  });

  it('money and exits', async () => {
    await items(fin, '/api/v1/expenses/batches');
    await items(hr, '/api/v1/lifecycle/separations');
    await items(pay, '/api/v1/payroll/statutory-rules');
    ok(await fin.put('/api/v1/accounting/ledger-map', { entries: [{ key: 'net_pay', ledger: 'Salaries payable' }] }));
    await items(fin, '/api/v1/accounting/ledger-map');
  });

  it('competency for the person, and a check that says why not', async () => {
    const [m] = await ownerQuery<{ id: string }>(`SELECT id FROM lab_methods WHERE tenant_id=$1 LIMIT 1`, [T.id]);
    const [a] = await ownerQuery<{ id: string }>(`SELECT id FROM competency_assessments WHERE tenant_id=$1 LIMIT 1`, [T.id]);
    const employeeId = T.users.employee!.employeeId!;
    const [z] = await ownerQuery<{ id: string }>(
      `INSERT INTO lab_authorizations (tenant_id, employee_id, method_id, activity, assessment_id, requested_by, status, authorized_at, authorized_by, review_due)
       VALUES ($1,$2,$3,'review',$4,$5,'authorized',now(),$6,$7) RETURNING id`,
      [T.id, employeeId, m!.id, a!.id, T.users.admin!.id, T.users.hr!.id, addDays(today, -3)],
    );
    const me = ok(await emp.get('/api/v1/competency/me')).json() as { authorizations: unknown[] };
    expect(me.authorizations.length).toBeGreaterThan(0);
    const detail = ok(await qm.get(`/api/v1/competency/authorizations/${z!.id}`)).json() as { check: { reasons: unknown[] } };
    expect(detail.check.reasons.length).toBeGreaterThan(0);
  });

  it('a saved report with its schedule, an erasure request, a policy for one branch', async () => {
    const id = idOf(await hr.post('/api/v1/reports/saved', { reportKey: 'headcount', name: 'Heads again' }));
    ok(await hr.put(`/api/v1/reports/saved/${id}/schedule`, { frequency: 'daily', recipientIds: [T.users.payroll!.id] }));
    await items(hr, '/api/v1/reports/saved');
    await items(hr, '/api/v1/tenant/data-rights/erasure-requests');
    const policy = idOf(await hr.post('/api/v1/policies', { code: 'BR', title: 'Branch rules', category: 'hr' }));
    const m = multipart({ body: 'Rules.', effectiveFrom: today, changeSummary: 'First', audienceBranchIds: T.branchId, audienceDepartmentIds: T.deptId });
    ok(await hr.req('POST', `/api/v1/policies/${policy}/versions`, m.body, m.headers));
    ok(await hr.get(`/api/v1/policies/${policy}`));
  });
});
