import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { Client, createTenant, makeApp, ownerQuery, type TenantFixture } from './helpers.js';
import { TEST_APP_URL, TEST_OWNER_URL } from './env.js';
import { redact } from '../src/core/audit/audit.js';

let app: FastifyInstance; let T: TenantFixture; let admin: Client;
beforeAll(async () => {
  app = await makeApp();
  T = await createTenant();
  admin = await Client.login(app, T.host, T.users.admin!.email);
  for (let i = 0; i < 3; i++) await admin.put('/api/v1/tenant/settings/approvals.escalate_after_days', { value: i + 1 });
});
afterAll(async () => { await app.close(); });

const rawAs = async <R>(url: string, fn: (c: pg.Client) => Promise<R>) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
};

describe('hash-chained audit log', () => {
  it('each row chains to the one before it, per tenant', async () => {
    const rows = await ownerQuery<{ chain_seq: string; prev_hash: string; row_hash: string }>(`SELECT chain_seq, prev_hash, row_hash FROM audit_logs WHERE tenant_id=$1 ORDER BY chain_seq`, [T.id]);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0]!.prev_hash).toBe('0'.repeat(64));
    rows.forEach((r, i) => { expect(Number(r.chain_seq)).toBe(i + 1); if (i) expect(r.prev_hash).toBe(rows[i - 1]!.row_hash); expect(r.row_hash).toMatch(/^[0-9a-f]{64}$/); });
  });

  it('concurrent writers still make one unbroken chain', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => admin.put('/api/v1/tenant/settings/approvals.escalate_after_days', { value: (i % 5) + 1 })));
    const v = await admin.get('/api/v1/tenant/audit/chain/verify');
    expect(v.json()).toMatchObject({ ok: true, brokenAt: null });
  });

  it('the app role cannot change or delete a row, and neither can the owner without removing the guard', async () => {
    for (const url of [TEST_APP_URL, TEST_OWNER_URL]) {
      await rawAs(url, async (c) => {
        await c.query(`SELECT set_config('app.tenant_id',$1,false)`, [T.id]);
        await expect(c.query(`UPDATE audit_logs SET action='x' WHERE tenant_id=$1`, [T.id])).rejects.toThrow();
        await expect(c.query(`DELETE FROM audit_logs WHERE tenant_id=$1`, [T.id])).rejects.toThrow();
      });
    }
    await rawAs(TEST_APP_URL, async (c) => {
      await expect(c.query('TRUNCATE audit_logs')).rejects.toThrow();
      await expect(c.query('SELECT * FROM audit_chain_heads')).rejects.toThrow();
      await expect(c.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_change')).rejects.toThrow();
    });
  });

  it('verify finds a row that was changed, and the first row after a gap', async () => {
    const X = await createTenant();
    const a = await Client.login(app, X.host, X.users.admin!.email);
    for (let i = 0; i < 3; i++) await a.put('/api/v1/tenant/settings/approvals.escalate_after_days', { value: i + 1 });
    expect((await a.get('/api/v1/tenant/audit/chain/verify')).json().ok).toBe(true);
    await rawAs(TEST_OWNER_URL, async (c) => {
      await c.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_change');
      try {
        await c.query(`UPDATE audit_logs SET change_metadata='{"forged":true}' WHERE tenant_id=$1 AND chain_seq=2`, [X.id]);
        const broke = (await a.get('/api/v1/tenant/audit/chain/verify')).json();
        expect(broke).toMatchObject({ ok: false, brokenAt: 2, reason: 'row was changed' });
        await c.query(`DELETE FROM audit_logs WHERE tenant_id=$1 AND chain_seq=1`, [X.id]);
        expect((await a.get('/api/v1/tenant/audit/chain/verify')).json().ok).toBe(false);
      } finally { await c.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_change'); }
    });
  });

  it('the viewer and verify are for the Owner and Super-admin only, whatever an audit reader holds', async () => {
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    expect((await hr.get('/api/v1/tenant/audit')).statusCode).toBe(200);
    expect((await hr.get('/api/v1/tenant/audit/chain')).statusCode).toBe(403);
    expect((await hr.get('/api/v1/tenant/audit/chain/verify')).statusCode).toBe(403);
    const list = await admin.get('/api/v1/tenant/audit/chain?pageSize=5');
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0].row_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('metadata carrying money is removed when written, and hidden on old rows', () => {
    const clean = redact({ gross: 100, net: 90, totals: { net: 1 }, amount: 5, annualCtc: 12, pan: 'ABCDE1234F', aadhaar: '1', newLast4: '1234', nested: { employerCost: 1, ok: 'yes' }, fields: ['amount'] }) as Record<string, unknown>;
    expect(JSON.stringify(clean)).not.toMatch(/ABCDE1234F|: ?100|1234/);
    expect(clean.fields).toEqual(['amount']);
    expect((clean.nested as { ok: string }).ok).toBe('yes');
  });

  it('old rows with amounts come back redacted from both audit views', async () => {
    const X = await createTenant();
    await ownerQuery(`INSERT INTO audit_logs (tenant_id, action, target_type, target_id, change_metadata) VALUES ($1,'payroll.run_computed','employee',$2,'{"gross": 987654, "net": 876543}')`, [X.id, X.users.employee!.employeeId]);
    const a = await Client.login(app, X.host, X.users.admin!.email);
    for (const url of ['/api/v1/tenant/audit', `/api/v1/employees/${X.users.employee!.employeeId}/history`, '/api/v1/tenant/audit/chain']) {
      const r = await a.get(url);
      expect(r.statusCode, url).toBe(200);
      expect(r.body, url).not.toMatch(/987654|876543/);
    }
  });
});
