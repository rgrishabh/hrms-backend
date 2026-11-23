import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, createTenant, makeApp, type TenantFixture } from './helpers.js';

const TOKEN = 'a-metrics-token-for-tests';

describe('/metrics', () => {
  let app: FastifyInstance;
  let T: TenantFixture;
  beforeAll(async () => {
    app = await makeApp({ METRICS_TOKEN: TOKEN });
    T = await createTenant();
  });
  afterAll(() => app.close());

  it('does not exist for anyone without the token', async () => {
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: TOKEN }]) {
      const r = await app.inject({ url: '/metrics', headers });
      expect(r.statusCode).toBe(404);
      expect(r.headers['content-type']).toMatch(/problem\+json/);
    }
  });

  it('with the token: Prometheus text, by route pattern, with no id in a label', async () => {
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    await admin.get(`/api/v1/employees/${T.users.employee!.employeeId}`);
    const r = await app.inject({ url: '/metrics', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(r.body).toMatch(/^# TYPE http_requests_total counter$/m);
    expect(r.body).toMatch(/http_requests_total\{method="GET",route="\/api\/v1\/employees\/:id",status="200"\} \d+/);
    expect(r.body).toMatch(/http_request_duration_seconds_bucket\{method="GET",route="\/api\/v1\/employees\/:id",le="\+Inf"\} \d+/);
    expect(r.body).toMatch(/^db_pool_connections \d+$/m);
    expect(r.body).toMatch(/^nodejs_eventloop_delay_p99_seconds [\d.]+$/m);
    expect(r.body).not.toContain(T.users.employee!.employeeId!);
    expect(r.body).not.toContain(T.users.admin!.email);
  });

  it('with no token configured there is no such route', async () => {
    const off = await makeApp();
    try {
      expect((await off.inject({ url: '/metrics', headers: { authorization: `Bearer ${TOKEN}` } })).statusCode).toBe(404);
    } finally {
      await off.close();
    }
  });
});

describe('logs', () => {
  it('JSON with a request id, and nothing personal from a real sign-in and read', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _e, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const app = await makeApp({ LOG_LEVEL: 'info' }, { logStream: stream });
    const T = await createTenant();
    try {
      const email = T.users.employee!.email;
      const emp = await Client.login(app, T.host, email);
      await emp.get('/api/v1/auth/me?email=' + encodeURIComponent(email));
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { host: T.host, 'content-type': 'application/json' },
        payload: { email, password: 'wrong-password-value' },
      });
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(lines.length).toBeGreaterThan(2);
      const parsed = lines.map((l) => JSON.parse(l) as { reqId?: string; level: number });
      expect(parsed.some((l) => l.reqId === res.headers['x-request-id'])).toBe(true);
      const all = lines.join('');
      expect(all).not.toContain(email);
      expect(all).not.toContain('wrong-password-value');
      expect(all).not.toMatch(/hrms_sid=/);
    } finally {
      await app.close();
    }
  });
});

describe('health', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeApp();
  });
  afterAll(() => app.close());

  it('liveness asks nothing of the database', async () => {
    const dead = await makeApp({ DATABASE_URL: 'postgres://x:y@127.0.0.1:1/none' });
    try {
      expect((await dead.inject({ url: '/health/live' })).json()).toEqual({ status: 'ok', version: 'dev' });
      const r = await dead.inject({ url: '/health/ready' });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({ status: 'unavailable' });
    } finally {
      await dead.close();
    }
  });

  it('readiness says only ready', async () => {
    const r = await app.inject({ url: '/health/ready' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ready' });
  });

  it('probes are not rate limited', async () => {
    const small = await makeApp({ RATE_LIMIT_PER_MINUTE: '60' });
    try {
      for (let i = 0; i < 70; i++) expect((await small.inject({ url: '/health/live' })).statusCode).toBe(200);
    } finally {
      await small.close();
    }
  });
});

describe('OpenTelemetry', () => {
  let sink: Server;
  let url: string;
  const bodies: string[] = [];
  beforeAll(async () => {
    sink = createServer((req, res) => {
      let b = '';
      req.on('data', (c: Buffer) => {
        b += c.toString();
      });
      req.on('end', () => {
        bodies.push(`${req.url} ${b}`);
        res.end('{}');
      });
    });
    await new Promise<void>((r) => {
      sink.listen(0, '127.0.0.1', r);
    });
    url = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => {
      sink.close(r);
    });
  });

  it('off by default: nothing is sent', async () => {
    const app = await makeApp();
    await app.inject({ url: '/health/live' });
    await app.close();
    expect(bodies).toEqual([]);
  });

  it('on with an endpoint: a span with the route pattern, following traceparent, and nothing personal', async () => {
    const app = await makeApp({ OTEL_EXPORTER_OTLP_ENDPOINT: url });
    const trace = '4bf92f3577b34da6a3ce929d0e0e4736';
    await app.inject({ url: '/api/v1/nowhere?email=a@b.test', headers: { traceparent: `00-${trace}-00f067aa0ba902b7-01` } });
    await app.close();
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toMatch(/^\/v1\/traces /);
    expect(bodies[0]).toContain(trace);
    expect(bodies[0]).toContain('service.name');
    expect(bodies[0]).not.toContain('a@b.test');
  });
});
