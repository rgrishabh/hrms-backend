import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig { features?: readonly string[] }
}

type Verbs = Pick<FastifyInstance, 'get' | 'post' | 'put' | 'patch' | 'delete'>;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Options = { config?: Record<string, unknown> } & Record<string, unknown>;

/**
 * Routes of a narrower feature inside a module's plugin: registered only while one of `keys` is on for this app, so that
 * they answer 404 otherwise, exactly like a module that was never mounted. `only(app, 'shifts').get('/shifts', handler)`.
 */
export function only(app: FastifyInstance, ...keys: [string, ...string[]]): Verbs {
  const on = keys.some((k) => app.deps.env.enabledFeatures.has(k));
  const verb = (method: Method) => (url: string, a: unknown, b?: unknown) => {
    if (on) {
      const opts = (b === undefined ? {} : a) as Options;
      const handler = (b === undefined ? a : b) as never;
      app.route({ ...opts, method, url, handler, config: { ...opts.config, features: keys } } as never);
    }
    return app;
  };
  return { get: verb('GET'), post: verb('POST'), put: verb('PUT'), patch: verb('PATCH'), delete: verb('DELETE') } as unknown as Verbs;
}

/** One registered route and what it needs: every group must have a feature on. Read by the generated test of all flags. */
export interface FeatureRoute { method: string; url: string; requires: readonly (readonly string[])[] }
