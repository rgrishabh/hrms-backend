import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { Client, createTenant, makeApp, ownerQuery, type TenantFixture } from './helpers.js';
import { TEST_APP_URL } from './env.js';

/**
 * The chain serializes audited writes of one organization. These run the contention for real: many writers, and two transactions that
 * take the head and another row in opposite orders, which is the shape an approval (audit, then its effect) has against an employee edit.
 */
let app: FastifyInstance; let T: TenantFixture; let admin: Client;
beforeAll(async () => { app = await makeApp(); T = await createTenant(); admin = await Client.login(app, T.host, T.users.admin!.email); });
afterAll(async () => { await app.close(); });

const AUDIT = (action: string): [string, string[]] => [`INSERT INTO audit_logs (tenant_id, actor_type, action, category) VALUES ($1,'system',$2,'data')`, [T.id, action]];
const connect = async () => { const c = new pg.Client({ connectionString: TEST_APP_URL }); await c.connect(); await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id',$1,true)`, [T.id]); return c; };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('audit chain under contention', () => {
  it('two transactions taking the head and a row in opposite orders both commit', async () => {
    const empId = T.users.employee!.employeeId!;
    const first = await connect(); const second = await connect();
    const results = await Promise.allSettled([
      (async () => {
        await first.query(...AUDIT('deadlock.first'));
        await wait(100);
        await first.query(`UPDATE employees SET updated_at=now() WHERE id=$1`, [empId]);
        await first.query('COMMIT');
      })(),
      (async () => {
        await second.query(`UPDATE employees SET updated_at=now() WHERE id=$1`, [empId]);
        await wait(100);
        await second.query(...AUDIT('deadlock.second'));
        await second.query('COMMIT');
      })(),
    ]);
    await first.end().catch(() => undefined); await second.end().catch(() => undefined);
    expect(results.map((r) => (r.status === 'rejected' ? (r.reason as { code?: string }).code : 'ok'))).toEqual(['ok', 'ok']);
  }, 15000);

  it('forty concurrent audited writes through the app all succeed, and the chain stays whole', async () => {
    expect((await admin.put('/api/v1/tenant/settings/approvals.escalate_after_days', { value: 1 })).statusCode).toBe(200);
    const started = Date.now();
    const answers = await Promise.all(Array.from({ length: 40 }, (_, i) => admin.put('/api/v1/tenant/settings/approvals.escalate_after_days', { value: (i % 5) + 1 })));
    const elapsed = Date.now() - started;
    expect(answers.filter((a) => a.statusCode !== 200).map((a) => a.body)).toEqual([]);
    expect((await admin.get('/api/v1/tenant/audit/chain/verify')).json()).toMatchObject({ ok: true, brokenAt: null });
    expect(elapsed).toBeLessThan(15000);
  }, 30000);

  it('a long transaction that audited early holds nobody up', async () => {
    const slow = await connect();
    await slow.query(...AUDIT('slow.first'));
    const t0 = Date.now();
    const quick = await admin.put('/api/v1/tenant/settings/approvals.escalate_after_days', { value: 2 });
    const waited = Date.now() - t0;
    await slow.query('COMMIT');
    await slow.end();
    expect(quick.statusCode).toBe(200);
    expect(waited).toBeLessThan(3000);
    expect((await admin.get('/api/v1/tenant/audit/chain/verify')).json().ok).toBe(true);
  }, 30000);

  it('an audit row cannot be updated by a statement, and a committed row always has its chain columns', async () => {
    const c = await connect();
    await c.query(...AUDIT('open.row'));
    await expect(c.query(`UPDATE audit_logs SET chain_seq=999999, prev_hash='x', row_hash='y' WHERE action='open.row' AND tenant_id=$1`, [T.id])).rejects.toThrow();
    await c.query('ROLLBACK');
    await c.end();
    expect(await ownerQuery(`SELECT 1 FROM audit_logs WHERE chain_seq IS NULL OR row_hash IS NULL OR prev_hash IS NULL`)).toEqual([]);
  });

  it('rows of one transaction stay in order and a rollback leaves no gap', async () => {
    const c = await connect();
    await c.query(...AUDIT('rolled.back'));
    await c.query('ROLLBACK');
    await c.end();
    const d = await connect();
    await d.query(...AUDIT('kept.one'));
    await d.query(...AUDIT('kept.two'));
    await d.query('COMMIT');
    await d.end();
    const rows = await ownerQuery<{ action: string; chain_seq: string }>(`SELECT action, chain_seq FROM audit_logs WHERE tenant_id=$1 ORDER BY chain_seq DESC LIMIT 2`, [T.id]);
    expect(rows.map((r) => r.action)).toEqual(['kept.two', 'kept.one']);
    expect(Number(rows[0]!.chain_seq)).toBe(Number(rows[1]!.chain_seq) + 1);
    expect((await admin.get('/api/v1/tenant/audit/chain/verify')).json().ok).toBe(true);
  });
});
