import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import { sha256, safeEqualHex } from '../crypto/index.js';
import type { Pool } from '../../db/pool.js';

/**
 * Prometheus text format with no client library: request counts and durations by route pattern, the connection pool and the event loop.
 * Labels are route patterns and methods, never addresses or ids, so nothing personal gets in and the series stay few.
 */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Series {
  count: number;
  sum: number;
  buckets: number[];
}
const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

export class Metrics {
  private readonly requests = new Map<string, number>();
  private readonly durations = new Map<string, Series>();
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });

  constructor(private readonly pool: Pool) {
    this.loop.enable();
  }

  observe(method: string, route: string, status: number, seconds: number) {
    const reqKey = `method="${esc(method)}",route="${esc(route)}",status="${status}"`;
    this.requests.set(reqKey, (this.requests.get(reqKey) ?? 0) + 1);
    const durKey = `method="${esc(method)}",route="${esc(route)}"`;
    const s = this.durations.get(durKey) ?? { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
    s.count++;
    s.sum += seconds;
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) s.buckets[i]!++;
    });
    this.durations.set(durKey, s);
  }

  render(): string {
    const out: string[] = [];
    out.push('# HELP http_requests_total Requests answered, by route pattern.', '# TYPE http_requests_total counter');
    for (const [k, v] of this.requests) out.push(`http_requests_total{${k}} ${v}`);
    out.push('# HELP http_request_duration_seconds Time to answer, by route pattern.', '# TYPE http_request_duration_seconds histogram');
    for (const [k, s] of this.durations) {
      BUCKETS.forEach((b, i) => out.push(`http_request_duration_seconds_bucket{${k},le="${b}"} ${s.buckets[i]}`));
      out.push(
        `http_request_duration_seconds_bucket{${k},le="+Inf"} ${s.count}`,
        `http_request_duration_seconds_sum{${k}} ${s.sum}`,
        `http_request_duration_seconds_count{${k}} ${s.count}`,
      );
    }
    const gauge = (name: string, help: string, v: number) => out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${v}`);
    gauge('db_pool_connections', 'Connections open in the pool.', this.pool.totalCount);
    gauge('db_pool_idle_connections', 'Open connections not in use.', this.pool.idleCount);
    gauge('db_pool_waiting_requests', 'Requests waiting for a connection.', this.pool.waitingCount);
    gauge('nodejs_eventloop_delay_p99_seconds', 'Event loop delay, 99th percentile since the last scrape.', this.loop.percentile(99) / 1e9);
    this.loop.reset();
    gauge('process_resident_memory_bytes', 'Resident memory.', process.memoryUsage().rss);
    gauge('process_uptime_seconds', 'Time since the process started.', process.uptime());
    return out.join('\n') + '\n';
  }

  close() {
    this.loop.disable();
  }
}

/**
 * `/metrics` exists only with METRICS_TOKEN set, and answers 404 to anyone without it, whatever a proxy in front forwards (D57).
 * The comparison is on hashes, so its time says nothing about the token.
 */
export function registerMetrics(app: FastifyInstance, token: string | undefined, pool: Pool) {
  const metrics = new Metrics(pool);
  app.addHook('onClose', async () => {
    metrics.close();
  });
  app.addHook('onResponse', async (req, reply) => {
    metrics.observe(req.method, req.routeOptions.url ?? 'unmatched', reply.statusCode, reply.elapsedTime / 1000);
  });
  if (!token) return;
  const expected = sha256(token);
  app.get('/metrics', { schema: {}, config: { rateLimit: false } }, async (req, reply) => {
    const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!given || !safeEqualHex(sha256(given), expected)) {
      reply.callNotFound();
      return reply;
    }
    return reply.type('text/plain; version=0.0.4; charset=utf-8').header('cache-control', 'no-store').send(metrics.render());
  });
}
