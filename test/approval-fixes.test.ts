import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture, flags } from './helpers.js';
import { TEST_OWNER_URL } from './env.js';
import { createApprovalRequest, type StepSpec } from '../src/core/workflow/engine.js';
import type { Db } from '../src/db/tx.js';

let app: FastifyInstance;
let c: pg.Client;
const create = (T: TenantFixture, requesterKey: string, steps: StepSpec[], excludeUserIds: string[] = []) =>
  createApprovalRequest(c as unknown as Db, T.id, {
    entityType: 'leave_request',
    entityId: randomUUID(),
    requesterId: T.users[requesterKey]!.id,
    summary: 'Engine test',
    steps,
    excludeUserIds,
  });
const inInbox = async (cl: Client, id: string) => (await cl.get('/api/v1/approvals/inbox')).json().items.some((x: { id: string }) => x.id === id);
const login = (T: TenantFixture, key: string) => Client.login(app, T.host, T.users[key]!.email);
const disable = (admin: Client, id: string) => admin.patch(`/api/v1/tenant/users/${id}`, { status: 'disabled' });

beforeAll(async () => {
  app = await makeApp({ ...flags('default,leave,core.offboarding') });
  c = new pg.Client({ connectionString: TEST_OWNER_URL });
  await c.connect();
});
afterAll(async () => {
  await c.end();
  await app.close();
});

describe('F-14 approvals that would stick', () => {
  it('disabling an approver moves their pending steps to their manager', async () => {
    const T = await createTenant();
    const mgr = await login(T, 'manager');
    const admin = await login(T, 'admin');
    await ownerQuery(`UPDATE employees SET reporting_manager_id=$2 WHERE id=$1`, [T.users.other!.employeeId, T.users.manager!.employeeId]);
    const id = await create(T, 'employee', [{ kind: 'user', userId: T.users.other!.id }]);
    expect(await inInbox(mgr, id)).toBe(false);
    expect((await disable(admin, T.users.other!.id)).statusCode).toBe(200);
    expect(await inInbox(mgr, id)).toBe(true);
    expect((await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='approval.reassigned' AND actor_type='system'`, [T.id])).length).toBe(1);
  });

  it('a leaver losing access at separation hands over their pending steps the same way', async () => {
    const T = await createTenant();
    const hr = await login(T, 'hr');
    const leaver = T.users.other!;
    const [sep] = await ownerQuery<{ id: string }>(
      `INSERT INTO separations (tenant_id, employee_id, kind, reason, notice_date, notice_days_required, requested_lwd, approved_lwd, status, initiated_by)
      VALUES ($1,$2,'resignation','Fixture','2025-01-01',30,'2025-02-01','2025-02-01','approved',$3) RETURNING id`,
      [T.id, leaver.employeeId, T.users.hr!.id],
    );
    const id = await create(T, 'employee', [{ kind: 'user', userId: leaver.id }]);
    const done = await hr.post(`/api/v1/lifecycle/separations/${sep!.id}/complete`, { rehireEligible: true });
    expect(done.statusCode, done.body).toBe(200);
    expect(await inInbox(hr, id)).toBe(true);
  });

  it('with no manager to take them, they go to the fallback owner', async () => {
    const T = await createTenant();
    const hr = await login(T, 'hr');
    const admin = await login(T, 'admin');
    const id = await create(T, 'employee', [{ kind: 'user', userId: T.users.other!.id }]);
    await disable(admin, T.users.other!.id);
    expect(await inInbox(hr, id)).toBe(true);
    expect((await hr.post(`/api/v1/approvals/${id}/act`, { action: 'reject', comment: 'Decided by the fallback owner' })).statusCode).toBe(200);
  });

  it('a request addressed to a disabled person goes to the fallback owner from the start', async () => {
    const T = await createTenant();
    const hr = await login(T, 'hr');
    await ownerQuery(`UPDATE users SET status='disabled' WHERE id=$1`, [T.users.other!.id]);
    expect(await inInbox(hr, await create(T, 'employee', [{ kind: 'user', userId: T.users.other!.id }]))).toBe(true);
  });

  it('a group step whose only holder is the requester goes to the fallback owner', async () => {
    const T = await createTenant();
    const hr = await login(T, 'hr');
    // payroll_manager holds attendance.lock alone in this tenant.
    const id = await create(T, 'payroll', [{ kind: 'permission', permission: 'attendance.lock' }]);
    expect(await inInbox(hr, id)).toBe(true);
    expect((await hr.post(`/api/v1/approvals/${id}/act`, { action: 'reject', comment: 'Decided by the fallback owner' })).statusCode).toBe(200);
  });

  it('when nobody at all can act: administrators are warned and can reassign, within limits', async () => {
    const T = await createTenant();
    await ownerQuery(`UPDATE users SET status='disabled' WHERE id=$1`, [T.users.hr!.id]);
    // Held by nobody here: administrators now hold payroll.approve themselves (salaries are visible only above their subject).
    const id = await create(T, 'employee', [{ kind: 'permission', permission: 'expenses.approve' }]);
    const admin = await login(T, 'admin');
    const warned = await ownerQuery(`SELECT 1 FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND kind='approval.no_approver'`, [T.id, T.users.admin!.id]);
    expect(warned.length).toBe(1);
    expect((await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='approval.no_eligible_approver'`, [T.id])).length).toBe(1);
    const url = `/api/v1/approvals/${id}/reassign`;
    const emp = await login(T, 'employee');
    expect((await emp.post(url, { userId: T.users.other!.id, reason: 'No authority' })).statusCode).toBe(403);
    expect((await admin.post(url, { userId: T.users.employee!.id, reason: 'That is the requester' })).statusCode).toBe(400);
    expect((await admin.post(url, { userId: T.users.admin!.id, reason: 'Giving it to myself' })).statusCode).toBe(400);
    expect((await admin.post(url, { userId: T.users.hr!.id, reason: 'Disabled person' })).statusCode).toBe(400);
    const r = await admin.post(url, { userId: T.users.manager!.id, reason: 'Finance is away this month' });
    expect(r.statusCode, r.body).toBe(200);
    const mgr = await login(T, 'manager');
    expect(await inInbox(mgr, id)).toBe(true);
    expect((await mgr.post(`/api/v1/approvals/${id}/act`, { action: 'reject', comment: 'Reassigned to me' })).statusCode).toBe(200);
  });

  it('an administrator can only reassign a request nobody can act on; the fallback owner any', async () => {
    const T = await createTenant();
    const id = await create(T, 'employee', [{ kind: 'permission', permission: 'leave.approve' }]);
    const admin = await login(T, 'admin');
    const body = { userId: T.users.manager!.id, reason: 'Moving it along' };
    expect((await admin.post(`/api/v1/approvals/${id}/reassign`, body)).statusCode).toBe(409);
    expect((await (await login(T, 'hr')).post(`/api/v1/approvals/${id}/reassign`, body)).statusCode).toBe(200);
  });

  it('the job moves a group step when its last holder has gone, even with escalation off', async () => {
    const T = await createTenant();
    const hr = await login(T, 'hr');
    const admin = await login(T, 'admin');
    await ownerQuery(`UPDATE user_roles SET role_key='finance_manager' WHERE user_id=$1 AND role_key='employee'`, [T.users.other!.id]);
    const id = await create(T, 'employee', [{ kind: 'permission', permission: 'expenses.approve' }]);
    expect(await inInbox(hr, id)).toBe(false);
    await ownerQuery(`UPDATE users SET status='disabled' WHERE id=$1`, [T.users.other!.id]);
    expect((await admin.put('/api/v1/tenant/settings/approvals.escalate_after_days', { value: 0 })).statusCode).toBe(200);
    const run = await admin.runJob('approvals.escalation');
    expect(run.statusCode, run.body).toBe(200);
    expect(await inInbox(hr, id)).toBe(true);
  });

  it('escalation is on by default', async () => {
    const T = await createTenant();
    const admin = await login(T, 'admin');
    const s = (await admin.get('/api/v1/tenant/settings')).json();
    const item = (s.items ?? s.settings ?? s).find((x: { key: string }) => x.key === 'approvals.escalate_after_days');
    expect(item.value ?? item.effective).toBeGreaterThan(0);
  });
});
