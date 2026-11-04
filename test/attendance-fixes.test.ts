import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture } from './helpers.js';
import pg from 'pg';
import { addDays, localDate, weekday } from '../src/modules/attendance/time.js';
import { recalcForEvent, recordEvent } from '../src/modules/attendance/service.js';
import { TEST_OWNER_URL } from './env.js';
import type { Db } from '../src/db/tx.js';

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

describe('a punch before midnight for a shift starting after midnight (AUDIT 4.2)', () => {
  it('recalculates the work date it belongs to, and only when it belongs there', async () => {
    const [late] = await ownerQuery<{ id: string }>(`INSERT INTO shifts (tenant_id, code, name, start_time, end_time, half_day_min_minutes, full_day_min_minutes) VALUES ($1,'LATE','Late','00:30','08:30',240,450) RETURNING id`, [T.id]);
    const e = T.users.other!.employeeId!;
    await ownerQuery(`UPDATE shift_assignments SET shift_id=$2 WHERE employee_id=$1`, [e, late!.id]);
    const c = new pg.Client({ connectionString: TEST_OWNER_URL });
    await c.connect();
    await c.query(`SELECT set_config('app.platform_bypass','on',false)`);
    const db = c as unknown as Db;
    const before = new Date(ist('2026-03-09', '23:50'));
    await recordEvent(db, T.id, { employeeId: e, source: 'web', sourceRef: 'late-1', eventTime: before, direction: 'in' });
    await recalcForEvent(db, T.id, e, before);
    const rows = await ownerQuery<{ punch_count: number }>(`SELECT punch_count FROM attendance_daily WHERE employee_id=$1 AND work_date='2026-03-10'`, [e]);
    expect(rows[0]?.punch_count).toBe(1);
    // An evening punch of the general shift says nothing about tomorrow: no row appears for it.
    const g = T.users.employee!.employeeId!;
    const evening = new Date(ist('2026-03-16', '18:00'));
    await recordEvent(db, T.id, { employeeId: g, source: 'web', sourceRef: 'gen-1', eventTime: evening, direction: 'out' });
    await recalcForEvent(db, T.id, g, evening);
    expect(await ownerQuery(`SELECT 1 FROM attendance_daily WHERE employee_id=$1 AND work_date='2026-03-17'`, [g])).toHaveLength(0);
    await c.end();
  });
});
