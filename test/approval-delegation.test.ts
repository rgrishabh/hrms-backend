import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture } from './helpers.js';
import { TEST_OWNER_URL } from './env.js';
import { createApprovalRequest, registerApprovalHandler, type StepSpec } from '../src/core/workflow/engine.js';
import type { Db } from '../src/db/tx.js';

// Delegation (an approver away hands their approvals to a colleague) and escalation (a step unanswered for too long).
let app: FastifyInstance; let T: TenantFixture; let c: pg.Client;
let admin: Client; let hr: Client; let mgr: Client; let emp: Client; let other: Client;
let today = '';
const day = (n: number) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const create = (requester: string, steps: StepSpec[], summary = 'Delegation test') => createApprovalRequest(c as unknown as Db, T.id, {
  entityType: 'delegation_test', entityId: randomUUID(), requesterId: T.users[requester]!.id, summary, steps });
const inboxItem = async (cl: Client, id: string) => (await cl.get('/api/v1/approvals/inbox')).json().items.find((x: { id: string }) => x.id === id);
const delegate = (cl: Client, delegateKey: string, startsOn = today, endsOn = day(3), extra: Record<string, unknown> = {}) =>
  cl.post('/api/v1/approvals/delegations', { delegateId: T.users[delegateKey]!.id, startsOn, endsOn, ...extra });
const revokeAll = () => ownerQuery(`UPDATE approval_delegations SET revoked_at=now() WHERE tenant_id=$1 AND revoked_at IS NULL`, [T.id]);
const notes = (key: string, kind: string) => ownerQuery<{ title: string }>(`SELECT title FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND kind=$3 ORDER BY created_at`, [T.id, T.users[key]!.id, kind]);

beforeAll(async () => {
  app = await makeApp({ ENABLED_MODULES: 'default,leave' });
  registerApprovalHandler('delegation_test', { label: 'Test request', onApproved: async () => {}, onRejected: async () => {} });
  T = await createTenant();
  c = new pg.Client({ connectionString: TEST_OWNER_URL });
  await c.connect();
  const login = (k: string) => Client.login(app, T.host, T.users[k]!.email);
  admin = await login('admin'); hr = await login('hr'); mgr = await login('manager'); emp = await login('employee'); other = await login('other');
  today = (await mgr.get('/api/v1/approvals/delegations')).json().today;
});
afterAll(async () => { await c.end(); await app.close(); });

describe('delegation', () => {
  it("a delegate sees and decides the manager's requests, recorded as on the manager's behalf", async () => {
    const r = await delegate(mgr, 'other', today, day(3), { note: 'On leave' });
    expect(r.statusCode).toBe(201);
    expect((await notes('other', 'approval.delegated')).at(-1)!.title).toBe(`You approve for manager from ${today} to ${day(3)}`);
    const id = await create('employee', [{ kind: 'user', userId: T.users.manager!.id }]);
    expect((await notes('other', 'approval.requested')).at(-1)!.title).toMatch(/needs your approval \(covering for manager\)/);

    const item = await inboxItem(other, id);
    expect(item).toMatchObject({ via: 'delegation', on_behalf_of: 'manager' });
    expect(await inboxItem(mgr, id)).toMatchObject({ via: null });          // the manager can still decide it
    expect((await other.post(`/api/v1/approvals/${id}/act`, { action: 'approve' })).json().status).toBe('approved');
    const hist = (await mgr.get(`/api/v1/approvals/${id}`)).json();
    expect(hist.steps[0]).toMatchObject({ acted_by_name: 'other', acted_for_name: 'manager', acted_via: 'delegation' });

    const lists = (await mgr.get('/api/v1/approvals/delegations')).json();
    expect(lists.given[0]).toMatchObject({ delegate_name: 'other', state: 'active', note: 'On leave' });
    expect((await other.get('/api/v1/approvals/delegations')).json().received[0]).toMatchObject({ delegator_name: 'manager' });
  });

  it('refuses overlapping, chained, back-dated and too-long delegations', async () => {
    let r = await delegate(mgr, 'hr', day(2), day(5));
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toMatch(/already handed to other/);
    r = await delegate(hr, 'manager', day(1), day(2));
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toMatch(/manager is handing over their own approvals/);
    expect((await delegate(hr, 'other', day(-1), day(2))).json().error.message).toMatch(/cannot start in the past/);
    expect((await delegate(hr, 'other', today, day(90))).json().error.message).toMatch(/at most 90 days/);
    expect((await delegate(hr, 'hr')).json().error.message).toMatch(/someone else/);
    // Only HR sets one up for someone else.
    r = await emp.post('/api/v1/approvals/delegations', { delegateId: T.users.other!.id, startsOn: today, endsOn: today, delegatorId: T.users.hr!.id });
    expect(r.statusCode).toBe(403);
    expect((await emp.get('/api/v1/approvals/delegations?scope=all')).statusCode).toBe(403);
    expect((await emp.get('/api/v1/approvals/delegates?q=oth')).json().items.map((u: { name: string }) => u.name)).toEqual(['other']);
  });

  it('group steps are never delegated, and a delegate never decides their own request', async () => {
    const grp = await create('employee', [{ kind: 'permission', permission: 'leave.approve' }]);
    expect(await inboxItem(other, grp)).toBeUndefined();
    const own = await create('other', [{ kind: 'user', userId: T.users.manager!.id }]);
    expect(await inboxItem(other, own)).toBeUndefined();
    expect((await other.post(`/api/v1/approvals/${own}/act`, { action: 'approve' })).statusCode).toBe(403);
  });

  it('ending a delegation takes the requests back; the delegate may decline it too', async () => {
    const id = await create('employee', [{ kind: 'user', userId: T.users.manager!.id }]);
    expect(await inboxItem(other, id)).toBeDefined();
    const d = (await mgr.get('/api/v1/approvals/delegations')).json().given[0];
    expect((await other.post(`/api/v1/approvals/delegations/${d.id}/revoke`)).statusCode).toBe(200);   // declined by the delegate
    expect((await notes('manager', 'approval.delegated')).at(-1)!.title).toBe('other can no longer approve for you');
    expect(await inboxItem(other, id)).toBeUndefined();
    expect((await other.post(`/api/v1/approvals/${id}/act`, { action: 'approve' })).statusCode).toBe(403);
    expect((await mgr.post(`/api/v1/approvals/delegations/${d.id}/revoke`)).statusCode).toBe(409);
    expect((await mgr.get('/api/v1/approvals/delegations')).json().given[0].state).toBe('revoked');
  });

  it('HR hands over approvals for someone absent; a delegate cannot approve twice through the person they cover for', async () => {
    const r = await hr.post('/api/v1/approvals/delegations', { delegateId: T.users.other!.id, startsOn: today, endsOn: day(1), delegatorId: T.users.hr!.id });
    expect(r.statusCode).toBe(201);
    // HR decides step 1 as a leave approver; step 2 is addressed to HR personally — the delegate covering for HR may not take it.
    const id = await create('employee', [{ kind: 'permission', permission: 'leave.approve' }, { kind: 'user', userId: T.users.hr!.id }]);
    expect((await hr.post(`/api/v1/approvals/${id}/act`, { action: 'approve' })).statusCode).toBe(200);
    expect(await inboxItem(other, id)).toBeUndefined();
    const x = await other.post(`/api/v1/approvals/${id}/act`, { action: 'approve' });
    expect(x.statusCode).toBe(403);
    expect(x.json().error.message).toMatch(/covering for decided an earlier step/);

    await revokeAll();
    const onBehalf = await hr.post('/api/v1/approvals/delegations', { delegateId: T.users.other!.id, startsOn: today, endsOn: today, delegatorId: T.users.manager!.id });
    expect(onBehalf.statusCode).toBe(201);
    expect((await notes('manager', 'approval.delegated')).at(-1)!.title).toBe(`HR handed your approvals to other on ${today}`);
    expect((await hr.get('/api/v1/approvals/delegations?scope=all')).json().items[0]).toMatchObject({ delegator_name: 'manager', set_up_by_hr: true });
    await revokeAll();
  });
});

describe('escalation', () => {
  const run = async () => (await admin.runJob('approvals.escalation')).json();
  const age = (id: string, days: number) => ownerQuery(`UPDATE approval_steps SET activated_at = now() - make_interval(days => $2) WHERE request_id=$1 AND status='active'`, [id, days]);

  it('can be turned off', async () => {
    expect((await admin.put('/api/v1/tenant/settings/approvals.escalate_after_days', { value: 0 })).statusCode).toBe(200);
    const id = await create('other', [{ kind: 'user', userId: T.users.employee!.id }]);
    await age(id, 10);
    expect((await run()).result).toMatchObject({ skipped: 'escalation turned off' });
    await ownerQuery(`UPDATE approval_requests SET status='cancelled' WHERE id=$1`, [id]);
  });

  it("sends an overdue step to the approver's manager, once; the approver can still decide", async () => {
    expect((await admin.put('/api/v1/tenant/settings/approvals.escalate_after_days', { value: 2 })).statusCode).toBe(200);
    const fresh = await create('other', [{ kind: 'user', userId: T.users.employee!.id }], 'Fresh request');
    const id = await create('other', [{ kind: 'user', userId: T.users.employee!.id }], 'Overdue request');
    await age(id, 3);
    expect((await run()).result).toMatchObject({ escalated: 1, toManager: 1, toGroup: 0 });
    expect(await inboxItem(mgr, fresh)).toBeUndefined();
    expect(await inboxItem(mgr, id)).toMatchObject({ via: 'escalation', on_behalf_of: 'employee' });
    expect(await inboxItem(emp, id)).toMatchObject({ via: null });
    expect((await notes('manager', 'approval.escalated')).at(-1)!.title).toMatch(/Escalated to you: test request from other/);
    expect((await notes('employee', 'approval.escalated')).at(-1)!.title).toMatch(/escalated to manager after 2 day/);
    expect((await run()).result).toMatchObject({ escalated: 0 });         // once per step

    expect((await mgr.post(`/api/v1/approvals/${id}/act`, { action: 'approve' })).json().status).toBe('approved');
    const hist = (await other.get(`/api/v1/approvals/${id}`)).json();
    expect(hist.steps[0]).toMatchObject({ acted_by_name: 'manager', acted_for_name: 'employee', acted_via: 'escalation', escalated_to_name: 'manager' });
  });

  it('goes to HR when the approver has no manager; group steps are left to reminders', async () => {
    const id = await create('employee', [{ kind: 'user', userId: T.users.manager!.id }]);
    const grp = await create('other', [{ kind: 'permission', permission: 'leave.approve' }]);
    await age(id, 5); await age(grp, 5);
    expect((await run()).result).toMatchObject({ escalated: 1, toGroup: 1 });
    expect(await inboxItem(hr, id)).toMatchObject({ via: 'escalation', on_behalf_of: 'manager' });
    expect(await inboxItem(other, id)).toBeUndefined();
    expect((await hr.post(`/api/v1/approvals/${id}/act`, { action: 'reject', comment: 'Overlaps the audit' })).json().status).toBe('rejected');
  });
});
