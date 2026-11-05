import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { problem, makeApp, createTenant, Client, ownerQuery, multipart, flags, type TenantFixture } from './helpers.js';
import { TINY_PNG } from './images.js';
import { getStore } from '../src/core/storage/index.js';

const PNG = TINY_PNG;
const upload = (c: Client, content: Buffer, name = 'me.png') => {
  const m = multipart({}, { name, content });
  return c.req('POST', '/api/v1/attendance/selfies', m.body, m.headers);
};
const punch = (c: Client, key: string, extra: object = {}) => c.post('/api/v1/attendance/punch', { channel: 'web', direction: 'in', idempotencyKey: key, ...extra });

describe('check-in selfie', () => {
  let app: FastifyInstance; let T: TenantFixture; let emp: Client; let hr: Client; let other: Client;
  beforeAll(async () => {
    app = await makeApp({ ...flags('default,attendance.selfie'), STORAGE_DRIVER: 'local', STORAGE_PATH: mkdtempSync(path.join(os.tmpdir(), 'hrms-selfie-')) });
    T = await createTenant();
    emp = await Client.login(app, T.host, T.users.employee!.email);
    hr = await Client.login(app, T.host, T.users.hr!.email);
    other = await Client.login(app, T.host, T.users.other!.email);
  });
  afterAll(async () => { await app.close(); });

  it('clock-in needs a selfie, stored through the store as L3 with a retention date', async () => {
    const r = await punch(emp, 'selfie-none-1');
    expect([r.statusCode, problem(r).code]).toEqual([400, 'selfie_required']);
    const up = await upload(emp, PNG);
    expect(up.statusCode).toBe(201);
    const id = up.json().id as string;
    const ok = await punch(emp, 'selfie-yes-11', { selfieId: id });
    expect(ok.statusCode).toBe(200);
    const [row] = await ownerQuery<{ data_class: string; event_id: string; storage_key: string; days: number }>(
      `SELECT data_class, event_id, storage_key, round(extract(epoch FROM retain_until - created_at) / 86400)::int AS days FROM attendance_selfies WHERE id=$1`, [id]);
    expect(row).toMatchObject({ data_class: 'L3', event_id: ok.json().id, days: 90 });
    expect(row!.storage_key).toMatch(new RegExp(`^${T.id}/selfies/${T.users.employee!.employeeId}/`));
    expect(await getStore()!.get(row!.storage_key)).toEqual(PNG);
  });

  it('only images, and one use each; someone else\'s selfie is refused', async () => {
    expect((await upload(emp, Buffer.from('%PDF-1.7 hello'), 'x.pdf')).statusCode).toBe(415);
    const id = (await upload(other, PNG)).json().id as string;
    const r = await punch(emp, 'selfie-steal-1', { selfieId: id, direction: 'in' });
    expect(r.statusCode).toBe(400);
  });

  it('the employee and HR can see it, a colleague cannot, and HR looking is audited', async () => {
    const [{ id }] = (await ownerQuery<{ id: string }>(`SELECT id FROM attendance_selfies WHERE tenant_id=$1 AND event_id IS NOT NULL`, [T.id])) as [{ id: string }];
    const mine = await emp.get(`/api/v1/attendance/selfies/${id}`);
    expect([mine.statusCode, mine.headers['cache-control']]).toEqual([200, 'private, no-store']);
    expect((await other.get(`/api/v1/attendance/selfies/${id}`)).statusCode).toBe(404);
    expect((await hr.get(`/api/v1/attendance/selfies/${id}`)).statusCode).toBe(200);
    expect(await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='attendance.selfie_viewed'`, [T.id])).toHaveLength(1);
  });

  it('retention erases the blob and the key, and the row says when', async () => {
    const [row] = await ownerQuery<{ id: string; storage_key: string }>(`SELECT id, storage_key FROM attendance_selfies WHERE tenant_id=$1 AND event_id IS NOT NULL`, [T.id]);
    await ownerQuery(`UPDATE attendance_selfies SET retain_until=now() - interval '1 minute' WHERE id=$1`, [row!.id]);
    const run = await hr.runJob('attendance.selfie_retention');
    expect(run.json().status).toBe('succeeded');
    await expect(getStore()!.get(row!.storage_key)).rejects.toThrow();
    const [after] = await ownerQuery<{ storage_key: string | null; erased_at: Date | null }>('SELECT storage_key, erased_at FROM attendance_selfies WHERE id=$1', [row!.id]);
    expect(after!.storage_key).toBeNull();
    expect(after!.erased_at).not.toBeNull();
    expect((await emp.get(`/api/v1/attendance/selfies/${row!.id}`)).statusCode).toBe(404);
  });
});

describe('selfie on without storage', () => {
  it('answers feature_not_configured and does not stop people clocking in', async () => {
    const app = await makeApp({ ...flags('default,attendance.selfie') });
    const T = await createTenant();
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    const r = await upload(emp, PNG);
    expect([r.statusCode, problem(r).code]).toEqual([409, 'feature_not_configured']);
    expect((await punch(emp, 'selfie-nostore1')).statusCode).toBe(200);
    await app.close();
  });
});

describe('geofence', () => {
  let app: FastifyInstance; let T: TenantFixture; let emp: Client; let admin: Client;
  const at = (lat: number, key: string) => emp.post('/api/v1/attendance/punch', { channel: 'mobile', direction: 'in', idempotencyKey: key, latitude: lat, longitude: 72.8 });
  beforeAll(async () => {
    app = await makeApp({ ...flags('default,attendance.mobile,attendance.geofence') });
    T = await createTenant();
    emp = await Client.login(app, T.host, T.users.employee!.email);
    admin = await Client.login(app, T.host, T.users.hr!.email);
    await admin.put('/api/v1/tenant/settings/attendance.mobile_location_mode', { value: 'optional' });
    expect((await admin.put(`/api/v1/attendance/geofences/${T.branchId}`, { latitude: 19, longitude: 72.8, radiusMeters: 500 })).statusCode).toBe(200);
  });
  afterAll(async () => { await app.close(); });

  it('flags a clock-in outside the fence, or refuses it when the organization says so', async () => {
    const inside = await at(19.001, 'geo-inside-1');
    expect(inside.json().outsideGeofence).toBe(false);
    const outside = await at(19.1, 'geo-outside-1');
    expect(outside.json().outsideGeofence).toBe(true);
    expect((await ownerQuery<{ outside_geofence: boolean }>('SELECT outside_geofence FROM attendance_events WHERE id=$1', [outside.json().id]))[0]!.outside_geofence).toBe(true);
    await admin.put('/api/v1/tenant/settings/attendance.geofence_enforce', { value: true });
    const refused = await at(19.1, 'geo-outside-2');
    expect([refused.statusCode, problem(refused).code]).toEqual([403, 'outside_geofence']);
  });
});

describe('location is off with the flag', () => {
  it('a location sent anyway is not stored, whatever the setting says', async () => {
    const app = await makeApp({ ...flags('default,attendance.mobile') });
    const T = await createTenant();
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    const r = await emp.post('/api/v1/attendance/punch', { channel: 'mobile', direction: 'in', idempotencyKey: 'geo-off-0001', latitude: 19, longitude: 72 });
    expect(r.statusCode).toBe(200);
    const [row] = await ownerQuery<{ latitude: string | null }>('SELECT latitude FROM attendance_events WHERE id=$1', [r.json().id]);
    expect(row!.latitude).toBeNull();
    expect((await emp.get('/api/v1/attendance/me/today')).json().locationMode).toBe('off');
    await app.close();
  });
});
