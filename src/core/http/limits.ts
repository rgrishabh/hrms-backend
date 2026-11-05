import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from './errors.js';

/**
 * A limit per signed-in user, on top of the per-address limit in a route's config: an office behind one address shares that one, and someone
 * spreading requests over many addresses does not get around this one. Counted per process (D27). Falls back to the address before sign-in.
 */
export function perUserLimit(app: FastifyInstance, name: string, max: number) {
  let check: ReturnType<FastifyInstance['createRateLimit']> | null = null;
  return async (req: FastifyRequest) => {
    check ??= app.createRateLimit({ max, timeWindow: '1 minute', keyGenerator: (r) => `${name}:${r.ctx?.user?.userId ?? r.ip}` });
    const r = await check(req);
    if (!r.isAllowed && r.isExceeded) throw new AppError(429, 'rate_limited', 'Too many requests. Please slow down.');
  };
}

/** What counts as an export: a file of many people's data. */
export const isExportRoute = (method: string, url: string) => method === 'GET' && (/\.(csv|xlsx|pdf)$/.test(url) || /\/export(\.\w+)?$/.test(url));
