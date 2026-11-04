import { z } from 'zod';

export const PageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const offsetOf = (p: { page: number; pageSize: number }) => (p.page - 1) * p.pageSize;

export const paged = <T>(items: T[], total: number, p: { page: number; pageSize: number }) =>
  ({ items, page: p.page, pageSize: p.pageSize, total });

/** A real calendar date: 2024-02-30 is rejected here (JavaScript would roll it over to 1 March; PostgreSQL would fail with a 500). */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((s) => {
  const t = Date.parse(s + 'T00:00:00Z');
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}, 'Invalid date');
export const Uuid = z.uuid();
