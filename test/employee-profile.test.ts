import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, createTenant, Client, ownerQuery, type TenantFixture, flags } from './helpers.js';

let app: FastifyInstance; let T: TenantFixture;
let hr: Client; let emp: Client; let mgr: Client; let other: Client; let pay: Client;
let empId: string; let hrId: string;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const yearsAgo = (n: number) => `${Number(today.slice(0, 4)) - n}${today.slice(4)}`;

const profile = (c: Client, id = empId) => c.get(`/api/v1/employees/${id}/profile`);
const put = (c: Client, section: string, items: unknown[], id = empId) => c.put(`/api/v1/employees/${id}/profile/${section}`, { items });
const approve = async (c: Client, entityId: string) => {
  const item = (await c.get('/api/v1/approvals/inbox')).json().items.find((x: { entity_id: string }) => x.entity_id === entityId);
  expect(item, 'visible to approver').toBeTruthy();
  const r = await c.post(`/api/v1/approvals/${item.id}/act`, { action: 'approve' });
  expect(r.statusCode, r.body).toBe(200);
};

const ADDRESSES = [
  { kind: 'current', line1: 'Flat 4B, Sai Residency', line2: 'Baner Road', city: 'Pune', state: 'Maharashtra', postalCode: '411045' },
  { kind: 'permanent', line1: '12 Gandhi Nagar', city: 'Nashik', state: 'Maharashtra', postalCode: '422001' },
];

beforeAll(async () => {
  app = await makeApp({ ...flags('default,payroll,payroll.statutory') });
  T = await createTenant();
  hr = await Client.login(app, T.host, T.users.hr!.email);
  emp = await Client.login(app, T.host, T.users.employee!.email);
  mgr = await Client.login(app, T.host, T.users.manager!.email);
  other = await Client.login(app, T.host, T.users.other!.email);
  pay = await Client.login(app, T.host, T.users.payroll!.email);
  empId = T.users.employee!.employeeId!;
  hrId = T.users.hr!.employeeId!;
});
afterAll(async () => { await app.close(); });

describe('employee personal details', () => {
  it('starts empty, says what is missing, and is private to the employee and full employee readers', async () => {
    const r = (await profile(emp)).json();
    expect(r.sections).toEqual({ contacts: [], addresses: [], nominees: [], education: [], experience: [] });
    expect(r.missing).toEqual(['An emergency contact', 'Current address', 'Permanent address', 'A provident fund nominee']);
    expect(r.edit).toMatchObject({ contacts: 'direct', addresses: 'direct', nominees: 'approval', education: 'approval', experience: 'approval' });
    expect((await profile(hr)).json().edit.nominees).toBe('direct');
    expect((await profile(pay)).statusCode).toBe(404);                 // personal details (L3) are the employee's and HR's, not payroll's
    expect((await profile(other)).statusCode).toBe(404);               // a colleague
    expect((await profile(mgr)).statusCode).toBe(404);                 // the manager does not see personal details
  });

  it('the employee updates contacts and addresses directly; HR is not asked', async () => {
    expect((await put(emp, 'contacts', [{ name: 'Meera Kulkarni', relationship: 'Spouse', phone: '+91 98220 12345' }, { name: 'R. Kulkarni', relationship: 'Father', phone: '9822012346', altPhone: '' }])).json()).toEqual({ applied: true });
    expect((await put(emp, 'addresses', ADDRESSES)).json()).toEqual({ applied: true });
    const r = (await profile(emp)).json();
    expect(r.sections.contacts.map((c: { name: string }) => c.name)).toEqual(['Meera Kulkarni', 'R. Kulkarni']);   // order = who to call first
    expect(r.sections.addresses).toHaveLength(2);
    expect(r.missing).toEqual(['A provident fund nominee']);
    expect((await hr.get('/api/v1/approvals/inbox')).json().items.some((x: { entity_type: string }) => x.entity_type === 'employee_profile_change')).toBe(false);
    const [log] = await ownerQuery<{ change_metadata: Record<string, unknown> }>(`SELECT change_metadata FROM audit_logs WHERE tenant_id=$1 AND action='employee.profile_updated' AND target_id=$2 ORDER BY created_at LIMIT 1`, [T.id, empId]);
    expect(JSON.stringify(log)).not.toMatch(/Meera|98220/);              // the audit log keeps counts, not contents
  });

  it('rejects invalid entries with a clear reason', async () => {
    expect((await put(emp, 'addresses', [{ ...ADDRESSES[0], postalCode: '41104' }])).json().error.details).toEqual([{ path: '0.postalCode', message: 'Enter a 6-digit PIN code' }]);
    expect((await put(emp, 'addresses', [ADDRESSES[0], ADDRESSES[0]])).json().error.message).toMatch(/once/);
    expect((await put(emp, 'contacts', Array(6).fill({ name: 'Someone', relationship: 'Friend', phone: '9822012345' }))).statusCode).toBe(400);
    expect((await put(other, 'contacts', [], empId)).statusCode).toBe(404);   // not someone else's
  });

  it('nominee changes by the employee wait for HR approval, which checks shares and minors', async () => {
    const minor = { purpose: 'pf', name: 'Aarav Kulkarni', relationship: 'Son', dateOfBirth: yearsAgo(8), sharePercent: 40 };
    const spouse = { purpose: 'pf', name: 'Meera Kulkarni', relationship: 'Spouse', dateOfBirth: yearsAgo(34), sharePercent: 60 };
    expect((await put(emp, 'nominees', [spouse, { ...minor, sharePercent: 30, guardianName: 'Meera Kulkarni' }])).json().error.message).toMatch(/add up to 90%/);
    expect((await put(emp, 'nominees', [spouse, minor])).json().error.message).toMatch(/minor: name a guardian/);
    const r = await put(emp, 'nominees', [spouse, { ...minor, guardianName: 'Meera Kulkarni' }]);
    expect(r.statusCode, r.body).toBe(202);
    const { changeId } = r.json();
    expect((await put(emp, 'nominees', [{ ...spouse, sharePercent: 100 }])).statusCode).toBe(409);   // one pending change per section

    const p = (await profile(emp)).json();
    expect(p.sections.nominees).toEqual([]);                                 // not applied yet
    expect(p.pending).toEqual([expect.objectContaining({ id: changeId, section: 'nominees' })]);
    const c = (await hr.get(`/api/v1/employees/profile-changes/${changeId}`)).json();
    expect(c).toMatchObject({ section: 'nominees', status: 'pending', current: [] });
    expect(c.items).toHaveLength(2);

    await approve(hr, changeId);
    const after = (await profile(emp)).json();
    expect(after.sections.nominees.map((x: { name: string; sharePercent: number }) => [x.name, x.sharePercent])).toEqual([['Meera Kulkarni', 60], ['Aarav Kulkarni', 40]]);
    expect(after.pending).toEqual([]);
    expect(after.missing).toEqual([]);
  });

  it('the employee can withdraw a pending change; HR never approves their own', async () => {
    const r = await put(emp, 'education', [{ level: 'postgraduate', qualification: 'M.Sc. Analytical Chemistry', institution: 'Fergusson College', university: 'Savitribai Phule Pune University', yearOfPassing: 2019, score: '8.1 CGPA' }]);
    expect(r.statusCode).toBe(202);
    expect((await other.post(`/api/v1/employees/profile-changes/${r.json().changeId}/withdraw`)).statusCode).toBe(404);
    expect((await emp.post(`/api/v1/employees/profile-changes/${r.json().changeId}/withdraw`)).json()).toEqual({ ok: true });
    expect((await profile(emp)).json().pending).toEqual([]);

    // HR changing their own nominees goes through approval too, and they cannot act on it.
    const own = await put(hr, 'nominees', [{ purpose: 'gratuity', name: 'Someone Close', relationship: 'Sister', sharePercent: 100 }], hrId);
    expect(own.statusCode, own.body).toBe(202);
    expect((await hr.get('/api/v1/approvals/inbox')).json().items.some((x: { entity_id: string }) => x.entity_id === own.json().changeId)).toBe(false);
  });

  it('HR edits directly; previous employment must end by the date of joining', async () => {
    expect((await put(hr, 'experience', [{ employer: 'Acme Labs', designation: 'Chemist', fromDate: '2021-06-01', toDate: '2024-02-15' }])).json().error.message).toMatch(/by the date of joining/);
    expect((await put(hr, 'experience', [{ employer: 'Acme Labs', designation: 'Chemist', fromDate: '2021-06-01', toDate: '2023-12-31', reasonForLeaving: 'Relocation' }])).json()).toEqual({ applied: true });
    expect((await profile(emp)).json().sections.experience).toEqual([expect.objectContaining({ employer: 'Acme Labs', toDate: '2023-12-31' })]);
    expect((await put(mgr, 'experience', [], empId)).statusCode).toBe(404);
  });

  it('HR sees who is missing details and what awaits approval', async () => {
    expect((await emp.get('/api/v1/reports/missing_personal_details')).statusCode).toBe(403);
    const r = (await hr.get('/api/v1/reports/missing_personal_details')).json();
    const by = Object.fromEntries(r.rows.map((x: { employee_code: string }) => [x.employee_code, x]));
    expect(by.E2).toBeUndefined();                                           // the employee above is complete
    expect(by.E3).toMatchObject({ missing: 'Emergency contact, Current address, Permanent address, PF nominee', awaiting: null });
    expect(by.E4).toMatchObject({ awaiting: 'Nominees' });                   // HR's own change, waiting for someone else
  });
});
