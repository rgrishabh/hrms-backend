import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture } from './helpers.js';
import { QueryBool } from '../src/core/http/pagination.js';

describe('boolean query parameters', () => {
  it('parses words, not truthiness', () => {
    expect(QueryBool.parse('false')).toBe(false);
    expect(QueryBool.parse('0')).toBe(false);
    expect(QueryBool.parse('true')).toBe(true);
    expect(QueryBool.parse('1')).toBe(true);
    expect(QueryBool.safeParse('maybe').success).toBe(false);
  });
});

describe('at the routes', () => {
  let app: FastifyInstance;
  let T: TenantFixture;
  let hr: Client;
  let emp: Client;
  beforeAll(async () => {
    app = await makeApp();
    T = await createTenant();
    hr = await Client.login(app, T.host, T.users.hr!.email);
    emp = await Client.login(app, T.host, T.users.employee!.email);
  });
  afterAll(async () => {
    await app.close();
  });

  it('leave types: includeInactive=false hides inactive types', async () => {
    await ownerQuery(`INSERT INTO leave_types (tenant_id, code, name, status) VALUES ($1,'OLD','Old type','inactive')`, [T.id]);
    const codes = async (q: string) => (await hr.get(`/api/v1/leave/types?includeInactive=${q}`)).json().items.map((t: { code: string }) => t.code);
    expect(await codes('false')).not.toContain('OLD');
    expect(await codes('true')).toContain('OLD');
  });

  it('notifications: unread=false lists read ones too', async () => {
    await ownerQuery(`INSERT INTO notifications (tenant_id, user_id, kind, title, body, read_at) VALUES ($1,$2,'x','Read one','b',now())`, [T.id, T.users.employee!.id]);
    const r = await emp.get('/api/v1/notifications?unread=false');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().items.some((n: { title: string }) => n.title === 'Read one')).toBe(true);
  });

  it('attendance daily: exceptionsOnly=false keeps rows without exceptions', async () => {
    const date = '2026-01-05';
    await ownerQuery(`INSERT INTO attendance_daily (tenant_id, employee_id, work_date, day_type, status, calc_version) VALUES ($1,$2,$3,'working','present',3)`, [
      T.id,
      T.users.employee!.employeeId,
      date,
    ]);
    const r = await hr.get(`/api/v1/attendance/daily?date=${date}&exceptionsOnly=false`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().items.some((d: { employee_id: string }) => d.employee_id === T.users.employee!.employeeId)).toBe(true);
  });
});
