import { Decimal } from 'decimal.js';
import type { Db } from '../../db/tx.js';

export const MODES = ['air', 'rail', 'bus', 'road', 'own_vehicle', 'other'] as const;

/**
 * Where a trip's money stands: the advance paid, how much of it the trip's approved claims used up,
 * what the employee returned, and what is still outstanding with them (to be returned or recovered).
 */
export async function settlement(db: Db, tenantId: string, tripId: string) {
  const t = (
    await db.query<{ advance_paid_amount: string | null; recovered_amount: string }>(
      `SELECT advance_paid_amount, recovered_amount FROM travel_requests WHERE tenant_id=$1 AND id=$2`,
      [tenantId, tripId],
    )
  ).rows[0];
  const claims = (
    await db.query<{ id: string; title: string; status: string; total: string; advance_adjusted: string; paid_at: string | null }>(
      `SELECT id, title, status, total, advance_adjusted, paid_at FROM expense_claims WHERE tenant_id=$1 AND travel_request_id=$2 AND status <> 'cancelled' ORDER BY created_at`,
      [tenantId, tripId],
    )
  ).rows;
  const paid = new Decimal(t?.advance_paid_amount ?? 0);
  const done = claims.filter((c) => ['approved', 'paid'].includes(c.status));
  const adjusted = done.reduce((s, c) => s.plus(c.advance_adjusted), new Decimal(0));
  const claimed = done.reduce((s, c) => s.plus(c.total), new Decimal(0));
  const recovered = new Decimal(t?.recovered_amount ?? 0);
  const outstanding = Decimal.max(0, paid.minus(adjusted).minus(recovered));
  return {
    advancePaid: paid.toFixed(2),
    claimed: claimed.toFixed(2),
    advanceAdjusted: adjusted.toFixed(2),
    recovered: recovered.toFixed(2),
    reimbursable: claimed.minus(adjusted).toFixed(2),
    outstanding: outstanding.toFixed(2),
    openClaims: claims.filter((c) => ['draft', 'returned', 'submitted'].includes(c.status) || (c.status === 'approved' && !c.paid_at)).length,
    claims,
  };
}

/**
 * When a trip's expense claim is approved, the outstanding advance is set off against it first; only the
 * rest is reimbursed. A claim the advance covers entirely is settled at once (nothing to pay).
 */
export async function setOffAdvance(db: Db, tenantId: string, claimId: string) {
  const c = (
    await db.query<{ travel_request_id: string | null; total: string }>(`SELECT travel_request_id, total FROM expense_claims WHERE tenant_id=$1 AND id=$2`, [tenantId, claimId])
  ).rows[0];
  if (!c?.travel_request_id) return;
  await db.query(`SELECT 1 FROM travel_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, c.travel_request_id]);
  const s = await settlement(db, tenantId, c.travel_request_id);
  // `settlement` already counts this (now approved) claim with advance_adjusted 0.
  const use = Decimal.min(new Decimal(s.outstanding), new Decimal(c.total));
  if (use.lte(0)) return;
  const covered = use.eq(c.total);
  await db.query(
    `UPDATE expense_claims SET advance_adjusted=$3${covered ? `, status='paid', paid_at=now(), payment_reference='Set off against travel advance'` : ''}, updated_at=now()
    WHERE tenant_id=$1 AND id=$2`,
    [tenantId, claimId, use.toFixed(2)],
  );
}
