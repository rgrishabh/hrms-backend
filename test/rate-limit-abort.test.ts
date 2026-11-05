import net from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { limitKey } from '../src/core/http/limits.js';
import { serve } from './security/wire.js';

/**
 * A client that hangs up while the request waits on the database: the socket is destroyed, and `req.ip` reads it. Seen as errors at `normalizeIP` in a frontend E2E run, on aborted fetches.
 */
describe('a request whose client has gone', () => {
  const lines: string[] = [];
  let app: FastifyInstance;
  let port: number;
  afterAll(() => app.close());

  /** Sends a request, hangs up while the host lookup is held, then lets the lookup go on. */
  async function abortDuringLookup() {
    const pool = app.deps.pool as unknown as { connect: (...a: unknown[]) => Promise<unknown> };
    const real = pool.connect.bind(pool);
    let release = () => undefined as void;
    const held = new Promise<void>((r) => (release = r));
    let reached = () => undefined as void;
    const reachedP = new Promise<void>((r) => (reached = r));
    pool.connect = async (...a: unknown[]) => {
      reached();
      await held;
      return real(...a);
    };
    const s = net.connect(port, '127.0.0.1');
    await new Promise((r) => s.once('connect', r));
    s.write(`POST /api/v1/auth/login HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n`);
    await reachedP;
    s.destroy();
    await new Promise((r) => s.once('close', r));
    await new Promise((r) => setTimeout(r, 50));
    pool.connect = real;
    release();
    await new Promise((r) => setTimeout(r, 100));
  }

  it('logs no error, and counts against the address it came from', async () => {
    // Above `info`, since the line for each incoming request reads the address, and Node then keeps a copy. The hang-up is only visible without it.
    ({ app, port } = await serve({ AUTH_RATE_LIMIT_PER_MINUTE: '2', LOG_LEVEL: 'warn' }, { logStream: { write: (l: string) => lines.push(l) } }));
    for (let i = 0; i < 2; i++) await abortDuringLookup();
    const errors = lines.map((l) => JSON.parse(l) as { level: number; msg: string; err?: { message: string } }).filter((l) => l.level >= 50);
    expect(errors.map((l) => l.err?.message ?? l.msg)).toEqual([]);
    const live = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'a@x.test', password: 'x' }, headers: { host: 'localhost' } });
    expect(live.statusCode).toBe(429);
  }, 20000);

  it('with no address at all, every such request shares one budget and is refused past it', async () => {
    const check = app.createRateLimit({ max: 2, timeWindow: '1 minute', keyGenerator: limitKey });
    const gone = () =>
      ({ ip: undefined, clientAddress: undefined, method: 'GET', url: '/x', routeOptions: { url: '/x', config: {} }, ctx: { user: null } }) as unknown as FastifyRequest;
    const seen = [await check(gone()), await check(gone()), await check(gone())];
    expect(seen.map((r) => !r.isAllowed && r.isExceeded)).toEqual([false, false, true]);
  });

  it('an IPv6 client does not get a new budget for each address of its network', () => {
    const at = (clientAddress: string) => limitKey({ clientAddress, method: 'GET', url: '/x', routeOptions: { url: '/x' }, ctx: { user: null } } as unknown as FastifyRequest);
    expect(at('2001:db8:1:1::1')).toBe(at('2001:db8:1:1::2'));
    expect(at('::ffff:198.51.100.7')).toBe('198.51.100.7');
  });

  it('has a key of its own kind: no address is one budget, never no budget', () => {
    const gone = { ip: undefined, method: 'GET', url: '/x', routeOptions: { url: '/x' }, ctx: { user: null } } as unknown as FastifyRequest;
    expect(limitKey(gone)).toBe('no-address');
    expect(limitKey({ ...gone, clientAddress: '198.51.100.7' } as unknown as FastifyRequest)).toBe('198.51.100.7');
  });
});
