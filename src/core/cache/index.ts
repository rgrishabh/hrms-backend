import { Redis } from 'ioredis';
import { afterCommit, type Db } from '../../db/tx.js';

/**
 * Optional shared cache (REDIS_URL) for config and lookup data. The database stays the source of truth: with no Redis, or a
 * Redis that is down or slow, every read goes to the database. Slower, still correct. Only settings and organization structure
 * go here, never personal data.
 *
 * Invalidation is by generation. Each tenant and namespace has a counter, which is part of every key. A write bumps it after its
 * transaction commits, so a reader on any instance moves to keys nobody has filled yet, and a slower reader that loaded the old
 * data before the commit writes it under the old generation, where nobody will look. The TTL bounds the one gap left: a process
 * that dies between commit and bump, or a Redis that was unreachable for that bump.
 */
export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  incr(key: string): Promise<void>;
  close(): Promise<void>;
}

export type CacheNamespace = 'settings' | 'org';
const TTL_SECONDS = 60;
const GENERATION_TTL_SECONDS = 7 * 24 * 3600;

let cache: Cache | null = null;
export const setCache = (c: Cache | null) => {
  cache = c;
};
export const getCache = () => cache;

type Log = { warn: (o: object, m?: string) => void };

export function createRedisCache(url: string, log: Log): Cache {
  const client = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 250,
    retryStrategy: (attempt) => Math.min(attempt * 500, 5000),
  });
  let lastWarning = 0;
  client.on('error', (e: Error) => {
    // The reason only, never the URL: it holds the password. At most once a minute: this repeats while Redis is down.
    if (Date.now() - lastWarning > 60_000) {
      lastWarning = Date.now();
      log.warn({ err: e.message }, 'redis unavailable: reading from the database');
    }
  });
  return {
    get: (key) => client.get(key),
    async set(key, value, ttl) {
      await client.set(key, value, 'EX', ttl);
    },
    async incr(key) {
      await client.multi().incr(key).expire(key, GENERATION_TTL_SECONDS).exec();
    },
    async close() {
      client.disconnect();
    },
  };
}

/** Written to in this transaction: its own reads must see its writes, which nobody else can yet. */
const dirty = new WeakMap<object, Set<CacheNamespace>>();

const generationKey = (tenantId: string, ns: CacheNamespace) => `hrms:gen:${tenantId}:${ns}`;

/** Read through the cache. Any cache failure means the database answers, and the value is not cached. */
export async function cached<T>(db: Db, tenantId: string, ns: CacheNamespace, key: string, load: () => Promise<T>): Promise<T> {
  const c = cache;
  if (!c || dirty.get(db)?.has(ns)) return load();
  let full: string;
  try {
    const generation = (await c.get(generationKey(tenantId, ns))) ?? '0';
    full = `hrms:${tenantId}:${ns}:${generation}:${key}`;
    const hit = await c.get(full);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch {
    return load();
  }
  const value = await load();
  await c.set(full, JSON.stringify(value), TTL_SECONDS).catch(() => undefined);
  return value;
}

/** Call in the transaction that writes. Other readers move on when it commits, and if it rolls back nothing changed. */
export function invalidate(db: Db, tenantId: string, ns: CacheNamespace) {
  const c = cache;
  if (!c) return;
  const set = dirty.get(db) ?? new Set<CacheNamespace>();
  set.add(ns);
  dirty.set(db, set);
  afterCommit(
    db,
    () => c.incr(generationKey(tenantId, ns)).catch(() => undefined),
    () => {
      dirty.delete(db);
    },
  );
}
