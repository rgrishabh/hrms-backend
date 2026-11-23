import { normalizeIP } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from './errors.js';

/**
 * Whom an anonymous request counts against. `clientAddress` is read as the request arrives: a client that has hung up leaves `req.ip` undefined. Should that have happened before the first
 * hook, all such requests share one budget, so that having no address is never a way around the limit. An IPv6 client is counted by its network, as the plugin does on its own.
 */
const NO_ADDRESS = 'no-address';
const addressKey = (req: FastifyRequest) => (req.clientAddress ? normalizeIP(req.clientAddress) : NO_ADDRESS);

/**
 * A limit per signed-in user, on top of the per-address limit in a route's config: an office behind one address shares that one, and someone
 * spreading requests over many addresses does not get around this one. Counted per process (D27). Falls back to the address before sign-in.
 */
export function perUserLimit(app: FastifyInstance, name: string, max: number) {
  let check: ReturnType<FastifyInstance['createRateLimit']> | null = null;
  return async (req: FastifyRequest) => {
    check ??= app.createRateLimit({ max, timeWindow: '1 minute', keyGenerator: (r) => `${name}:${r.ctx?.user?.userId ?? addressKey(r)}` });
    const r = await check(req);
    if (!r.isAllowed && r.isExceeded) throw new AppError(429, 'rate_limited', 'Too many requests. Please slow down.');
  };
}

/** What counts as an export: a file of many people's data. */
export const isExportRoute = (method: string, url: string) => method === 'GET' && (/\.(csv|xlsx|pdf)$/.test(url) || /\/export(\.\w+)?$/.test(url));

/**
 * Who a limit counts. An office is one address, so a signed-in person is counted as themselves. Sign-in and files of many people's data stay counted by address, since a valid session must not buy
 * anyone a fresh budget for guessing other people's passwords, and exports have the per-user limit above as well.
 */
export function limitKey(req: FastifyRequest): string {
  const url = req.routeOptions.url ?? req.url;
  const user = req.ctx?.user;
  return user && !url.startsWith('/api/v1/auth') && !isExportRoute(req.method, url) ? `user:${user.userId}` : addressKey(req);
}
