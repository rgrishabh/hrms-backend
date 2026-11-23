import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { activeSalary, createRun, seedComponents } from '../payroll-helpers.js';
import { addDays, localDate } from '../../src/modules/attendance/time.js';
import { createTenant, ownerQuery, person, serve, WireClient, type TenantFixture } from './wire.js';

/**
 * Someone holding a real role goes beyond it, over HTTP, against the database. Each `it` is an attack. Findings are in QA_REPORT.md as batch F, and SECURITY_REPORT.md scores them.
 */
const today = localDate(new Date(), 'Asia/Kolkata');
let app: FastifyInstance;
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'hrms-abuse-'));
  ({ app } = await serve({ STORAGE_DRIVER: 'local', STORAGE_PATH: dir }));
}, 60000);
afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});
const as = (T: TenantFixture, who: string) => WireClient.signIn(app, T.host, T.users[who]!.email);

describe('paying yourself', () => {
  let T: TenantFixture;
  let runId: string;
  beforeAll(async () => {
    T = await createTenant();
    await seedComponents(T);
    await person(T, 'pay1', ['payroll_manager', 'employee']);
    await person(T, 'pay2', ['payroll_manager', 'employee'], { storedLevel: 85 });
    await activeSalary(T, T.users.pay1!.employeeId!, '2024-01-01', { BASIC: 30000 });
    runId = await createRun(await as(T, 'pay2'), T, '2026-03');
  });

  it('F-101 payroll staff cannot add an adjustment to their own pay', async () => {
    const pay1 = await as(T, 'pay1');
    const r = await pay1.post(`/api/v1/payroll/runs/${runId}/adjustments`, {
      employeeId: T.users.pay1!.employeeId,
      kind: 'earning',
      label: 'Bonus',
      amount: 50000,
      taxable: false,
      note: 'x',
    });
    expect(r.statusCode, r.body).toBe(403);
    expect(await ownerQuery(`SELECT 1 FROM payroll_adjustments WHERE tenant_id=$1 AND employee_id=$2`, [T.id, T.users.pay1!.employeeId])).toHaveLength(0);
  });

  it('F-101 nor change their own statutory record', async () => {
    const pay1 = await as(T, 'pay1');
    const r = await pay1.put(`/api/v1/payroll/employees/${T.users.pay1!.employeeId}/statutory`, { pfExcluded: true, taxRegime: 'old' });
    expect(r.statusCode, r.body).toBe(403);
  });

  it('F-101 nor delete a deduction someone else put on their pay', async () => {
    const pay2 = await as(T, 'pay2');
    const add = await pay2.post(`/api/v1/payroll/runs/${runId}/adjustments`, {
      employeeId: T.users.pay1!.employeeId,
      kind: 'deduction',
      label: 'Recovery',
      amount: 500,
      taxable: false,
      note: 'x',
    });
    expect(add.statusCode, add.body).toBe(201);
    const pay1 = await as(T, 'pay1');
    expect((await pay1.del(`/api/v1/payroll/runs/${runId}/adjustments/${add.json().id}`)).statusCode).toBe(403);
  });
});

describe('reading the pay of a peer or a senior', () => {
  it('through the API, the run, the register, the bank file, a report and its export', async () => {
    const T = await createTenant();
    await seedComponents(T);
    await person(T, 'pay1', ['payroll_manager', 'employee']);
    await person(T, 'pay2', ['payroll_manager', 'employee']);
    await person(T, 'senior', ['payroll_manager', 'employee'], { storedLevel: 85 });
    await activeSalary(T, T.users.pay2!.employeeId!, '2024-01-01', { BASIC: 77123 });
    await activeSalary(T, T.users.senior!.employeeId!, '2024-01-01', { BASIC: 88123 });
    await activeSalary(T, T.users.other!.employeeId!, '2024-01-01', { BASIC: 33123 });
    const senior = await as(T, 'senior');
    const run = await createRun(senior, T, '2026-03');
    expect((await senior.post(`/api/v1/payroll/runs/${run}/compute`)).statusCode).toBe(200);
    const peer = await as(T, 'pay1');
    const hidden = [T.users.pay2!.employeeId!, T.users.senior!.employeeId!];
    for (const id of hidden) {
      expect((await peer.get(`/api/v1/payroll/employees/${id}/salaries?reveal=1`)).statusCode).toBe(404);
      expect((await peer.get(`/api/v1/payroll/employees/${id}/statutory?reveal=1`)).statusCode).toBe(404);
      expect((await peer.get(`/api/v1/employees/${id}/bank-account?reveal=1`)).statusCode).toBe(404);
    }
    const leaks = /77123|88123/;
    const detail = await peer.get(`/api/v1/payroll/runs/${run}?reveal=1`);
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toMatch(leaks);
    expect(detail.json().excluded).toBeGreaterThanOrEqual(2);
    expect(detail.body).toContain('33123');
    const register = await peer.get(`/api/v1/payroll/runs/${run}/register.csv`);
    expect(register.body).not.toMatch(leaks);
    expect(Number(register.headers['x-excluded-subjects'])).toBeGreaterThanOrEqual(2);
    // Not yet paid out, so refused for everyone here; whole-or-refused on a finished run is in permission-matrix.test.ts.
    expect((await peer.get(`/api/v1/payroll/runs/${run}/bank.csv`)).body).not.toMatch(leaks);
    for (const u of ['/api/v1/employees?search=senior&pageSize=100', '/api/v1/reports/payroll_cost', '/api/v1/reports/payroll_cost/export.csv', '/api/v1/dashboard'])
      expect((await peer.get(u)).body, u).not.toMatch(leaks);
  });
});

describe('where there is nobody above you', () => {
  it('the owner of a single-person company changes their own record; the rule names only them', async () => {
    const single = await serve({ ORG_MANAGEMENT_MODE: 'single', STORAGE_DRIVER: 'local', STORAGE_PATH: dir });
    const T = await createTenant();
    const own = await person(T, 'own', ['owner', 'employee']);
    const c = await WireClient.signIn(single.app, T.host, own.email);
    const r = await c.put(`/api/v1/payroll/employees/${own.employeeId}/statutory`, { pfExcluded: true });
    expect(r.statusCode, r.body).toBe(200);
    await single.app.close();
  });
  it('an id that is nobody is outranked by nobody', async () => {
    const T = await createTenant();
    const hr = await as(T, 'hr');
    const r = await hr.post('/api/v1/lifecycle/separations', {
      employeeId: '00000000-0000-4000-8000-000000000000',
      kind: 'termination',
      reason: 'Nobody at all',
      noticeDate: today,
      requestedLwd: addDays(today, 1),
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('deciding your own approvals through delegation and reassignment', () => {
  let T: TenantFixture;
  beforeAll(async () => {
    T = await createTenant();
    await person(T, 'hr2', ['hr_admin', 'employee']);
  });
  const leaveRequest = async () => {
    const hr = await as(T, 'hr');
    const type = await hr.post('/api/v1/leave/types', {
      code: `C${Math.floor(Math.random() * 1e6)}`,
      name: 'Casual',
      paid: true,
      requiresBalance: false,
      accrualMethod: 'none',
      annualEntitlement: 0,
    });
    expect(type.statusCode, type.body).toBe(201);
    const emp = await as(T, 'employee');
    // A weekday, so that the request has a working day in it. Different each time, so that requests do not overlap.
    let start = addDays(today, 30 + Math.floor(Math.random() * 300));
    while ([0, 6].includes(new Date(`${start}T00:00:00Z`).getUTCDay())) start = addDays(start, 1);
    const r = await emp.post('/api/v1/leave/requests', { leaveTypeId: type.json().id, startDate: start, endDate: start, reason: 'Family function' });
    expect(r.statusCode, r.body).toBe(201);
    const [q] = await ownerQuery<{ id: string }>(`SELECT id FROM approval_requests WHERE tenant_id=$1 AND entity_type='leave_request' AND entity_id=$2`, [T.id, r.json().id]);
    return q!.id;
  };

  it("F-102 HR cannot hand someone else's approvals to themselves", async () => {
    const hr = await as(T, 'hr');
    const r = await hr.post('/api/v1/approvals/delegations', { delegatorId: T.users.manager!.id, delegateId: T.users.hr!.id, startsOn: today, endsOn: today });
    expect(r.statusCode, r.body).toBe(403);
  });

  it('F-102 HR can still hand them to a third person', async () => {
    const hr = await as(T, 'hr');
    const r = await hr.post('/api/v1/approvals/delegations', {
      delegatorId: T.users.manager!.id,
      delegateId: T.users.other!.id,
      startsOn: addDays(today, 100),
      endsOn: addDays(today, 101),
    });
    expect(r.statusCode, r.body).toBe(201);
  });

  it('F-102 reassigning to someone who already delegates to you is refused: it is taking it yourself', async () => {
    const id = await leaveRequest();
    const manager = await as(T, 'manager');
    expect((await manager.post('/api/v1/approvals/delegations', { delegateId: T.users.hr!.id, startsOn: addDays(today, 1), endsOn: addDays(today, 2) })).statusCode).toBe(201);
    await ownerQuery(`UPDATE approval_delegations SET starts_on=$2 WHERE tenant_id=$1 AND delegate_id=$3`, [T.id, today, T.users.hr!.id]);
    const hr = await as(T, 'hr');
    const r = await hr.post(`/api/v1/approvals/${id}/reassign`, { userId: T.users.manager!.id, reason: 'covering for now' });
    expect(r.statusCode, r.body).toBe(400);
  });
});

describe('a login on someone else’s employee record', () => {
  let T: TenantFixture;
  beforeAll(async () => {
    T = await createTenant();
  });

  it('F-103 IT cannot attach a login at their own address to a person who has none, and read that person as "self"', async () => {
    const victim = await person(T, 'nologin', [], { noLogin: true });
    const it_ = await as(T, 'it');
    const r = await it_.post('/api/v1/tenant/users', { email: `attacker@${T.host}`, displayName: 'Attacker', roles: ['employee'], employeeId: victim.employeeId });
    expect(r.statusCode, r.body).toBe(403);
    expect((await ownerQuery<{ user_id: string | null }>(`SELECT user_id FROM employees WHERE id=$1`, [victim.employeeId]))[0]!.user_id).toBeNull();
  });

  it('F-103 the address on the record works, and so does HR with the standing to see the person', async () => {
    const a = await person(T, 'nologin2', [], { noLogin: true });
    await ownerQuery(`UPDATE employees SET work_email=$2 WHERE id=$1`, [a.employeeId, `nologin2@${T.host}`]);
    const it_ = await as(T, 'it');
    const r1 = await it_.post('/api/v1/tenant/users', { email: `NoLogin2@${T.host}`, displayName: 'Person Two', roles: ['employee'], employeeId: a.employeeId });
    expect(r1.statusCode, r1.body).toBe(201);
    const b = await person(T, 'nologin3', [], { noLogin: true });
    const admin = await as(T, 'admin');
    const r2 = await admin.post('/api/v1/tenant/users', { email: `other3@${T.host}`, displayName: 'Person Three', roles: ['employee'], employeeId: b.employeeId });
    expect(r2.statusCode, r2.body).toBe(201);
  });
});

describe('changing someone above you', () => {
  let T: TenantFixture;
  beforeAll(async () => {
    T = await createTenant();
    await person(T, 'exec', ['hr_executive', 'employee']);
    await person(T, 'fin', ['finance_manager', 'employee']);
  });
  const version = async (id: string) => (await ownerQuery<{ version: number }>(`SELECT version FROM employees WHERE id=$1`, [id]))[0]!.version;

  it('F-104 HR executive cannot mark a finance manager as exited, which ends their login', async () => {
    const id = T.users.fin!.employeeId!;
    const exec = await as(T, 'exec');
    const r = await exec.patch(`/api/v1/employees/${id}`, { changes: { status: 'exited' }, exitDate: today, expectedVersion: await version(id) });
    expect(r.statusCode, r.body).toBe(404);
    expect((await ownerQuery<{ status: string }>(`SELECT status FROM users WHERE id=$1`, [T.users.fin!.id]))[0]!.status).toBe('active');
  });

  it('F-104 nor become their reporting manager, which reroutes approvals', async () => {
    const id = T.users.fin!.employeeId!;
    const exec = await as(T, 'exec');
    const r = await exec.patch(`/api/v1/employees/${id}`, { changes: { reportingManagerId: T.users.exec!.employeeId }, expectedVersion: await version(id) });
    expect(r.statusCode, r.body).toBe(404);
  });

  it('F-104 nor pick their own approver by changing their own manager', async () => {
    const id = T.users.exec!.employeeId!;
    const exec = await as(T, 'exec');
    const r = await exec.patch(`/api/v1/employees/${id}`, { changes: { reportingManagerId: T.users.other!.employeeId }, expectedVersion: await version(id) });
    expect(r.statusCode, r.body).toBe(403);
  });

  it('F-104 ordinary work on people below still goes through', async () => {
    const id = T.users.other!.employeeId!;
    const exec = await as(T, 'exec');
    const r = await exec.patch(`/api/v1/employees/${id}`, { changes: { reportingManagerId: T.users.manager!.employeeId }, expectedVersion: await version(id) });
    expect(r.statusCode, r.body).toBe(200);
  });

  it('F-105 the salary-level route obeys the same limit as the rest of user management', async () => {
    const it_ = await as(T, 'it');
    const r = await it_.put(`/api/v1/tenant/users/${T.users.payroll!.id}/salary-level`, { level: 59 });
    expect(r.statusCode, r.body).toBe(403);
  });

  it('F-106 unlocking an account above you is refused', async () => {
    const owner = await person(T, 'own', ['owner', 'employee']);
    const it_ = await as(T, 'it');
    const r = await it_.patch(`/api/v1/tenant/users/${owner.id}`, { unlock: true });
    expect(r.statusCode, r.body).toBe(403);
  });
});

describe('separations', () => {
  let T: TenantFixture;
  beforeAll(async () => {
    T = await createTenant();
    await person(T, 'mgr', ['reporting_manager', 'employee']);
    await person(T, 'aud', ['auditor', 'employee']);
    await person(T, 'exec', ['hr_executive', 'employee']);
    await person(T, 'fin', ['finance_manager', 'employee']);
    await person(T, 'finleaver', ['finance_manager', 'employee']);
    await person(T, 'emp', ['employee'], { managerId: T.users.mgr!.employeeId });
    await person(T, 'emp2', ['employee']);
    await person(T, 'hrleaver', ['hr_admin', 'employee']);
  });
  const resign = async (who: string) => {
    const c = await as(T, who);
    const r = await c.post('/api/v1/lifecycle/separations/resign', { reason: 'Private medical reason', requestedLwd: addDays(today, 40) });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  };

  it('F-107 an auditor reads no separation reason or exit interview of someone above them', async () => {
    const id = await resign('fin');
    await ownerQuery(`UPDATE separations SET status='approved', approved_lwd=$2, exit_interview='{"why":"Secret answer"}' WHERE id=$1`, [id, addDays(today, 40)]);
    const aud = await as(T, 'aud');
    const r = await aud.get(`/api/v1/lifecycle/separations/${id}`);
    expect(r.body).not.toContain('Private medical reason');
    expect(r.body).not.toContain('Secret answer');
  });

  it('F-107 the manager reads the reason while deciding, not once it is decided', async () => {
    const id = await resign('emp');
    const mgr = await as(T, 'mgr');
    expect((await mgr.get(`/api/v1/lifecycle/separations/${id}`)).body).toContain('Private medical reason');
    await ownerQuery(`UPDATE separations SET status='approved', approved_lwd=$2 WHERE id=$1`, [id, addDays(today, 40)]);
    const after = await mgr.get(`/api/v1/lifecycle/separations/${id}`);
    expect(after.body).not.toContain('Private medical reason');
    expect(after.json().maskedFields).toContain('reason');
  });

  it('F-108 lifecycle.read is read only: an auditor cannot write an exit interview', async () => {
    const id = await resign('emp2');
    await ownerQuery(`UPDATE separations SET status='approved', approved_lwd=$2 WHERE id=$1`, [id, addDays(today, 40)]);
    const aud = await as(T, 'aud');
    expect((await aud.post(`/api/v1/lifecycle/separations/${id}/exit-interview`, { answers: { why: 'Overwritten' } })).statusCode).toBe(403);
  });

  it('H-1 exit interview: HR who cannot see the recorded answers cannot replace them, and may record when nothing is on file', async () => {
    const id = await resign('finleaver');
    await ownerQuery(`UPDATE separations SET status='approved', approved_lwd=$2 WHERE id=$1`, [id, addDays(today, 40)]);
    const exec = await as(T, 'exec');
    const before = (await exec.get(`/api/v1/lifecycle/separations/${id}`)).json();
    expect(before.exit_interview).toBeUndefined();
    expect(before.exit_interview_recorded).toBe(false);
    expect((await exec.post(`/api/v1/lifecycle/separations/${id}/exit-interview`, { answers: { why: 'Taken down on paper' } })).statusCode).toBe(200);
    expect((await exec.get(`/api/v1/lifecycle/separations/${id}`)).json().exit_interview_recorded).toBe(true);
    expect((await exec.post(`/api/v1/lifecycle/separations/${id}/exit-interview`, { answers: { why: 'Over the top' } })).statusCode).toBe(409);
    const [stored] = await ownerQuery<{ exit_interview: { why: string } }>(`SELECT exit_interview FROM separations WHERE id=$1`, [id]);
    expect(stored!.exit_interview.why).toBe('Taken down on paper');
  });

  it('F-109 HR cannot start a termination of someone at or above their level', async () => {
    const exec = await as(T, 'exec');
    const r = await exec.post('/api/v1/lifecycle/separations', {
      employeeId: T.users.hr!.employeeId,
      kind: 'termination',
      reason: 'Removing a senior',
      noticeDate: today,
      requestedLwd: addDays(today, 1),
    });
    expect(r.statusCode, r.body).toBe(404);
  });

  it('F-110 someone leaving cannot clear their own HR tasks', async () => {
    const id = await resign('hrleaver');
    await ownerQuery(`UPDATE separations SET status='approved', approved_lwd=$2 WHERE id=$1`, [id, addDays(today, 40)]);
    const [c] = await ownerQuery<{ id: string }>(
      `INSERT INTO checklists (tenant_id, kind, employee_id, separation_id, status, anchor_date) VALUES ($1,'offboarding',$2,$3,'open',now()) RETURNING id`,
      [T.id, T.users.hrleaver!.employeeId, id],
    );
    const [t] = await ownerQuery<{ id: string }>(
      `INSERT INTO checklist_tasks (tenant_id, checklist_id, position, title, owner, due_date) VALUES ($1,$2,0,'Return keys','hr',$3) RETURNING id`,
      [T.id, c!.id, today],
    );
    const me = await as(T, 'hrleaver');
    expect((await me.post(`/api/v1/lifecycle/tasks/${t!.id}/done`, { note: 'done' })).statusCode).toBe(404);
  });
});

describe('loans and documents of someone above you', () => {
  let T: TenantFixture;
  beforeAll(async () => {
    T = await createTenant();
    await person(T, 'fin', ['payroll_manager', 'employee']); // holds loans.manage
    await person(T, 'admin2', ['tenant_admin', 'employee']);
    await person(T, 'exec', ['hr_executive', 'employee']);
    await person(T, 'loaner', ['employee'], { managerId: T.users.manager!.employeeId });
  });

  it('F-111 loans.manage cannot create, cancel or defer a loan for someone above them', async () => {
    const fin = await as(T, 'fin');
    const r = await fin.post('/api/v1/loans/requests', {
      employeeId: T.users.admin2!.employeeId,
      kind: 'loan',
      amount: 10000,
      installments: 5,
      firstPeriod: '2030-01',
      purpose: 'Testing limits',
    });
    expect(r.statusCode, r.body).toBe(404);
    const [l] = await ownerQuery<{ id: string }>(
      `INSERT INTO employee_loans (tenant_id, employee_id, kind, amount, installments, installment_amount, first_period, purpose, status, created_by)
       VALUES ($1,$2,'loan',10000,5,2000,'2030-01','Senior loan','approved',$3) RETURNING id`,
      [T.id, T.users.admin2!.employeeId, T.users.fin!.id],
    );
    expect((await fin.post(`/api/v1/loans/requests/${l!.id}/defer`, { period: '2030-02', reason: 'Deferring a senior' })).statusCode).toBe(404);
    expect((await fin.post(`/api/v1/loans/requests/${l!.id}/cancel`, { reason: 'Cancelling a senior' })).statusCode).toBe(404);
  });

  it('F-112 a manager reading a team loan sees no L4 column in the clear', async () => {
    const [l] = await ownerQuery<{ id: string }>(
      `INSERT INTO employee_loans (tenant_id, employee_id, kind, amount, installments, installment_amount, first_period, purpose, status, created_by)
       VALUES ($1,$2,'loan',10000,7,2000,'2030-01','Team loan','approved',$3) RETURNING id`,
      [T.id, T.users.loaner!.employeeId, T.users.payroll!.id],
    );
    const mgr = await as(T, 'manager');
    const one = (await mgr.get(`/api/v1/loans/requests/${l!.id}`)).json();
    const list = await mgr.get('/api/v1/loans/requests?scope=team');
    expect(list.statusCode, list.body).toBe(200);
    const listed = list.json().items.find((x: { id: string }) => x.id === l!.id);
    for (const row of [one, listed]) {
      expect(row.installments).toBeNull();
      expect(row.first_period).toBeNull();
      expect(row.maskedFields).toContain('installments');
    }
  });

  it('F-113 documents.manage cannot archive or plant a document on someone above them', async () => {
    const [cat] = await ownerQuery<{ id: string }>(`INSERT INTO document_categories (tenant_id, code, name, scope) VALUES ($1,'GEN','General','employee') RETURNING id`, [T.id]);
    const [doc] = await ownerQuery<{ id: string }>(
      `INSERT INTO documents (tenant_id, employee_id, category_id, title, file_name, content_type, size_bytes, sha256, storage_key, uploaded_by)
       VALUES ($1,$2,$3,'Senior doc','a.pdf','application/pdf',1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',$4,$5) RETURNING id`,
      [T.id, T.users.admin2!.employeeId, cat!.id, `${T.id}/company/00000000-0000-4000-8000-000000000000`, T.users.admin!.id],
    );
    const exec = await as(T, 'exec');
    expect((await exec.post(`/api/v1/documents/${doc!.id}/archive`)).statusCode).toBe(404);
  });
});

describe('leave reasons', () => {
  it('F-114 a holder of both leave.read and leave.team.read reads no reason outside their team by naming the employee', async () => {
    const T = await createTenant();
    await person(T, 'both', ['hr_executive', 'reporting_manager', 'employee']);
    await person(T, 'senior', ['finance_manager', 'employee']);
    const type = (
      await (await as(T, 'hr')).post('/api/v1/leave/types', { code: 'CL', name: 'Casual', paid: true, requiresBalance: false, accrualMethod: 'none', annualEntitlement: 0 })
    ).json().id;
    const senior = await as(T, 'senior');
    let start = addDays(today, 60);
    while ([0, 6].includes(new Date(`${start}T00:00:00Z`).getUTCDay())) start = addDays(start, 1);
    expect((await senior.post('/api/v1/leave/requests', { leaveTypeId: type, startDate: start, endDate: start, reason: 'Oncology appointment' })).statusCode).toBe(201);
    const both = await as(T, 'both');
    const r = await both.get(`/api/v1/leave/requests?scope=team&status=pending&employeeId=${T.users.senior!.employeeId}`);
    expect(r.body).not.toContain('Oncology');
  });
});

describe('employee history and duplicate checks', () => {
  let T: TenantFixture;
  beforeAll(async () => {
    T = await createTenant();
    await person(T, 'exec', ['hr_executive', 'employee']);
    await person(T, 'senior', ['finance_manager', 'employee'], { dob: '1975-06-15', phone: '+91 90000 11111' });
  });
  it('F-115 duplicate checks answer nothing about the date of birth or phone of someone above the viewer', async () => {
    const exec = await as(T, 'exec');
    const row = {
      employeeCode: 'NEW1',
      firstName: 'Person',
      lastName: 'senior',
      legalEntityCode: 'x',
      branchCode: 'HQ',
      departmentCode: 'LAB',
      dateOfJoining: '2026-01-01',
      dateOfBirth: '1975-06-15',
    };
    const r = await exec.post('/api/v1/employees/import', { dryRun: true, rows: [row] });
    expect(r.body).not.toContain('date of birth as');
    const phone = await exec.post('/api/v1/employees/import', { dryRun: true, rows: [{ ...row, dateOfBirth: undefined, phone: '+91 90000 11111' }] });
    expect(phone.body).not.toContain('Same phone');
  });
  it('F-116 employee history shows nothing L3 of someone above the viewer', async () => {
    const id = T.users.senior!.employeeId!;
    await ownerQuery(`INSERT INTO audit_logs (tenant_id, actor_id, action, target_type, target_id, change_metadata) VALUES ($1,$2,'leave.balance_adjusted','employee',$3,$4)`, [
      T.id,
      T.users.hr!.id,
      id,
      JSON.stringify({ reason: 'Medical adjustment', days: 5 }),
    ]);
    const exec = await as(T, 'exec');
    const r = await exec.get(`/api/v1/employees/${id}/history`);
    expect(r.body).not.toContain('Medical adjustment');
  });
});

describe('links and a same-person final rating', () => {
  it('F-117 changing a password ends the links still outstanding', async () => {
    const T = await createTenant();
    const [link] = await ownerQuery<{ id: string }>(
      `INSERT INTO admin_setup_tokens (tenant_id, user_id, token_hash, expires_at, purpose) VALUES ($1,$2,$3,now() + interval '30 minutes','reset') RETURNING id`,
      [T.id, T.users.employee!.id, 'a'.repeat(64)],
    );
    const emp = await as(T, 'employee');
    const r = await emp.post('/api/v1/auth/password', { currentPassword: 'Test-Password-123!', newPassword: 'Another-Long-Passphrase-77!' });
    expect(r.statusCode, r.body).toBe(200);
    expect((await ownerQuery<{ used_at: Date | null }>(`SELECT used_at FROM admin_setup_tokens WHERE id=$1`, [link!.id]))[0]!.used_at).not.toBeNull();
  });

  it('F-118 with no reviewing manager, the HR person who wrote the review does not also finalize it', async () => {
    const T = await createTenant();
    await person(T, 'hr2', ['hr_admin', 'employee']);
    const hr = await as(T, 'hr');
    const cycle = (await hr.post('/api/v1/performance/cycles', { name: 'FY', periodStart: '2026-04-01', periodEnd: '2027-03-31', selfReview: false })).json().id;
    expect((await hr.post(`/api/v1/performance/cycles/${cycle}/activate`)).statusCode).toBe(200);
    const [rv] = await ownerQuery<{ id: string; version: number }>(`SELECT id, version FROM performance_reviews WHERE cycle_id=$1 AND employee_id=$2`, [
      cycle,
      T.users.other!.employeeId,
    ]);
    const w = await hr.post(`/api/v1/performance/reviews/${rv!.id}/manager`, { rating: 3, comments: 'A fair review written by HR for this person.', expectedVersion: rv!.version });
    expect(w.statusCode, w.body).toBe(200);
    const again = await hr.post(`/api/v1/performance/reviews/${rv!.id}/finalize`, { rating: 5, expectedVersion: rv!.version + 1 });
    expect(again.statusCode, again.body).toBe(403);
    const hr2 = await as(T, 'hr2');
    expect((await hr2.post(`/api/v1/performance/reviews/${rv!.id}/finalize`, { rating: 4, expectedVersion: rv!.version + 1 })).statusCode).toBe(200);
  });
});
