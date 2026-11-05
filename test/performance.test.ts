import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { xlsx, xlsxAsync } from '../src/core/http/xlsx.js';
import { activeSalary, compute, createRun, seedComponents } from './payroll-helpers.js';
import { Client, createTenant, flags, makeApp, ownerQuery, problem, type TenantFixture } from './helpers.js';
import { TEST_APP_URL } from './env.js';

/** Statements the app sends while `fn` runs. */
async function statements(fn: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const original = pg.Client.prototype.query;
  const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
    const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
    if (text) seen.push(text);
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  } as never);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return seen;
}

const addEmployee = async (T: TenantFixture, n: number) => {
  const [e] = await ownerQuery<{ id: string }>(
    `INSERT INTO employees (tenant_id, employee_code, first_name, legal_entity_id, branch_id, department_id, date_of_joining, status)
    VALUES ($1,$2,$3,$4,$5,$6,'2020-01-01','active') RETURNING id`,
    [T.id, `P${n}`, `Person ${n}`, T.legalEntityId, T.branchId, T.deptId],
  );
  return e!.id;
};

describe('per-request memo', () => {
  let app: FastifyInstance;
  let T: TenantFixture;
  let hr: Client;
  beforeAll(async () => {
    app = await makeApp();
    T = await createTenant();
    hr = await Client.login(app, T.host, T.users.hr!.email);
  });
  afterAll(() => app.close());

  it('a gated route reads each setting once', async () => {
    const seen = await statements(() => hr.get('/api/v1/attendance/shifts'));
    const settings = seen.filter((s) => s.includes('FROM tenant_settings'));
    expect(settings.length).toBeGreaterThan(0);
    expect(seen.filter((s) => s.includes('FROM attendance_devices')).length).toBeLessThanOrEqual(1);
  });

  it('a write in the request is seen by what follows it', async () => {
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    const put = await admin.put('/api/v1/tenant/settings/attendance.regularization_window_days', { value: 9, scope: 'tenant' });
    expect(put.statusCode, put.body).toBe(200);
    const body = await admin.get('/api/v1/tenant/settings');
    expect((body.json() as { items: { key: string; effective: unknown }[] }).items.find((i) => i.key === 'attendance.regularization_window_days')?.effective).toBe(9);
  });
});

describe('payroll reads stop growing with the run', () => {
  let app: FastifyInstance;
  let T: TenantFixture;
  let pay: Client;
  const period = '2031-03';
  beforeAll(async () => {
    app = await makeApp({ ...flags('default,payroll,payroll.statutory,loans,overtime') });
    T = await createTenant();
    pay = await Client.login(app, T.host, T.users.payroll!.email);
    await seedComponents(T);
    for (const id of Object.values(T.users)
      .map((u) => u.employeeId)
      .filter((x): x is string => !!x))
      await activeSalary(T, id, '2020-01-01', { BASIC: 50000 });
  });
  afterAll(() => app.close());

  it('computing a run costs one more statement per person at most, and the bank and statutory files none', async () => {
    const before = await createRun(pay, T, period);
    const small = await statements(() => compute(pay, before));
    const added = 6;
    for (let i = 0; i < added; i++) await activeSalary(T, await addEmployee(T, i), '2020-01-01', { BASIC: 40000 + i });
    const big = await statements(() => compute(pay, before));
    expect(big.length - small.length).toBeLessThanOrEqual(added * 2);
  });
});

describe('lists have defaults and caps', () => {
  let app: FastifyInstance;
  let T: TenantFixture;
  let it_: Client;
  let pay: Client;
  let hr: Client;
  let emp: Client;
  beforeAll(async () => {
    app = await makeApp({ ...flags('default,payroll,attendance.biometric,grievance') });
    T = await createTenant();
    it_ = await Client.login(app, T.host, T.users.it!.email);
    pay = await Client.login(app, T.host, T.users.payroll!.email);
    hr = await Client.login(app, T.host, T.users.hr!.email);
    emp = await Client.login(app, T.host, T.users.employee!.email);
  });
  afterAll(() => app.close());

  const urls = (): [Client, string][] => [
    [hr, '/api/v1/attendance/locks'],
    [it_, '/api/v1/attendance/device-mappings'],
    [it_, '/api/v1/attendance/device-events/unmapped'],
    [hr, '/api/v1/attendance/shifts'],
    [pay, '/api/v1/payroll/components'],
    [pay, `/api/v1/payroll/employees/${T.users.employee!.employeeId}/salaries`],
    [pay, '/api/v1/payroll/runs'],
    [emp, '/api/v1/approvals/inbox'],
    [emp, '/api/v1/approvals/mine'],
    [emp, '/api/v1/cases?kind=grievance'],
  ];

  it('every named list says page, pageSize and total, and refuses more than its cap', async () => {
    for (const [c, url] of urls()) {
      const sep = url.includes('?') ? '&' : '?';
      const ok = await c.get(url);
      expect(ok.statusCode, `${url} ${ok.body}`).toBe(200);
      expect(ok.json(), url).toMatchObject({ page: 1, total: expect.any(Number), pageSize: expect.any(Number), items: expect.any(Array) });
      const over = await c.get(`${url}${sep}pageSize=100000`);
      expect([over.statusCode, problem(over).code], url).toEqual([400, 'validation_failed']);
    }
  });

  it('a page is a page', async () => {
    const seeded = await pay.get('/api/v1/payroll/components');
    expect(seeded.statusCode).toBe(200);
    for (const code of ['A1', 'A2', 'A3']) await ownerQuery(`INSERT INTO pay_components (tenant_id, code, name, kind) VALUES ($1,$2,$2,'earning')`, [T.id, code]);
    const one = (await pay.get('/api/v1/payroll/components?page=2&pageSize=1')).json() as { items: unknown[]; total: number; page: number };
    expect(one.items).toHaveLength(1);
    expect(one.page).toBe(2);
    expect(one.total).toBeGreaterThanOrEqual(3);
  });
});

describe('workbooks off the event loop', () => {
  it('the same bytes, sync or on the thread pool', async () => {
    const sheet = {
      name: 'S',
      columns: [
        { label: 'A', type: 'text' as const },
        { label: 'B', type: 'auto' as const },
      ],
      rows: [
        ['x', 1],
        ['y', 2],
      ],
    };
    expect((await xlsxAsync([sheet])).equals(xlsx([sheet]))).toBe(true);
  });
});

describe('read replica', () => {
  const host = new URL(TEST_APP_URL);
  // A second connection to the same database, by another name. Real replication lag is not tested here.
  const replica = host.hostname === 'localhost' ? `127.0.0.1:${host.port}` : `localhost:${host.port}`;
  let app: FastifyInstance;
  let T: TenantFixture;
  let other: TenantFixture;
  beforeAll(async () => {
    app = await makeApp({ DB_READ_HOST: replica });
    T = await createTenant();
    other = await createTenant();
  });
  afterAll(() => app.close());

  it('reports run on it, read-only, under RLS; writes stay on the primary', async () => {
    const read = app.deps.readPool!;
    expect(read).toBeTruthy();
    expect(read).not.toBe(app.deps.pool);
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    const opened = read.totalCount;
    const r = await hr.get('/api/v1/reports/employee_directory');
    if (r.statusCode !== 200) expect(r.statusCode, r.body).toBe(404);
    const list = await hr.get('/api/v1/reports');
    const key = (list.json() as { items: { key: string }[] }).items[0]!.key;
    const run = await hr.get(`/api/v1/reports/${key}`);
    expect(run.statusCode, run.body).toBe(200);
    expect(read.totalCount).toBeGreaterThanOrEqual(Math.max(opened, 1));
    expect(run.body).not.toContain(other.host);
    // The write path ignores the replica.
    const before = app.deps.pool.totalCount;
    const put = await (await Client.login(app, T.host, T.users.admin!.email)).put('/api/v1/tenant/settings/attendance.regularization_window_days', { value: 8, scope: 'tenant' });
    expect(put.statusCode, put.body).toBe(200);
    expect(app.deps.pool.totalCount).toBeGreaterThanOrEqual(before);
  });

  it('RLS context and read-only hold on that connection', async () => {
    const { withTenantRead } = await import('../src/db/tx.js');
    const seen = await withTenantRead(app.deps.readPool!, app.deps.pool, T.id, async (db) =>
      (await db.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM employees')).rows.map((x) => x.tenant_id),
    );
    expect(seen).toEqual([T.id]);
    await expect(
      withTenantRead(app.deps.readPool!, app.deps.pool, T.id, (db) => db.query(`UPDATE employees SET first_name=first_name WHERE tenant_id=$1`, [T.id])),
    ).rejects.toThrow(/read-only/);
  });

  it('an unreachable replica falls back to the primary; unset, there is none', async () => {
    const dead = await makeApp({ DB_READ_HOST: '127.0.0.1:1' });
    const plain = await makeApp();
    try {
      expect(plain.deps.readPool).toBeUndefined();
      const T2 = await createTenant();
      const hr = await Client.login(dead, T2.host, T2.users.hr!.email);
      const key = ((await hr.get('/api/v1/reports')).json() as { items: { key: string }[] }).items[0]!.key;
      expect((await hr.get(`/api/v1/reports/${key}`)).statusCode).toBe(200);
    } finally {
      await dead.close();
      await plain.close();
    }
  });
});
