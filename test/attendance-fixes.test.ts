import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture } from './helpers.js';
import { addDays, localDate, weekday } from '../src/modules/attendance/time.js';

const TZ_OFFSET = '+05:30';
const today = () => localDate(new Date(), 'Asia/Kolkata');
function workday(ago: number) { let d = addDays(today(), -ago); while (weekday(d) === 0) d = addDays(d, -1); return d; }
const ist = (d: string, hm: string) => `${d}T${hm}:00${TZ_OFFSET}`;
let app: FastifyInstance; let T: TenantFixture; let emp: Client; let mgr: Client;

beforeAll(async () => {
  app = await makeApp();
  T = await createTenant();
  emp = await Client.login(app, T.host, T.users.employee!.email);
  mgr = await Client.login(app, T.host, T.users.manager!.email);
});
afterAll(async () => { await app.close(); });

const punch = (d: string, hm: string, direction: string, ref: string) => ownerQuery(`INSERT INTO attendance_events (tenant_id, employee_id, source, source_ref, event_time, direction, status)
  VALUES ($1,$2,'web',$3,$4,$5,'accepted')`, [T.id, T.users.employee!.employeeId, ref, ist(d, hm), direction]);

describe('F-8 regularization through approval', () => {
  it.each([
    ['in', 3, { requestedIn: '09:00' }, [['09:30', 'in'], ['18:00', 'out']]],
    ['out', 4, { requestedOut: '18:00' }, [['09:30', 'in'], ['13:00', 'out']]],
  ])('an approved corrected %s leaves the day present, not missing_punch', async (name, ago, req, originals) => {
    const d = workday(ago as number);
    for (const [hm, dir] of originals as string[][]) await punch(d, hm!, dir!, `${name}-${hm}`);
    const body: Record<string, string> = { workDate: d, reason: 'Device recorded the wrong time' };
    for (const [k, hm] of Object.entries(req as Record<string, string>)) body[k] = ist(d, hm);
    const r = await emp.post('/api/v1/attendance/regularizations', body);
    expect(r.statusCode, r.body).toBe(201);
    expect((await mgr.post(`/api/v1/approvals/${r.json().approvalRequestId}/act`, { action: 'approve' })).json().status).toBe('approved');
    const att = (await emp.get(`/api/v1/attendance/me?from=${d}&to=${d}`)).json();
    expect(att.days[0].status).toBe('present');
    expect(att.events.length).toBe((originals as string[][]).length + 1);   // originals are kept
  });
});
