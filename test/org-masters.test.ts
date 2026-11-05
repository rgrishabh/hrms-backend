import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, createTenant, makeApp, ownerQuery, problem, type TenantFixture } from './helpers.js';

let app: FastifyInstance;
let T: TenantFixture;
let hr: Client;
let emp: Client;
const base = (code: string, extra: Record<string, unknown> = {}) => ({
  employee: {
    employeeCode: code,
    firstName: 'New',
    lastName: code,
    legalEntityId: T.legalEntityId,
    branchId: T.branchId,
    departmentId: T.deptId,
    dateOfJoining: '2025-01-01',
    ...extra,
  },
});

beforeAll(async () => {
  app = await makeApp();
  T = await createTenant();
  hr = await Client.login(app, T.host, T.users.hr!.email);
  emp = await Client.login(app, T.host, T.users.employee!.email);
});
afterAll(async () => {
  await app.close();
});

describe('grades and designations', () => {
  it('with no masters, free text works as before', async () => {
    expect((await hr.post('/api/v1/employees', base('F1', { designation: 'Anything', grade: 'Z9' }))).statusCode).toBe(201);
  });

  it('CRUD under org.manage, audited old to new, listed in GET /org', async () => {
    expect((await emp.post('/api/v1/org/grades', { code: 'L1', name: 'Level 1' })).statusCode).toBe(403);
    const g = await hr.post('/api/v1/org/grades', { code: 'L1', name: 'Level 1' });
    expect(g.statusCode).toBe(201);
    const d = await hr.post('/api/v1/org/designations', { code: 'CHEM', name: 'Chemist' });
    expect(d.statusCode).toBe(201);
    expect((await hr.put(`/api/v1/org/designations/${d.json().id}`, { code: 'CHEM', name: 'Senior Chemist' })).statusCode).toBe(200);
    const org = (await hr.get('/api/v1/org')).json();
    expect(org.grades).toEqual([expect.objectContaining({ code: 'L1', name: 'Level 1', status: 'active' })]);
    expect(org.designations).toEqual([expect.objectContaining({ code: 'CHEM', name: 'Senior Chemist' })]);
    expect((await emp.get('/api/v1/org')).json().grades).toHaveLength(1); // the directory filters read these too
    const logs = await ownerQuery<{ action: string; change_metadata: Record<string, unknown> }>(
      `SELECT action, change_metadata FROM audit_logs WHERE tenant_id=$1 AND action='org.designations_updated'`,
      [T.id],
    );
    expect(logs[0]!.change_metadata).toMatchObject({ from: { name: 'Chemist' }, to: { name: 'Senior Chemist' } });
  });

  it('refuses a duplicate name or code', async () => {
    expect((await hr.post('/api/v1/org/grades', { code: 'L1', name: 'Another' })).statusCode).toBe(409);
    expect((await hr.post('/api/v1/org/grades', { code: 'L2', name: 'level 1' })).statusCode).toBe(409);
  });

  it('other organizations do not see them', async () => {
    const X = await createTenant();
    const c = await Client.login(app, X.host, X.users.hr!.email);
    expect((await c.get('/api/v1/org')).json().grades).toEqual([]);
  });

  it('once a master has entries, a new value must be in it, by name or code, in any case', async () => {
    const bad = await hr.post('/api/v1/employees', base('F2', { designation: 'Astronaut' }));
    expect(bad.statusCode).toBe(400);
    expect(problem(bad).detail).toMatch(/not an active designation/);
    expect((await hr.post('/api/v1/employees', base('F3', { designation: 'senior chemist', grade: 'l1' }))).statusCode).toBe(201);
  });

  it('what someone already holds stays valid when something else changes; changing it is checked', async () => {
    const [e] = await ownerQuery<{ id: string; version: number }>(`SELECT id, version FROM employees WHERE tenant_id=$1 AND employee_code='F1'`, [T.id]);
    const ok = await hr.patch(`/api/v1/employees/${e!.id}`, { expectedVersion: e!.version, changes: { lastName: 'Changed' } });
    expect(ok.statusCode).toBe(200);
    const no = await hr.patch(`/api/v1/employees/${e!.id}`, { expectedVersion: ok.json().version, changes: { grade: 'Z8' } });
    expect(no.statusCode).toBe(400);
  });

  it('an inactive entry cannot be newly chosen', async () => {
    const [g] = await ownerQuery<{ id: string }>(`SELECT id FROM grades WHERE tenant_id=$1 AND code='L1'`, [T.id]);
    await hr.put(`/api/v1/org/grades/${g!.id}`, { code: 'L1', name: 'Level 1', status: 'inactive' });
    expect((await hr.post('/api/v1/employees', base('F4', { grade: 'L1' }))).statusCode).toBe(400);
    await hr.put(`/api/v1/org/grades/${g!.id}`, { code: 'L1', name: 'Level 1', status: 'active' });
  });

  it('the import does not fail on a new title: it is added, reported and audited', async () => {
    const row = {
      employeeCode: 'IM1',
      firstName: 'Imp',
      lastName: 'Orted',
      branchCode: 'HQ',
      departmentCode: 'LAB',
      dateOfJoining: '2025-02-01',
      employmentType: 'permanent',
      status: 'active',
      designation: 'Field Sampler',
      grade: 'L1',
    };
    const dry = (await hr.post('/api/v1/employees/import', { rows: [row], dryRun: true })).json();
    expect(dry.committed).toBe(false);
    expect(dry.report[0].warnings).toEqual(["New designation 'Field Sampler' will be added to the list"]);
    expect((await hr.get('/api/v1/org')).json().designations).toHaveLength(1);
    const done = (await hr.post('/api/v1/employees/import', { rows: [row], dryRun: false })).json();
    expect(done.committed).toBe(true);
    expect((await hr.get('/api/v1/org')).json().designations.map((d: { name: string }) => d.name)).toEqual(['Field Sampler', 'Senior Chemist']);
    const [log] = await ownerQuery<{ change_metadata: { addedToLists: unknown } }>(
      `SELECT change_metadata FROM audit_logs WHERE tenant_id=$1 AND action='employee.bulk_imported'`,
      [T.id],
    );
    expect(log!.change_metadata.addedToLists).toEqual([{ list: 'designations', name: 'Field Sampler' }]);
  });
});
