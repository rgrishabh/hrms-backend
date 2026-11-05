import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../src/core/http/errors.js';
import { makeApp, problem } from './helpers.js';

const SECRET_SQL = `SELECT * FROM employee_salaries WHERE id = '1' at /srv/app/dist/src/db/tx.js:12`;

describe('RFC 7807', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeApp({ RATE_LIMIT_PER_MINUTE: '3000' });
    app.get('/api/v1/__boom', async () => { throw Object.assign(new Error(SECRET_SQL), { detail: 'Key (pan)=(ABCDE1234F)', where: SECRET_SQL }); });
    app.get('/api/v1/__dup', async () => { throw Object.assign(new Error('duplicate key value violates unique constraint "tenant_settings_uq"'), { code: '23505', constraint: 'tenant_settings_uq', detail: 'Key (tenant_id, key)=(1, x) already exists.' }); });
    app.get('/api/v1/__ext', async () => { throw new AppError(409, 'needs_confirm', 'Confirm first', { confirmable: true, status: 200, code: 'forged' }); });
    app.get('/api/v1/__list', async () => { throw new AppError(400, 'bad_request', 'Invalid', ['a message']); });
    app.post('/api/v1/__json', async () => ({ ok: true }));
    await app.ready();
  });
  afterAll(() => app.close());

  const leaks = (body: string) => { for (const s of [/SELECT/, /employee_salaries/, /\/srv\//, /\.js:\d+/, /ABCDE1234F/, /tenant_settings_uq/, /stack/]) expect(body).not.toMatch(s); };

  it('every member, on an address that does not exist', async () => {
    const r = await app.inject({ url: '/api/v1/nowhere?secret=1' });
    const p = problem(r);
    expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(p).toEqual({ type: 'urn:hrms:problem:not_found', title: 'Not found', status: 404, detail: 'Not found', instance: `urn:uuid:${p.instance.replace('urn:uuid:', '')}`, code: 'not_found', errors: [] });
    expect(p.instance).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
  });

  it('an unexpected failure says only a reference', async () => {
    const r = await app.inject({ url: '/api/v1/__boom' });
    const p = problem(r);
    expect([r.statusCode, p.code]).toEqual([500, 'internal']);
    expect(p.detail).toContain(p.instance.replace('urn:uuid:', ''));
    leaks(r.body);
  });

  it('a database rule is said in words: no constraint, key or value', async () => {
    const r = await app.inject({ url: '/api/v1/__dup' });
    expect([r.statusCode, problem(r).code]).toEqual([409, 'duplicate']);
    leaks(r.body);
  });

  it('a malformed body is not quoted back', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/__json', headers: { 'content-type': 'application/json' }, payload: '{"pan":"ABCDE1234F"' });
    expect([r.statusCode, problem(r).code]).toEqual([400, 'bad_request']);
    leaks(r.body);
  });

  it('a type nobody parses, and a body too large, keep their status', async () => {
    const t = await app.inject({ method: 'POST', url: '/api/v1/__json', headers: { 'content-type': 'text/x-nothing' }, payload: 'x' });
    expect([t.statusCode, problem(t).code]).toEqual([415, 'unsupported_media_type']);
    const big = await app.inject({ method: 'POST', url: '/api/v1/__json', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ a: 'x'.repeat(1024 * 1024 + 1) }) });
    expect([big.statusCode, problem(big).code]).toEqual([413, 'payload_too_large']);
  });

  it('object details become extension members, which cannot overwrite the standard ones', async () => {
    const p = problem(await app.inject({ url: '/api/v1/__ext' }));
    expect(p).toMatchObject({ status: 409, code: 'needs_confirm', confirmable: true });
    expect(p).not.toHaveProperty('details');
  });

  it('a plain list of messages becomes errors', async () => {
    expect(problem(await app.inject({ url: '/api/v1/__list' })).errors).toEqual([{ path: '', message: 'a message' }]);
  });

  it('rate limiting answers the same way, with its header', async () => {
    const small = await makeApp({ AUTH_RATE_LIMIT_PER_MINUTE: '1' });
    try {
      const login = () => small.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: { email: 'a@b.test', password: 'x' } });
      await login();
      const r = await login();
      expect([r.statusCode, problem(r).code]).toEqual([429, 'rate_limited']);
      expect(r.headers['retry-after']).toBeTruthy();
    } finally { await small.close(); }
  });
});
