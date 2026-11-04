import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, createTenant, flags, inApp, makeApp, ownerQuery, type TenantFixture } from './helpers.js';
import { escalateOverdue, reassignStranded } from '../src/core/workflow/engine.js';
import { withTenant } from '../src/db/tx.js';
import { effectiveLevel } from '../src/core/policy/levels.js';
import { resolveRolePermissions, roleGroup, SYSTEM_ROLES } from '../src/core/auth/permissions.js';

const FLAGS = flags('default,overtime,comp_off,expenses,payroll,payroll.payslips,loans,salary_advance');
const LEAVE = (d: string) => ({ leaveTypeId: '', startDate: d, endDate: d, reason: 'Family function' });

async function leaveType(T: TenantFixture) {
  const [t] = await ownerQuery<{ id: string }>(`INSERT INTO leave_types (tenant_id, code, name, paid, requires_balance, accrual_method) VALUES ($1,'LWP','Without pay',false,false,'none') RETURNING id`, [T.id]);
  return t!.id;
}
const nextWeekday = (n: number) => { const d = new Date(Date.UTC(2031, 0, 6 + n)); return d.toISOString().slice(0, 10); };
const stepsOf = (requestId: string) => ownerQuery<{ approver_kind: string; approver_user_id: string | null; approver_permission: string | null; step_index: number }>(`SELECT approver_kind, approver_user_id, approver_permission, step_index FROM approval_steps WHERE request_id=$1 ORDER BY step_index`, [requestId]);

describe('roles', () => {
  it('the thirteen existing roles keep their keys and go by the six names; owner resolves to Super-admin in multi', () => {
    const groups = new Set(SYSTEM_ROLES.filter((r) => r.key !== 'owner').map((r) => roleGroup(r.key)));
    expect(groups).toEqual(new Set(['Super-admin', 'Admin', 'HR', 'Payroll', 'Manager', 'Employee']));
    expect(SYSTEM_ROLES.filter((r) => r.key !== 'owner').length).toBe(13);
    expect([...resolveRolePermissions('owner', 'multi')].sort()).toEqual([...resolveRolePermissions('tenant_admin', 'multi')].sort());
    expect(resolveRolePermissions('owner', 'single')).toContain('payroll.manage');
    expect(resolveRolePermissions('reporting_manager', 'single')).not.toContain('leave.team.read');
    expect(resolveRolePermissions('hr_admin', 'single_hr')).not.toContain('payroll.read');
    expect(resolveRolePermissions('hr_admin', 'single_hr')).toContain('employees.manage');
  });
  it('effective level is the stored one between the roles floor and ceiling', () => {
    expect(effectiveLevel(0, ['hr_admin', 'employee'])).toBe(40);
    expect(effectiveLevel(99, ['hr_admin', 'employee'])).toBe(59);
    expect(effectiveLevel(85, ['payroll_manager'])).toBe(85);
    expect(effectiveLevel(0, [])).toBe(0);
    expect(effectiveLevel(0, ['owner'])).toBe(100);
    expect(effectiveLevel(50, ['custom:x'])).toBe(50);
    expect(effectiveLevel(70, ['custom:x'])).toBe(59);
  });
});

describe('single', () => {
  let app: FastifyInstance; let T: TenantFixture; let owner: Client; let emp: Client; let type: string;
  beforeAll(async () => {
    app = await makeApp({ ...FLAGS, ORG_MANAGEMENT_MODE: 'single' });
    T = await createTenant();
    // The fixture's admin has no employee: give the owner one of their own.
    await ownerQuery(`UPDATE employees SET user_id=$1, reporting_manager_id=NULL WHERE id=$2`, [T.users.admin!.id, T.users.hr!.employeeId]);
    await ownerQuery(`UPDATE users SET status='disabled' WHERE id=$1`, [T.users.hr!.id]);
    owner = await Client.login(app, T.host, T.users.admin!.email);
    emp = await Client.login(app, T.host, T.users.employee!.email);
    type = await leaveType(T);
  });
  afterAll(async () => { await app.close(); });

  it('the owner has everything and role management does not exist', async () => {
    const me = (await owner.get('/api/v1/auth/me')).json();
    expect(me.mode).toBe('single');
    expect(me.permissions).toContain('payroll.manage');
    expect(me.permissions).toContain('employees.manage');
    expect(me.views.map((v: { key: string }) => v.key)).toEqual(expect.arrayContaining(['employee', 'hr', 'payroll', 'admin', 'owner']));
    for (const [m, url] of [['GET', '/roles'], ['POST', '/roles'], ['PATCH', '/roles/custom:x'], ['DELETE', '/roles/custom:x']] as const) {
      expect((await owner.req(m, `/api/v1/tenant${url}`, m === 'GET' || m === 'DELETE' ? undefined : { name: 'XX', permissions: ['org.read'] })).statusCode, url).toBe(404);
    }
    expect((await emp.get('/api/v1/auth/me')).json().views.map((v: { key: string }) => v.key)).toEqual(['employee']);
  });

  it('roles outside the mode cannot be assigned, and there is one owner', async () => {
    const r = await owner.patch(`/api/v1/tenant/users/${T.users.other!.id}`, { roles: ['hr_admin', 'employee'] });
    expect(r.statusCode).toBe(400);
    expect((await owner.patch(`/api/v1/tenant/users/${T.users.other!.id}`, { roles: ['tenant_admin'] })).statusCode).toBe(409);
  });

  it('every request is one step, addressed to the owner by name, whatever the module', async () => {
    const r = await emp.post('/api/v1/leave/requests', { ...LEAVE(nextWeekday(0)), leaveTypeId: type });
    expect(r.statusCode, r.body).toBe(201);
    expect(await stepsOf(r.json().approvalRequestId)).toEqual([{ approver_kind: 'user', approver_user_id: T.users.admin!.id, approver_permission: null, step_index: 0 }]);
    expect((await owner.post(`/api/v1/approvals/${r.json().approvalRequestId}/act`, { action: 'approve' })).statusCode).toBe(200);
  });

  it('the owner may approve their own request, and it is always in the audit log', async () => {
    const r = await owner.post('/api/v1/leave/requests', { ...LEAVE(nextWeekday(1)), leaveTypeId: type });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().approvalRequestId;
    const inbox = (await owner.get('/api/v1/approvals/inbox')).json().items;
    expect(inbox.map((x: { id: string }) => x.id)).toContain(id);
    expect((await owner.post(`/api/v1/approvals/${id}/act`, { action: 'approve' })).statusCode).toBe(200);
    const rows = await ownerQuery<{ action: string; category: string }>(`SELECT action, category FROM audit_logs WHERE tenant_id=$1 AND action='approval.self_approved'`, [T.id]);
    expect(rows).toEqual([{ action: 'approval.self_approved', category: 'security' }]);
  });
});

describe('single_hr', () => {
  let app: FastifyInstance; let T: TenantFixture; let owner: Client; let hr: Client; let emp: Client; let type: string;
  beforeAll(async () => {
    app = await makeApp({ ...FLAGS, ORG_MANAGEMENT_MODE: 'single_hr' });
    T = await createTenant();
    await ownerQuery(`UPDATE employees SET reporting_manager_id=NULL WHERE tenant_id=$1`, [T.id]);
    owner = await Client.login(app, T.host, T.users.admin!.email);
    hr = await Client.login(app, T.host, T.users.hr!.email);
    emp = await Client.login(app, T.host, T.users.employee!.email);
    type = await leaveType(T);
  });
  afterAll(async () => { await app.close(); });

  it('role screens are gone; HR handles people and has no pay or settings', async () => {
    expect((await owner.get('/api/v1/tenant/roles')).statusCode).toBe(404);
    const me = (await hr.get('/api/v1/auth/me')).json();
    expect(me.permissions).toContain('leave.approve');
    expect(me.permissions).not.toContain('payroll.read');
    expect(me.permissions).not.toContain('settings.manage');
    expect((await hr.get('/api/v1/payroll/runs')).statusCode).toBe(403);
  });

  it('an employee’s leave is one step for HR or the owner, and either can decide it', async () => {
    const a = await emp.post('/api/v1/leave/requests', { ...LEAVE(nextWeekday(0)), leaveTypeId: type });
    expect((await stepsOf(a.json().approvalRequestId))[0]).toMatchObject({ approver_kind: 'permission', approver_permission: 'approvals.hr_step' });
    expect((await hr.post(`/api/v1/approvals/${a.json().approvalRequestId}/act`, { action: 'approve' })).statusCode).toBe(200);
    const b = await emp.post('/api/v1/leave/requests', { ...LEAVE(nextWeekday(1)), leaveTypeId: type });
    expect((await owner.post(`/api/v1/approvals/${b.json().approvalRequestId}/act`, { action: 'approve' })).statusCode).toBe(200);
  });

  it('whatever HR raises goes to the owner, so a sole HR person never strands their own request', async () => {
    const r = await hr.post('/api/v1/leave/requests', { ...LEAVE(nextWeekday(2)), leaveTypeId: type });
    expect(r.statusCode, r.body).toBe(201);
    expect(await stepsOf(r.json().approvalRequestId)).toEqual([{ approver_kind: 'user', approver_user_id: T.users.admin!.id, approver_permission: null, step_index: 0 }]);
    expect((await hr.post(`/api/v1/approvals/${r.json().approvalRequestId}/act`, { action: 'approve' })).statusCode).toBe(403);
    expect((await owner.post(`/api/v1/approvals/${r.json().approvalRequestId}/act`, { action: 'approve' })).statusCode).toBe(200);
  });

  it('money goes to the owner, not HR: an expense claim keeps its check there', async () => {
    const [cat] = await ownerQuery<{ id: string }>(`INSERT INTO expense_categories (tenant_id, code, name, requires_receipt) VALUES ($1,'M','Misc',false) RETURNING id`, [T.id]);
    const c = await emp.post('/api/v1/expenses/claims', { title: 'Taxi fare', purpose: 'Client visit' });
    expect(c.statusCode, c.body).toBe(201);
    const claim = c.json().id;
    const item = await emp.post(`/api/v1/expenses/claims/${claim}/items`, { categoryId: cat!.id, expenseDate: new Date().toISOString().slice(0, 10), amount: 100, description: 'Taxi' });
    expect(item.statusCode, item.body).toBe(201);
    const s = await emp.post(`/api/v1/expenses/claims/${claim}/submit`);
    expect(s.statusCode, s.body).toBe(200);
    const [req] = await ownerQuery<{ id: string }>(`SELECT id FROM approval_requests WHERE entity_id=$1`, [claim]);
    expect(await stepsOf(req!.id)).toEqual([{ approver_kind: 'user', approver_user_id: T.users.admin!.id, approver_permission: null, step_index: 0 }]);
    expect((await hr.post(`/api/v1/approvals/${req!.id}/act`, { action: 'approve' })).statusCode).toBe(403);
  });

  it('an HR step can be delegated by a holder, gets reminders, and escalates to the owner when overdue', async () => {
    const r = await emp.post('/api/v1/leave/requests', { ...LEAVE(nextWeekday(3)), leaveTypeId: type });
    const id = r.json().approvalRequestId as string;
    // Delegation: the other employee covers for HR today.
    const today = new Date().toISOString().slice(0, 10);
    await ownerQuery(`INSERT INTO approval_delegations (tenant_id, delegator_id, delegate_id, starts_on, ends_on, created_by) VALUES ($1,$2,$3,$4::date - 1,$4::date + 2,$2)`, [T.id, T.users.hr!.id, T.users.other!.id, today]);
    const other = await Client.login(app, T.host, T.users.other!.email);
    const inbox = (await other.get('/api/v1/approvals/inbox')).json().items;
    expect(inbox.map((x: { id: string }) => x.id)).toContain(id);
    // Escalation: overdue, it goes to the owner by name.
    await ownerQuery(`UPDATE approval_steps SET activated_at=now() - interval '10 days' WHERE request_id=$1`, [id]);
    const res = await inApp(app, () => withTenant(app.deps.pool, T.id, (db) => escalateOverdue(db, T.id, 3)));
    expect(res.escalated).toBeGreaterThanOrEqual(1);
    const [st] = await ownerQuery<{ escalated_to: string }>(`SELECT escalated_to FROM approval_steps WHERE request_id=$1`, [id]);
    expect(st!.escalated_to).toBe(T.users.admin!.id);
    // Reminders reach the holders and the owner.
    await ownerQuery(`UPDATE approval_requests SET created_at=now() - interval '10 days' WHERE id=$1`, [id]);
    const job = await owner.runJob('approvals.reminder');
    expect(job.json().status).toBe('succeeded');
    const reminded = await ownerQuery(`SELECT 1 FROM notifications WHERE tenant_id=$1 AND kind='approval.reminder'`, [T.id]);
    expect(reminded.length).toBeGreaterThan(0);
    expect((await other.post(`/api/v1/approvals/${id}/act`, { action: 'approve' })).statusCode).toBe(200);
    const [acted] = await ownerQuery<{ acted_via: string; acted_for: string }>(`SELECT acted_via, acted_for FROM approval_steps WHERE request_id=$1`, [id]);
    expect(acted).toMatchObject({ acted_via: 'delegation', acted_for: T.users.hr!.id });
  });

  it('with no HR left the step falls back: nothing waits forever', async () => {
    const r = await emp.post('/api/v1/leave/requests', { ...LEAVE(nextWeekday(4)), leaveTypeId: type });
    const moved = await inApp(app, async () => {
      await ownerQuery(`DELETE FROM user_roles WHERE tenant_id=$1 AND role_key='hr_admin'`, [T.id]);
      return withTenant(app.deps.pool, T.id, (db) => reassignStranded(db, T.id));
    });
    expect(moved).toBe(0); // the owner still holds the step
    expect((await owner.post(`/api/v1/approvals/${r.json().approvalRequestId}/act`, { action: 'approve' })).statusCode).toBe(200);
  });
});

describe('moving up: single to single_hr to multi, no data migration', () => {
  it('the same database under each mode; requests in flight keep their steps; the owner becomes Super-admin', async () => {
    const T = await createTenant();
    await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'owner')`, [T.users.admin!.id, T.id]);
    const type = await leaveType(T);
    const single = await makeApp({ ...FLAGS, ORG_MANAGEMENT_MODE: 'single' });
    const emp1 = await Client.login(single, T.host, T.users.employee!.email);
    const inFlight = (await emp1.post('/api/v1/leave/requests', { ...LEAVE(nextWeekday(0)), leaveTypeId: type })).json().approvalRequestId;
    await single.close();

    const hrApp = await makeApp({ ...FLAGS, ORG_MANAGEMENT_MODE: 'single_hr' });
    const hr = await Client.login(hrApp, T.host, T.users.hr!.email);
    expect((await hr.get('/api/v1/auth/me')).json().permissions).toContain('leave.approve');
    await hrApp.close();

    const multi = await makeApp({ ...FLAGS, ORG_MANAGEMENT_MODE: 'multi' });
    const owner = await Client.login(multi, T.host, T.users.admin!.email);
    const me = (await owner.get('/api/v1/auth/me')).json();
    expect(me.mode).toBe('multi');
    expect(me.salaryLevel).toBe(100);
    expect(me.roles.map((r: { group: string }) => r.group)).toContain('Owner');
    expect((await owner.get('/api/v1/tenant/roles')).statusCode).toBe(200);
    expect(await stepsOf(inFlight)).toEqual([{ approver_kind: 'user', approver_user_id: T.users.admin!.id, approver_permission: null, step_index: 0 }]);
    expect((await owner.post(`/api/v1/approvals/${inFlight}/act`, { action: 'approve' })).statusCode).toBe(200);
    // New requests take the multi-level route, and nobody approves their own.
    const mgrEmp = await Client.login(multi, T.host, T.users.employee!.email);
    const fresh = (await mgrEmp.post('/api/v1/leave/requests', { ...LEAVE(nextWeekday(1)), leaveTypeId: type })).json().approvalRequestId;
    expect((await stepsOf(fresh))[0]).toMatchObject({ approver_kind: 'user', approver_user_id: T.users.manager!.id });
    expect((await mgrEmp.post(`/api/v1/approvals/${fresh}/act`, { action: 'approve' })).statusCode).toBe(403);
    await multi.close();
  }, 60000);

  it('in multi the preparer cannot approve payroll', async () => {
    const app = await makeApp({ ...FLAGS, ORG_MANAGEMENT_MODE: 'multi' });
    const T = await createTenant();
    await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'finance_manager')`, [T.users.payroll!.id, T.id]);
    const pay = await Client.login(app, T.host, T.users.payroll!.email);
    const run = (await pay.post('/api/v1/payroll/runs', { period: '2031-01', legalEntityId: T.legalEntityId })).json().id;
    expect((await pay.post(`/api/v1/payroll/runs/${run}/compute`)).statusCode).toBe(200);
    expect((await pay.post(`/api/v1/payroll/runs/${run}/submit`)).statusCode).toBe(200);
    const [req] = await ownerQuery<{ id: string }>(`SELECT id FROM approval_requests WHERE entity_id=$1`, [run]);
    expect((await pay.post(`/api/v1/approvals/${req!.id}/act`, { action: 'approve' })).statusCode).toBe(403);
    await app.close();
  });
});
