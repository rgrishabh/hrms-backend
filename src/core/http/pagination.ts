import { z } from 'zod';
import type { Db } from '../../db/tx.js';

export const PageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** Lists that used to answer everything, or stop at a silent cap: big enough by default that a settings screen still sees it all, with `total` to say so when it does not. */
export const ListQuery = PageQuery.extend({ pageSize: z.coerce.number().int().min(1).max(500).default(100) });
/** The same, for a list someone works through: an inbox, the people in a payroll run. */
export const LongListQuery = PageQuery.extend({ pageSize: z.coerce.number().int().min(1).max(500).default(200) });

export const offsetOf = (p: { page: number; pageSize: number }) => (p.page - 1) * p.pageSize;

export const paged = <T>(items: T[], total: number, p: { page: number; pageSize: number }) => ({ items, page: p.page, pageSize: p.pageSize, total });

/** One page of a query, with the count of all of it. `sql` must have its ORDER BY. */
export async function pageOf<T extends Record<string, unknown>>(db: Db, sql: string, args: unknown[], p: { page: number; pageSize: number }) {
  const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM (${sql}) counted`, args)).rows[0]!.n);
  const rows = (await db.query<T>(`${sql} LIMIT ${p.pageSize} OFFSET ${offsetOf(p)}`, args)).rows;
  return paged(rows, total, p);
}

/** A real calendar date: 2024-02-30 is rejected here (JavaScript would roll it over to 1 March; PostgreSQL would fail with a 500). */
/** A boolean in a query string. z.coerce.boolean would make "false" true, as any non-empty string is. */
export const QueryBool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((s) => {
    const t = Date.parse(s + 'T00:00:00Z');
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
  }, 'Invalid date');
export const Uuid = z.uuid();
