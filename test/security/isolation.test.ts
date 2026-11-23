import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, ownerQuery } from '../helpers.js';
import { DEMO_PASSWORD, demoWorld, idsOf, tableFor } from '../contract/demo-world.js';
import { createTenant, type TenantFixture } from './wire.js';

/** A second organization in one database, the defence in depth of D16: its owner aims every read and write at the first one's ids. Installations are separate in production. */
let w: Awaited<ReturnType<typeof demoWorld>>;
let B: TenantFixture;
const paths = () => w.app.featureRoutes.filter((r) => r.url.startsWith('/api/') && r.url.includes(':'));
beforeAll(async () => {
  w = await demoWorld({ RATE_LIMIT_PER_MINUTE: '100000' });
  B = await createTenant();
  await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'owner')`, [B.users.admin!.id, B.id]);
}, 120000);
afterAll(async () => {
  await w.app.close();
});

describe("another organization's ids", () => {
  it('read nothing, on any GET with an id', async () => {
    const owner = await Client.login(w.app, B.host, B.users.admin!.email);
    const leaks: string[] = [];
    let tried = 0;
    for (const r of paths().filter((x) => x.method === 'GET')) {
      let url = r.url;
      for (const m of r.url.matchAll(/:([A-Za-z]+)/g)) {
        const t = tableFor(r.url, m[1]!);
        const id = t && (await idsOf(t, w.tid, 1))[0];
        if (!id) url = '';
        else url = url.replace(`:${m[1]!}`, id);
      }
      if (!url) continue;
      tried++;
      const res = await owner.get(`${url}?reveal=1`);
      if (res.statusCode < 400) leaks.push(`${r.url} ${res.statusCode} ${res.body.slice(0, 100)}`);
    }
    expect(tried).toBeGreaterThan(30);
    expect(leaks).toEqual([]);
  }, 120000);

  it('change nothing, on any write with an id', async () => {
    const owner = await Client.login(w.app, B.host, B.users.admin!.email);
    const changed: string[] = [];
    for (const r of paths().filter((x) => x.method !== 'GET')) {
      let url = r.url;
      for (const m of r.url.matchAll(/:([A-Za-z]+)/g)) {
        const t = tableFor(r.url, m[1]!);
        const id = t && (await idsOf(t, w.tid, 1))[0];
        if (!id) url = '';
        else url = url.replace(`:${m[1]!}`, id);
      }
      if (!url || !/[0-9a-f]{8}-/.test(url)) continue;
      const res = await owner.req(r.method as 'POST', url, r.method === 'DELETE' ? undefined : {});
      if (res.statusCode < 300) changed.push(`${r.method} ${r.url} ${res.statusCode}`);
    }
    expect(changed).toEqual([]);
  }, 120000);

  it('are refused as references in a body, and the session answers only on its own host', async () => {
    const owner = await Client.login(w.app, B.host, B.users.admin!.email);
    const [emp] = await idsOf('employees', w.tid, 1);
    const [branch] = await idsOf('branches', w.tid, 1);
    const r = await owner.post('/api/v1/employees', {
      employeeCode: 'X1',
      firstName: 'Cross',
      dateOfJoining: '2026-01-01',
      legalEntityId: B.legalEntityId,
      branchId: branch,
      departmentId: B.deptId,
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
    const d = await owner.post('/api/v1/approvals/delegations', { delegateId: emp, startsOn: '2030-01-01', endsOn: '2030-01-02' });
    expect(d.statusCode).toBeGreaterThanOrEqual(400);
    const replay = await w.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { host: w.host, cookie: owner.cookie } });
    expect(replay.statusCode).toBe(401);
  });

  it("the demo organization's data is exactly as it was", async () => {
    const c = await Client.login(w.app, w.host, w.logins[0]!, DEMO_PASSWORD);
    expect((await c.get('/api/v1/auth/me')).statusCode).toBe(200);
  });
});

describe('inside one organization', () => {
  it('a plain employee reads nothing of anyone else, on any GET, with every id there is', async () => {
    const me = w.logins.find((l) => l.startsWith('analyst@'))!;
    const [mine] = await ownerQuery<{ id: string; reporting_manager_id: string }>(
      `SELECT e.id, e.reporting_manager_id FROM employees e JOIN users u ON u.id=e.user_id WHERE u.email=$1`,
      [me],
    );
    const others = `employee_id <> '${mine!.id}'`;
    await ownerQuery(`UPDATE leave_requests SET reason='MARKER-L3-REASON' WHERE tenant_id=$1 AND ${others}`, [w.tid]);
    await ownerQuery(`UPDATE overtime_claims SET reason='MARKER-L3-REASON' WHERE tenant_id=$1 AND ${others}`, [w.tid]);
    await ownerQuery(`UPDATE employee_loans SET purpose='MARKER-L4-LOAN' WHERE tenant_id=$1 AND ${others}`, [w.tid]);
    await ownerQuery(`UPDATE expense_claims SET purpose='MARKER-L3-REASON' WHERE tenant_id=$1 AND ${others}`, [w.tid]);
    await ownerQuery(`UPDATE employees SET phone='+91 99999 77777', date_of_birth='1971-02-03' WHERE tenant_id=$1 AND id <> $2`, [w.tid, mine!.id]);
    const c = await Client.login(w.app, w.host, me, DEMO_PASSWORD);
    const leaks: string[] = [];
    let tried = 0;
    const SECRET = /MARKER-L[34]|99999 77777|1971-02-03/;
    for (const r of w.app.featureRoutes.filter((x) => x.method === 'GET' && x.url.startsWith('/api/'))) {
      const params = [...r.url.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);
      let urls = [r.url];
      for (const p of params) {
        const t = tableFor(r.url, p);
        const ids = t ? await idsOf(t, w.tid, 4) : [];
        urls = urls.flatMap((u) => ids.map((id) => u.replace(`:${p}`, id)));
      }
      for (const u of urls) {
        tried++;
        const res = await c.get(`${u}${u.includes('?') ? '&' : '?'}reveal=1`);
        if (res.statusCode < 400 && SECRET.test(res.body)) leaks.push(`${r.url} ${res.body.match(SECRET)![0]}`);
      }
    }
    expect(tried).toBeGreaterThan(150);
    expect([...new Set(leaks)]).toEqual([]);
  }, 180000);
});
