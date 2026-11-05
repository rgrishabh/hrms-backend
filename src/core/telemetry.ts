import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * OpenTelemetry traces, on only with OTEL_EXPORTER_OTLP_ENDPOINT. A span per request over OTLP/HTTP JSON using `fetch`, so a default image carries no SDK.
 * Attributes are method, route pattern and status: no address, query, id or user. Spans are batched and dropped, never retried: tracing cannot slow a request or hold memory.
 * An incoming W3C `traceparent` is followed, so a proxy's trace continues here. Database calls are not traced.
 */
const MAX_QUEUE = 2048;
const FLUSH_MS = 5000;

interface Span { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: 2; startTimeUnixNano: string; endTimeUnixNano: string; attributes: { key: string; value: { stringValue?: string; intValue?: number } }[]; status: { code: 1 | 2 } }

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
type Log = { warn: (o: object, m?: string) => void };

export function registerTelemetry(app: FastifyInstance, endpoint: string | undefined, serviceName: string, log: Log) {
  if (!endpoint) return;
  const url = `${endpoint.replace(/\/$/, '')}/v1/traces`;
  let queue: Span[] = [];
  let warned = 0;
  const flush = async () => {
    if (!queue.length) return;
    const spans = queue; queue = [];
    const body = JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] }, scopeSpans: [{ scope: { name: 'hrms' }, spans }] }] });
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error(`collector answered ${r.status}`);
    } catch (e) {
      if (Date.now() - warned > 60_000) { warned = Date.now(); log.warn({ err: (e as Error).message }, 'cannot reach the trace collector: spans dropped'); }
    }
  };
  const timer = setInterval(() => { void flush(); }, FLUSH_MS);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); await flush(); });
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    const parent = TRACEPARENT.exec(typeof req.headers.traceparent === 'string' ? req.headers.traceparent : '');
    const endNs = BigInt(Date.now()) * 1_000_000n;
    const startNs = endNs - BigInt(Math.round(reply.elapsedTime * 1e6));
    if (queue.length >= MAX_QUEUE) return;
    queue.push({
      traceId: parent?.[1] ?? randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'), ...(parent ? { parentSpanId: parent[2] } : {}),
      name: `${req.method} ${route}`, kind: 2, startTimeUnixNano: String(startNs), endTimeUnixNano: String(endNs),
      attributes: [{ key: 'http.request.method', value: { stringValue: req.method } }, { key: 'http.route', value: { stringValue: route } }, { key: 'http.response.status_code', value: { intValue: reply.statusCode } }],
      status: { code: reply.statusCode >= 500 ? 2 : 1 },
    });
  });
}
