import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, createTenant, flags, makeApp, ownerQuery, type TenantFixture } from './helpers.js';

/** Overtime and field-duty reasons are L3: self, HR above them, and whoever decides the request while it waits (D39). */
const REASON = 'Private-reason-text';
let app: FastifyInstance;
let T: TenantFixture;
let hr: Client;
let hrPeer: Client;
let emp: Client;
let mgr: Client;
let other: Client;
let payroll: Client;
let hrEmpId: string;
let peerEmpId: string;
let delegateUser: string;

const insClaim = async (employeeId: string, day: string, status = 'pending') =>
  (
    await ownerQuery<{ id: string }>(
      `INSERT INTO overtime_claims (tenant_id, employee_id, work_date, minutes, recorded_minutes, payout, reason, status, created_by) VALUES ($1,$2,$3,60,60,'pay',$4,$5,$6) RETURNING id`,
      [T.id, employeeId, day, REASON, status, T.users.admin!.id],
    )
  )[0]!.id;
const insDuty = async (employeeId: string, day: string, status = 'pending') =>
  (
    await ownerQuery<{ id: string }>(
      `INSERT INTO field_duty_requests (tenant_id, employee_id, start_date, end_date, day_part, purpose, place, reason, status, created_by) VALUES ($1,$2,$3,$3,'full','field_sampling','Site',$4,$5,$6) RETURNING id`,
      [T.id, employeeId, day, REASON, status, T.users.admin!.id],
    )
  )[0]!.id;

beforeAll(async () => {
  app = await makeApp(flags('default,payroll,overtime,comp_off,field_duty'));
  T = await createTenant();
  hrEmpId = T.users.hr!.employeeId!;
  const [e] = await ownerQuery<{ id: string }>(
    `INSERT INTO employees (tenant_id, employee_code, first_name, legal_entity_id, branch_id, date_of_joining) VALUES ($1,'EP','Peer',$2,$3,'2024-01-01') RETURNING id`,
    [T.id, T.legalEntityId, T.branchId],
  );
  peerEmpId = e!.id;
  const [u] = await ownerQuery<{ id: string }>(
    `INSERT INTO users (tenant_id, email, display_name, password_hash) SELECT tenant_id, $2, 'HR peer', password_hash FROM users WHERE id=$1 RETURNING id`,
    [T.users.hr!.id, `hrpeer@${T.host}`],
  );
  delegateUser = u!.id;
  await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'hr_admin')`, [u!.id, T.id]);
  await ownerQuery(`UPDATE employees SET user_id=$1 WHERE id=$2`, [u!.id, peerEmpId]);
  await ownerQuery(`INSERT INTO tenant_settings (tenant_id, setting_key, setting_value) VALUES ($1,'attendance.overtime_enabled','true')`, [T.id]);
  hr = await Client.login(app, T.host, T.users.hr!.email);
  hrPeer = await Client.login(app, T.host, `hrpeer@${T.host}`);
  emp = await Client.login(app, T.host, T.users.employee!.email);
  mgr = await Client.login(app, T.host, T.users.manager!.email);
  other = await Client.login(app, T.host, T.users.other!.email);
  payroll = await Client.login(app, T.host, T.users.payroll!.email);
});
afterAll(async () => {
  await app.close();
});

const paths = [
  { name: 'overtime', list: '/api/v1/overtime/claims', one: (id: string) => `/api/v1/overtime/claims/${id}`, ins: insClaim, day: ['2026-02-02', '2026-02-03', '2026-02-04'] },
  {
    name: 'field duty',
    list: '/api/v1/field-duty/requests',
    one: (id: string) => `/api/v1/field-duty/requests/${id}`,
    ins: insDuty,
    day: ['2026-03-02', '2026-03-03', '2026-03-04'],
  },
];

describe.each(paths)('$name reasons', ({ list, one, ins, day }) => {
  const reasonOf = (body: { items: { id: string; reason: string | null }[] }, id: string) => body.items.find((x) => x.id === id);

  it('self and HR above them read it; a colleague reaches nothing', async () => {
    const id = await ins(T.users.employee!.employeeId!, day[0]!);
    expect((await emp.get(one(id))).json().reason).toBe(REASON);
    const byHr = await hr.get(one(id));
    expect(byHr.json().reason).toBe(REASON);
    expect(byHr.json().masked).toBeUndefined();
    expect(reasonOf((await hr.get(`${list}?scope=all`)).json(), id)!.reason).toBe(REASON);
    expect((await other.get(one(id))).statusCode).toBe(404);
  });

  it('HR at the same level or below gets the request with the reason masked, in the list and alone', async () => {
    const id = await ins(hrEmpId, day[1]!);
    const single = await hrPeer.get(one(id));
    expect(single.statusCode).toBe(200);
    expect(single.body.includes(REASON)).toBe(false);
    expect(single.json().reason).toBeNull();
    expect(single.json().maskedFields).toEqual(['reason']);
    const rows = await hrPeer.get(`${list}?scope=all&pageSize=100`);
    expect(reasonOf(rows.json(), id)!.reason).toBeNull();
    expect(rows.body.includes(REASON)).toBe(true); // Others in the list are below them: this is about this row.
    expect((await hr.get(one(id))).json().reason).toBe(REASON); // their own
  });

  it('readers who are not HR see the request and not the reason', async () => {
    const id = await ins(peerEmpId, day[2]!);
    const r = await payroll.get(one(id));
    expect(r.statusCode).toBe(200);
    expect(r.body.includes(REASON)).toBe(false);
    expect((await payroll.get(`${list}?scope=all&pageSize=100`)).body.includes(REASON)).toBe(false);
  });

  it('the manager reads it while it waits for their decision, and not after', async () => {
    const id = await ins(T.users.employee!.employeeId!, '2026-04-06');
    expect(reasonOf((await mgr.get(`${list}?scope=team`)).json(), id)!.reason).toBe(REASON);
    expect((await mgr.get(one(id))).json().reason).toBe(REASON);
    await ownerQuery(`UPDATE ${list.includes('overtime') ? 'overtime_claims' : 'field_duty_requests'} SET status='approved' WHERE id=$1`, [id]);
    const after = await mgr.get(one(id));
    expect(after.statusCode).toBe(200);
    expect(after.json().reason).toBeNull();
    expect(reasonOf((await mgr.get(`${list}?scope=team`)).json(), id)!.reason).toBeNull();
  });

  it('a delegate holding the step reads it while it is pending', async () => {
    const id = await ins(hrEmpId, '2026-04-07');
    const [req] = await ownerQuery<{ id: string }>(
      `INSERT INTO approval_requests (tenant_id, entity_type, entity_id, requester_id, summary) VALUES ($1,$2,$3,$4,'x') RETURNING id`,
      [T.id, list.includes('overtime') ? 'overtime_claim' : 'field_duty', id, T.users.admin!.id],
    );
    await ownerQuery(`INSERT INTO approval_steps (tenant_id, request_id, step_index, approver_kind, approver_user_id, status) VALUES ($1,$2,0,'user',$3,'active')`, [
      T.id,
      req!.id,
      delegateUser,
    ]);
    expect((await hrPeer.get(one(id))).json().reason).toBe(REASON);
  });
});
