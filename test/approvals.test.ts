import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, type TenantFixture } from './helpers.js';
import { TEST_OWNER_URL } from './env.js';
import { createApprovalRequest } from '../src/core/workflow/engine.js';
import type { Db } from '../src/db/tx.js';

// Maker-checker rules of the approval engine itself, independent of any module.
let app: FastifyInstance; let T: TenantFixture; let c: pg.Client;
let hr: Client; let mgr: Client;
const create = (p: Partial<Parameters<typeof createApprovalRequest>[2]>) => createApprovalRequest(c as unknown as Db, T.id, {
  entityType: 'leave_request', entityId: randomUUID(), requesterId: T.users.employee!.id, summary: 'Engine test', steps: [{ kind: 'permission', permission: 'leave.approve' }], ...p });
const inInbox = async (cl: Client, id: string) => (await cl.get('/api/v1/approvals/inbox')).json().items.some((x: { id: string }) => x.id === id);

beforeAll(async () => {
  app = await makeApp({ ENABLED_MODULES: 'default,leave' }); // registers the approval handlers
  T = await createTenant();
  c = new pg.Client({ connectionString: TEST_OWNER_URL });
  await c.connect();
  hr = await Client.login(app, T.host, T.users.hr!.email);
  mgr = await Client.login(app, T.host, T.users.manager!.email);
});
afterAll(async () => { await c.end(); await app.close(); });

describe('approval engine', () => {
  it('an excluded party (author, the person it concerns) never sees or acts on the request', async () => {
    const id = await create({ excludeUserIds: [T.users.hr!.id] });
    expect(await inInbox(hr, id)).toBe(false);
    const r = await hr.post(`/api/v1/approvals/${id}/act`, { action: 'approve' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toMatch(/prepared or that concerns you/);
    const [n] = (await c.query(`SELECT count(*)::int AS n FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND kind='approval.requested'`, [T.id, T.users.hr!.id])).rows;
    expect(n.n).toBe(0);
  });

  it('an excluded user named as a step approver is dropped from the chain', async () => {
    const id = await create({ steps: [{ kind: 'user', userId: T.users.manager!.id }, { kind: 'permission', permission: 'leave.approve' }], excludeUserIds: [T.users.manager!.id] });
    expect(await inInbox(mgr, id)).toBe(false);
    expect(await inInbox(hr, id)).toBe(true); // the permission step is now first
  });

  it('two steps need two people: whoever approved one step cannot approve the next', async () => {
    const id = await create({ steps: [{ kind: 'user', userId: T.users.hr!.id }, { kind: 'permission', permission: 'leave.approve' }] });
    expect((await hr.post(`/api/v1/approvals/${id}/act`, { action: 'approve' })).statusCode).toBe(200);
    expect(await inInbox(hr, id)).toBe(false);
    const again = await hr.post(`/api/v1/approvals/${id}/act`, { action: 'approve' });
    expect(again.statusCode).toBe(403);
    expect(again.json().error.message).toMatch(/different person/);
  });
});
