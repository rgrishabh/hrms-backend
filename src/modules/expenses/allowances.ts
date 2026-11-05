import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { tenantActor, tenantActorAny, requireFeature } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { IsoDate, Uuid } from '../../core/http/pagination.js';
import type { Db } from '../../db/tx.js';
import { orgToday } from '../../core/workflow/engine.js';
import { daysBetween } from '../attendance/time.js';

/**
 * Per-diem and mileage rates (docs/EXPENSES.md → Allowances). The organization enters its own policy; nothing is shipped.
 * A rate applies from its date until a newer one for the same class (tier + grade, or vehicle) takes over.
 */
export type AllowanceKind = 'per_diem' | 'mileage';
export const VEHICLES = { car: 'Car', two_wheeler: 'Two-wheeler' } as const;
const Tier = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z0-9_]{1,20}$/, 'Use a short code such as METRO, OTHER or INTL'));

export interface RateRow {
  id: string;
  rate: string;
  grade: string | null;
}

/** The rate in force on `date`. For per diem, a rate for the employee's grade beats the one for every grade. */
export async function findRate(
  db: Db,
  tenantId: string,
  q: { kind: AllowanceKind; date: string; tier?: string | null; grade?: string | null; vehicle?: string | null },
): Promise<RateRow | null> {
  const r =
    q.kind === 'per_diem'
      ? await db.query<RateRow>(
          `SELECT id, rate, grade FROM allowance_rates WHERE tenant_id=$1 AND kind='per_diem' AND tier=$2 AND (grade IS NULL OR grade=$3)
        AND effective_from <= $4 ORDER BY (grade IS NOT NULL) DESC, effective_from DESC LIMIT 1`,
          [tenantId, q.tier, q.grade ?? null, q.date],
        )
      : await db.query<RateRow>(
          `SELECT id, rate, grade FROM allowance_rates WHERE tenant_id=$1 AND kind='mileage' AND vehicle=$2
        AND effective_from <= $3 ORDER BY effective_from DESC LIMIT 1`,
          [tenantId, q.vehicle, q.date],
        );
  return r.rows[0] ?? null;
}

export async function employeeGrade(db: Db, tenantId: string, employeeId: string) {
  return (await db.query<{ grade: string | null }>('SELECT grade FROM employees WHERE tenant_id=$1 AND id=$2', [tenantId, employeeId])).rows[0]?.grade ?? null;
}

/** Validates and prices a computed item. `claimed` (optional) may be lower than the allowance, never higher. */
export async function priceAllowance(
  db: Db,
  tenantId: string,
  p: {
    kind: AllowanceKind;
    employeeId: string;
    date: string;
    quantity: Decimal;
    tier?: string | null;
    vehicle?: string | null;
    claimed?: Decimal | null;
  },
) {
  if (p.kind === 'per_diem') {
    if (!p.tier) throw badRequest('Choose the destination class for the per diem');
    if (!p.quantity.mul(2).isInteger() || p.quantity.gt(31)) throw badRequest('Per diem days must be in half days, at most 31 per item');
  } else {
    if (!p.vehicle || !(p.vehicle in VEHICLES)) throw badRequest('Choose the vehicle');
    if (p.quantity.decimalPlaces() > 1 || p.quantity.gt(2000)) throw badRequest('Enter the distance in km (one decimal), at most 2000 per item');
  }
  const grade = p.kind === 'per_diem' ? await employeeGrade(db, tenantId, p.employeeId) : null;
  const rate = await findRate(db, tenantId, { kind: p.kind, date: p.date, tier: p.tier, grade, vehicle: p.vehicle });
  if (!rate)
    throw badRequest(
      p.kind === 'per_diem'
        ? `There is no per-diem rate for ${p.tier} on ${p.date}. Ask finance to set one`
        : `There is no mileage rate for a ${VEHICLES[p.vehicle as keyof typeof VEHICLES].toLowerCase()} on ${p.date}. Ask finance to set one`,
    );
  const allowance = p.quantity.mul(rate.rate).toDecimalPlaces(2);
  if (p.claimed && p.claimed.gt(allowance)) throw badRequest(`At most ${allowance.toFixed(2)} (${p.quantity} × ${rate.rate}) can be claimed`);
  return { rate, amount: p.claimed ?? allowance, allowance };
}

const AllowanceRatesBody = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('per_diem'), tier: Tier, grade: z.string().trim().min(1).max(20).nullable().optional() }),
    z.object({ kind: z.literal('mileage'), vehicle: z.enum(['car', 'two_wheeler']) }),
  ])
  .and(
    z.object({
      rate: z
        .number()
        .positive()
        .max(1_000_000)
        .refine((v) => Number.isInteger(v * 100), 'Up to 2 decimals'),
      effectiveFrom: IsoDate,
      note: z.string().trim().max(200).optional(),
    }),
  );
const IdParams = z.object({ id: Uuid });
const AllowanceQuoteQuery = z.object({
  kind: z.enum(['per_diem', 'mileage']),
  date: IsoDate,
  to: IsoDate.optional(),
  tier: Tier.optional(),
  vehicle: z.enum(['car', 'two_wheeler']).optional(),
  km: z.coerce.number().positive().max(2000).optional(),
  employeeId: Uuid.optional(),
});
export async function allowanceRoutes(app: FastifyInstance) {
  app.get('/allowance-rates', { schema: {}, config: { permAny: ['expenses.self', 'expenses.manage', 'expenses.read', 'travel.self'], feature: ['expenses'] } }, async (req) => {
    const a = tenantActorAny(req, 'expenses.self', 'expenses.manage', 'expenses.read', 'travel.self');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'expenses');
      const today = await orgToday(db, a.tenantId);
      const rows = (
        await db.query<{ id: string; kind: string; tier: string | null; grade: string | null; vehicle: string | null; effective_from: string }>(
          `SELECT r.id, r.kind, r.tier, r.grade, r.vehicle, r.rate, r.effective_from::text, r.note, r.created_at, u.display_name AS created_by_name
           FROM allowance_rates r JOIN users u ON u.id=r.created_by WHERE r.tenant_id=$1 ORDER BY r.kind, r.tier, r.grade NULLS FIRST, r.vehicle, r.effective_from DESC`,
          [a.tenantId],
        )
      ).rows;
      // A rate is current when it is the newest one in force today for its class; scheduled when it starts later.
      const cls = (r: (typeof rows)[number]) => `${r.kind}|${r.tier}|${r.grade}|${r.vehicle}`;
      const seen = new Set<string>();
      const items = rows.map((r) => {
        if (r.effective_from > today) return { ...r, state: 'scheduled' };
        const state = seen.has(cls(r)) ? 'superseded' : 'current';
        seen.add(cls(r));
        return { ...r, state };
      });
      return { today, items, tiers: [...new Set(rows.filter((r) => r.kind === 'per_diem').map((r) => r.tier!))].sort(), vehicles: VEHICLES, canManage: a.has('expenses.manage') };
    });
  });

  app.post('/allowance-rates', { schema: { body: AllowanceRatesBody }, config: { perm: ['expenses.manage'], feature: ['expenses'] } }, async (req, reply) => {
    const a = tenantActor(req, 'expenses.manage');
    const b = AllowanceRatesBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'expenses');
      const today = await orgToday(db, a.tenantId);
      if (daysBetween(b.effectiveFrom, today) > 90) throw badRequest('A rate can start at most 90 days back');
      const cls = b.kind === 'per_diem' ? { tier: b.tier, grade: b.grade || null, vehicle: null } : { tier: null, grade: null, vehicle: b.vehicle };
      const dup = await db.query(
        `SELECT 1 FROM allowance_rates WHERE tenant_id=$1 AND kind=$2 AND tier IS NOT DISTINCT FROM $3 AND grade IS NOT DISTINCT FROM $4
          AND vehicle IS NOT DISTINCT FROM $5 AND effective_from=$6`,
        [a.tenantId, b.kind, cls.tier, cls.grade, cls.vehicle, b.effectiveFrom],
      );
      if (dup.rowCount) throw conflict('A rate for this class already starts on that day');
      // Items keep the rate they were priced at; a new (even back-dated) rate applies to items added from now on.
      const r = await db.query<{ id: string }>(
        `INSERT INTO allowance_rates (tenant_id, kind, tier, grade, vehicle, rate, effective_from, note, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [a.tenantId, b.kind, cls.tier, cls.grade, cls.vehicle, b.rate.toFixed(2), b.effectiveFrom, b.note ?? null, a.user.userId],
      );
      await audit(db, {
        ...a.auditBase,
        action: 'expenses.allowance_rate_added',
        category: 'configuration',
        targetType: 'allowance_rate',
        targetId: r.rows[0]!.id,
        metadata: { ...b, ...cls },
      });
      reply.code(201);
      return { id: r.rows[0]!.id };
    });
  });

  // Only a rate that has not started yet can be withdrawn (a typo in next month's rate); others are superseded.
  app.delete('/allowance-rates/:id', { schema: { params: IdParams }, config: { perm: ['expenses.manage'] } }, async (req) => {
    const a = tenantActor(req, 'expenses.manage');
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      // Rates are never updated (no UPDATE grant, so no row lock either): delete only while it has not started.
      const del = await db.query('DELETE FROM allowance_rates WHERE tenant_id=$1 AND id=$2 AND effective_from > $3', [a.tenantId, id, await orgToday(db, a.tenantId)]);
      if (!del.rowCount) {
        if ((await db.query('SELECT 1 FROM allowance_rates WHERE tenant_id=$1 AND id=$2', [a.tenantId, id])).rowCount)
          throw conflict('This rate is already in force; add a new rate to replace it');
        throw notFound('Rate not found');
      }
      await audit(db, { ...a.auditBase, action: 'expenses.allowance_rate_withdrawn', category: 'configuration', targetType: 'allowance_rate', targetId: id });
      return { ok: true };
    });
  });

  // What an allowance comes to, for a trip estimate or before adding an item: per diem for the days from..to, or mileage for km.
  app.get('/allowance-quote', { schema: { querystring: AllowanceQuoteQuery }, config: { permAny: ['expenses.self', 'travel.self'], feature: ['expenses'] } }, async (req) => {
    const a = tenantActorAny(req, 'expenses.self', 'travel.self');
    const q = AllowanceQuoteQuery.parse(req.query);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'expenses');
      const employeeId = q.employeeId ?? a.user.employeeId;
      if (!employeeId) throw badRequest('Your account is not linked to an employee record');
      if (employeeId !== a.user.employeeId && !a.has('expenses.read') && !a.has('travel.read')) throw forbidden();
      const grade = await employeeGrade(db, a.tenantId, employeeId);
      const rate = await findRate(db, a.tenantId, { kind: q.kind, date: q.date, tier: q.tier, grade, vehicle: q.vehicle });
      if (!rate) return { rate: null };
      const quantity = q.kind === 'per_diem' ? (q.to && q.to >= q.date ? daysBetween(q.date, q.to) + 1 : 1) : (q.km ?? 1);
      return { rate: rate.rate, gradeSpecific: rate.grade !== null, quantity, amount: new Decimal(rate.rate).mul(quantity).toFixed(2) };
    });
  });
}
