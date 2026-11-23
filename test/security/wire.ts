import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Client, createTenant, makeApp, ownerQuery, PASSWORD, type TenantFixture } from '../helpers.js';
import { FEATURES } from '../../src/core/features/registry.js';

/** Every switch that exists, for a suite that attacks the whole product. */
export const ALL_ON: Record<string, string> = Object.fromEntries(FEATURES.filter((d) => d.envName && d.availability !== 'planned').map((d) => [d.envName!, 'true']));

export interface WireResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  rawPayload: Buffer;
  json: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any -- answers vary per route; each test reads what it expects.
}

/** One request over a real socket. `path` goes on the wire exactly as given, so a traversal or an encoded path is not tidied up by a URL parser. */
export function send(port: number, method: string, path: string, headers: Record<string, string | number> = {}, payload?: Buffer | string): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const rawPayload = Buffer.concat(chunks);
        const body = rawPayload.toString('utf8');
        resolve({ statusCode: res.statusCode!, headers: res.headers, body, rawPayload, json: () => JSON.parse(body) });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** The test `Client` with the injection swapped for HTTP: helpers written for `Client` work, and the bytes really cross a socket. */
export class WireClient extends Client {
  private port: number;
  constructor(app: FastifyInstance, host: string) {
    super(app, host);
    this.port = (app.server.address() as AddressInfo).port;
  }
  static async signIn(app: FastifyInstance, host: string, email: string, password = PASSWORD): Promise<WireClient> {
    const c = new WireClient(app, host);
    const r = await c.req('POST', '/api/v1/auth/login', { email, password });
    if (r.statusCode !== 200) throw new Error(`login failed for ${email}: ${r.statusCode} ${r.body}`);
    return c;
  }
  override async req(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const isBytes = Buffer.isBuffer(payload);
    const hasBody = payload !== undefined;
    const data = !hasBody ? undefined : isBytes ? payload : typeof payload === 'string' ? payload : JSON.stringify(payload);
    const r = await send(
      this.port,
      method,
      url,
      {
        host: this.host,
        ...(this.cookie || this.device ? { cookie: [this.cookie, this.device].filter(Boolean).join('; ') } : {}),
        ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
        ...(hasBody && !isBytes ? { 'content-type': 'application/json' } : {}),
        ...(data !== undefined ? { 'content-length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
      data,
    );
    for (const sc of [r.headers['set-cookie'] ?? []].flat()) {
      if (sc.startsWith('hrms_sid=')) this.cookie = sc.split(';')[0]!;
      if (sc.startsWith('hrms_did=')) this.device = sc.split(';')[0]!;
    }
    const isJson = String(r.headers['content-type']).includes('json');
    if (r.statusCode < 300 && isJson && r.body && (r.json() as { csrfToken?: string }).csrfToken) this.csrf = r.json().csrfToken;
    return r as unknown as LightMyRequestResponse;
  }
}

/** An app listening on a real port, with every module on unless the test says otherwise. */
export async function serve(overrides: Record<string, string> = {}, opts: Parameters<typeof makeApp>[1] = {}): Promise<{ app: FastifyInstance; port: number }> {
  const app = await makeApp({ ...ALL_ON, ...overrides }, opts);
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, port: (app.server.address() as AddressInfo).port };
}

/** An employee record, optionally with a login, beside the ones `createTenant` makes. */
export async function person(
  T: TenantFixture,
  key: string,
  roles: string[],
  o: { managerId?: string | null; storedLevel?: number; noLogin?: boolean; dob?: string; phone?: string } = {},
) {
  const code = `X${key}${Math.floor(Math.random() * 1e6)}`;
  const [e] = await ownerQuery<{ id: string }>(
    `INSERT INTO employees (tenant_id, employee_code, first_name, last_name, legal_entity_id, branch_id, department_id, reporting_manager_id, date_of_joining, date_of_birth, phone)
     VALUES ($1,$2,'Person',$3,$4,$5,$6,$7,'2024-01-01',$8,$9) RETURNING id`,
    [T.id, code, key, T.legalEntityId, T.branchId, T.deptId, o.managerId ?? null, o.dob ?? null, o.phone ?? null],
  );
  const employeeId = e!.id;
  await ownerQuery(`INSERT INTO shift_assignments (tenant_id, employee_id, shift_id, effective_from) VALUES ($1,$2,$3,'2024-01-01')`, [T.id, employeeId, T.shiftId]);
  if (o.noLogin) return { employeeId, id: '', email: '' };
  const email = `${key}@${T.host}`;
  const hash = (await ownerQuery<{ password_hash: string }>(`SELECT password_hash FROM users WHERE tenant_id=$1 AND password_hash IS NOT NULL LIMIT 1`, [T.id]))[0]!.password_hash;
  const [u] = await ownerQuery<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash, salary_access_level) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
    T.id,
    email,
    key,
    hash,
    o.storedLevel ?? 0,
  ]);
  for (const r of roles) await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,$3)`, [u!.id, T.id, r]);
  await ownerQuery(`UPDATE employees SET user_id=$2 WHERE id=$1`, [employeeId, u!.id]);
  T.users[key] = { id: u!.id, email, employeeId };
  return { employeeId, id: u!.id, email };
}

export { createTenant, ownerQuery };
export type { TenantFixture };
