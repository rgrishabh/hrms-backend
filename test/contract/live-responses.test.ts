import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from '../helpers.js';
import { DEMO_PASSWORD, demoWorld, idsOf, tableFor } from './demo-world.js';

/**
 * Every GET the app has, by every persona, masked and revealed, against a populated organization. Test apps refuse an answer its declared schema does not describe,
 * so a shape that differs from openapi.json is a 500 here. So is any other crash on a read.
 */
let w: Awaited<ReturnType<typeof demoWorld>>;
let app: FastifyInstance;
beforeAll(async () => {
  w = await demoWorld();
  app = w.app;
}, 120000);
afterAll(async () => {
  await app.close();
});

describe('what the running app answers', () => {
  it('matches the declared response on every GET, for every persona', async () => {
    const from = w.today.slice(0, 4) + '-01-01';
    const month = w.today.slice(0, 7);
    const q = `from=${from}&to=${w.today}&month=${month}&year=${w.today.slice(0, 4)}&period=${month}`;
    const routes = app.featureRoutes.filter((r) => r.method === 'GET' && r.url.startsWith('/api/'));
    const seen = new Set<string>();
    const urls: string[] = [];
    const director = await Client.login(app, w.host, w.logins[0]!, DEMO_PASSWORD);
    const reports = (((await director.get('/api/v1/reports')).json() as { items?: { key: string }[] }).items ?? []).map((r) => r.key);
    for (const r of routes) {
      const key = r.url.replace(/\/$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      const params = [...key.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);
      let variants = [key];
      for (const p of params) {
        if (p === 'key') {
          variants = variants.flatMap((v) => reports.map((k) => v.replace(':key', k)));
          continue;
        }
        const t = tableFor(key, p);
        if (!t) continue;
        const ids = await idsOf(t, w.tid, 3);
        variants = variants.flatMap((v) => ids.map((id) => v.replace(`:${p}`, id)));
      }
      urls.push(...variants.filter((v) => !v.includes(':')));
    }
    const bad = new Map<string, string>();
    let calls = 0;
    for (const login of w.logins) {
      const c = await Client.login(app, w.host, login, DEMO_PASSWORD);
      for (const u of urls) {
        for (const suffix of [`?${q}`, `?${q}&reveal=1`]) {
          const r = await c.get(u + suffix);
          calls++;
          if (r.statusCode >= 500) bad.set(`${u.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')} ${login.split('@')[0]}`, r.body.slice(0, 400));
        }
      }
    }
    if (process.env.SWEEP_OUT) writeFileSync(process.env.SWEEP_OUT, [...bad].map(([k, v]) => `${k}\n  ${v}`).join('\n'));
    expect(calls).toBeGreaterThan(1000);
    expect([...bad.keys()]).toEqual([]);
  }, 600000);
});
