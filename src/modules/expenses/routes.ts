import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { tenantActor, tenantActorAny, requireFeature, type TenantActor, gateFeatures } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { IsoDate, PageQuery, offsetOf, paged, Uuid } from '../../core/http/pagination.js';
import { createApprovalRequest, registerApprovalHandler, cancelRequest, type StepSpec } from '../../core/workflow/engine.js';
import { getStore, newKey } from '../../core/storage/index.js';
import { detectFile, safeFileName } from '../../core/storage/sniff.js';
import { getSettingValue } from '../../core/settings/service.js';
import { notifyUsers } from '../../core/notify/service.js';
import { teamEmployeeIds, employeeTimezone } from '../attendance/service.js';
import { localDate, daysBetween } from '../attendance/time.js';
import type { Db } from '../../db/tx.js';
import { setOffAdvance } from '../travel/service.js';
import { allowanceRoutes, priceAllowance } from './allowances.js';

const Money = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const d = new Decimal(v);
  if (!d.isFinite() || d.lte(0) || d.decimalPlaces() > 2 || d.gt('9999999999.99')) { ctx.addIssue({ code: 'custom', message: 'Enter an amount greater than 0 with up to 2 decimals' }); return z.NEVER; }
  return d;
});
const CategoryBody = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{0,19}$/), name: z.string().trim().min(2).max(80), description: z.string().trim().max(300).nullable().optional(),
  requiresReceipt: z.boolean().default(true), maxAmount: z.number().positive().nullable().default(null), gstApplicable: z.boolean().default(false), status: z.enum(['active', 'inactive']).default('active'),
  // Computed from days × per-diem rate or km × mileage rate (docs/EXPENSES.md → Allowances).
  calc: z.enum(['per_diem', 'mileage']).nullable().default(null),
});
const ClaimBody = z.object({ title: z.string().trim().min(3).max(200), purpose: z.string().trim().min(3).max(1000), project: z.string().trim().max(100).nullable().optional() });

interface Claim { id: string; employee_id: string; status: string; total: string; created_by: string; title: string; version: number; batch_id: string | null }

/** Owner, reporting chain (expenses.team.read), finance (read/approve/pay), or the current approver of its request. */
async function canViewClaim(db: Db, a: TenantActor, c: Claim) {
  if (c.employee_id === a.user.employeeId || a.has('expenses.read') || a.has('expenses.approve') || a.has('expenses.pay')) return true;
  if (a.has('expenses.team.read') && a.user.employeeId && (await teamEmployeeIds(db, a.tenantId, a.user.employeeId)).includes(c.employee_id)) return true;
  const r = await db.query(`SELECT 1 FROM approval_requests r JOIN approval_steps s ON s.tenant_id=r.tenant_id AND s.request_id=r.id
    WHERE r.tenant_id=$1 AND r.entity_type='expense_claim' AND r.entity_id=$2 AND (s.approver_user_id=$3 OR s.acted_by=$3)`, [a.tenantId, c.id, a.user.userId]);
  return (r.rowCount ?? 0) > 0;
}

async function loadClaim(db: Db, a: TenantActor, id: string, lock = false) {
  const c = (await db.query<Claim>(`SELECT id, employee_id, status, total, created_by, title, version, batch_id FROM expense_claims WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [a.tenantId, id])).rows[0];
  if (!c || !(await canViewClaim(db, a, c))) throw notFound('Expense claim not found');
  return c;
}
const assertEditable = (a: TenantActor, c: Claim) => {
  if (c.employee_id !== a.user.employeeId) throw forbidden('Only the claimant can change this claim');
  if (!['draft', 'returned'].includes(c.status)) throw conflict(`A ${c.status} claim cannot be changed`);
};
async function recomputeTotal(db: Db, tenantId: string, claimId: string) {
  await db.query(`UPDATE expense_claims SET total=coalesce((SELECT sum(amount) FROM expense_items WHERE tenant_id=$1 AND claim_id=$2),0), version=version+1, updated_at=now()
    WHERE tenant_id=$1 AND id=$2`, [tenantId, claimId]);
}

/** Approval effects. Registered once at startup (core/runtime), whether or not the module's routes are. */
export function registerExpenseApprovals() {
  registerApprovalHandler('expense_claim', {
    feature: 'expenses', label: 'Expense claim', requesterLink: '/expenses',
    async onApproved(db, tenantId, id) {
      const r = await db.query(`UPDATE expense_claims SET status='approved', approved_at=now(), updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='submitted'`, [tenantId, id]);
      if (!r.rowCount) throw conflict('Claim is no longer awaiting approval');
      // A trip's claim first uses up the travel advance paid for it; only the rest is reimbursed.
      await setOffAdvance(db, tenantId, id);
    },
    async onRejected(db, tenantId, id, _actor, status) {
      await db.query(`UPDATE expense_claims SET status=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, id, status === 'returned' ? 'returned' : status]);
    },
  });
}

export async function expenseRoutes(app: FastifyInstance) {
  gateFeatures(app, 'expenses');

  await allowanceRoutes(app);

  // ------------------------------------------------------------ categories
  app.get('/categories', async (req) => {
    const a = tenantActorAny(req, 'expenses.self', 'expenses.manage', 'expenses.read');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'expenses');
      return { items: (await db.query(`SELECT id, code, name, description, requires_receipt, max_amount, gst_applicable, status, calc FROM expense_categories
        WHERE tenant_id=$1 AND ($2 OR status='active') ORDER BY name`, [a.tenantId, a.has('expenses.manage')])).rows };
    });
  });
  const catCols = (b: z.infer<typeof CategoryBody>) => [b.code, b.name, b.description ?? null, b.requiresReceipt, b.maxAmount, b.gstApplicable, b.status, b.calc];
  app.post('/categories', async (req, reply) => {
    const a = tenantActor(req, 'expenses.manage');
    const b = CategoryBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'expenses');
      const r = await db.query<{ id: string }>(`INSERT INTO expense_categories (tenant_id, code, name, description, requires_receipt, max_amount, gst_applicable, status, calc)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [a.tenantId, ...catCols(b)]);
      await audit(db, { ...a.auditBase, action: 'expenses.category_created', category: 'configuration', targetType: 'expense_category', targetId: r.rows[0]!.id, metadata: b });
      reply.code(201); return { id: r.rows[0]!.id };
    });
  });
  app.put('/categories/:id', async (req) => {
    const a = tenantActor(req, 'expenses.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const b = CategoryBody.parse(req.body);
    return a.tx(async (db) => {
      const r = await db.query(`UPDATE expense_categories SET code=$3, name=$4, description=$5, requires_receipt=$6, max_amount=$7, gst_applicable=$8, status=$9, calc=$10
        WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, ...catCols(b)]);
      if (!r.rowCount) throw notFound();
      await audit(db, { ...a.auditBase, action: 'expenses.category_updated', category: 'configuration', targetType: 'expense_category', targetId: id, metadata: b });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ claims
  app.post('/claims', async (req, reply) => {
    const a = tenantActor(req, 'expenses.self');
    const b = ClaimBody.parse(req.body);
    if (!a.user.employeeId) throw badRequest('Your account is not linked to an employee record');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'expenses');
      const r = await db.query<{ id: string }>(`INSERT INTO expense_claims (tenant_id, employee_id, title, purpose, project, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [a.tenantId, a.user.employeeId, b.title, b.purpose, b.project ?? null, a.user.userId]);
      reply.code(201); return { id: r.rows[0]!.id };
    });
  });

  app.get('/claims', async (req) => {
    const a = tenantActor(req);
    const q = PageQuery.extend({ scope: z.enum(['mine', 'team', 'all']).default('mine'), status: z.string().max(20).optional() }).parse(req.query);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'expenses');
      let ids: string[] | null = null;
      if (q.scope === 'mine') ids = a.user.employeeId ? [a.user.employeeId] : [];
      else if (q.scope === 'team') ids = a.has('expenses.team.read') && a.user.employeeId ? await teamEmployeeIds(db, a.tenantId, a.user.employeeId) : [];
      else if (!a.has('expenses.read') && !a.has('expenses.approve') && !a.has('expenses.pay')) throw forbidden();
      const params = [a.tenantId, ids, q.status ?? null];
      const where = `c.tenant_id=$1 AND ($2::uuid[] IS NULL OR c.employee_id = ANY($2)) AND ($3::text IS NULL OR c.status=$3)`;
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM expense_claims c WHERE ${where}`, params)).rows[0]!.n);
      const rows = await db.query(`SELECT c.id, c.title, c.status, c.total, c.advance_adjusted, c.travel_request_id, c.currency, c.created_at, c.submitted_at, c.approved_at, c.paid_at, c.payment_reference, c.employee_id,
          e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS employee_name,
          (SELECT count(*)::int FROM expense_items i WHERE i.tenant_id=c.tenant_id AND i.claim_id=c.id) AS items,
          (SELECT count(*)::int FROM expense_items i WHERE i.tenant_id=c.tenant_id AND i.claim_id=c.id AND i.duplicate_of IS NOT NULL) AS flagged
        FROM expense_claims c JOIN employees e ON e.tenant_id=c.tenant_id AND e.id=c.employee_id WHERE ${where} ORDER BY c.created_at DESC LIMIT $4 OFFSET $5`,
        [...params, q.pageSize, offsetOf(q)]);
      return paged(rows.rows, total, q);
    });
  });

  app.get('/claims/:id', async (req) => {
    const a = tenantActor(req);
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'expenses');
      await loadClaim(db, a, id);
      const claim = (await db.query(`SELECT c.*, e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS employee_name, ar.id AS approval_request_id
        FROM expense_claims c JOIN employees e ON e.tenant_id=c.tenant_id AND e.id=c.employee_id
        LEFT JOIN LATERAL (SELECT id FROM approval_requests WHERE tenant_id=c.tenant_id AND entity_type='expense_claim' AND entity_id=c.id ORDER BY created_at DESC LIMIT 1) ar ON true
        WHERE c.tenant_id=$1 AND c.id=$2`, [a.tenantId, id])).rows[0];
      const items = (await db.query(`SELECT i.id, i.expense_date, i.amount, i.description, i.merchant, i.invoice_number, i.gstin, i.receipt_name, i.receipt_key IS NOT NULL AS has_receipt,
          i.duplicate_of, c.name AS category_name, c.code AS category_code, c.calc, i.quantity, i.rate, i.tier, i.vehicle FROM expense_items i JOIN expense_categories c ON c.tenant_id=i.tenant_id AND c.id=i.category_id
        WHERE i.tenant_id=$1 AND i.claim_id=$2 ORDER BY i.expense_date, i.created_at`, [a.tenantId, id])).rows;
      return { ...claim, items, editable: ['draft', 'returned'].includes(claim.status) && claim.employee_id === a.user.employeeId };
    });
  });

  app.put('/claims/:id', async (req) => {
    const a = tenantActor(req, 'expenses.self');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const b = ClaimBody.parse(req.body);
    return a.tx(async (db) => {
      const c = await loadClaim(db, a, id, true);
      assertEditable(a, c);
      await db.query(`UPDATE expense_claims SET title=$3, purpose=$4, project=$5, version=version+1, updated_at=now() WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, b.title, b.purpose, b.project ?? null]);
      return { ok: true };
    });
  });

  /** multipart: categoryId, expenseDate, amount, description, merchant?, invoiceNumber?, gstin?, receipt (file)? */
  app.post('/claims/:id/items', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const a = tenantActor(req, 'expenses.self');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const fields: Record<string, string> = {}; let file: { buf: Buffer; name: string } | null = null;
    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const buf = await part.toBuffer().catch((e: { code?: string }) => { if (e.code === 'FST_REQ_FILE_TOO_LARGE') throw new AppError(413, 'file_too_large', 'Receipt is too large'); throw e; });
          if (buf.length) file = { buf, name: part.filename || 'receipt' };
        } else fields[part.fieldname] = String(part.value);
      }
    } else Object.assign(fields, req.body as Record<string, string>);
    const b = z.object({ categoryId: Uuid, expenseDate: IsoDate, amount: Money.optional(), description: z.string().trim().min(2).max(500),
      quantity: z.coerce.number().positive().optional(), tier: z.string().trim().toUpperCase().max(20).optional(), vehicle: z.enum(['car', 'two_wheeler']).optional(),
      merchant: z.string().trim().max(150).optional(), invoiceNumber: z.string().trim().max(50).optional(),
      gstin: z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z0-9]{13}$/, 'GSTIN must be 15 characters').optional() }).parse(
      Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== '')));
    const detected = file ? detectFile(file.buf, file.name) : null;
    if (detected && 'error' in detected) throw new AppError(415, 'unsupported_file', detected.error);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'expenses');
      const c = await loadClaim(db, a, id, true);
      assertEditable(a, c);
      const cat = (await db.query<{ name: string; requires_receipt: boolean; max_amount: string | null; status: string; gst_applicable: boolean; calc: 'per_diem' | 'mileage' | null }>(
        `SELECT name, requires_receipt, max_amount, status, gst_applicable, calc FROM expense_categories WHERE tenant_id=$1 AND id=$2`, [a.tenantId, b.categoryId])).rows[0];
      if (!cat || cat.status !== 'active') throw badRequest('Choose an active expense category');
      // Per diem and mileage are worked out from days or km and the organization's rate on the date.
      let priced: Awaited<ReturnType<typeof priceAllowance>> | null = null;
      if (cat.calc) {
        if (!b.quantity) throw badRequest(cat.calc === 'per_diem' ? 'Enter the number of days' : 'Enter the distance in km');
        priced = await priceAllowance(db, a.tenantId, { kind: cat.calc, employeeId: c.employee_id, date: b.expenseDate, quantity: new Decimal(b.quantity),
          tier: b.tier, vehicle: b.vehicle, claimed: b.amount ?? null });
        if (cat.calc === 'per_diem') {
          // On a trip's claim, per diem stays within the trip's dates and days.
          const trip = (await db.query<{ start_date: string; end_date: string; days: number; claimed: string }>(
            `SELECT t.start_date::text, t.end_date::text, (t.end_date - t.start_date + 1) AS days,
                    coalesce((SELECT sum(i.quantity) FROM expense_items i JOIN expense_categories k ON k.tenant_id=i.tenant_id AND k.id=i.category_id
                       WHERE i.tenant_id=x.tenant_id AND i.claim_id=x.id AND k.calc='per_diem'), 0)::text AS claimed
               FROM expense_claims x JOIN travel_requests t ON t.tenant_id=x.tenant_id AND t.id=x.travel_request_id WHERE x.tenant_id=$1 AND x.id=$2`, [a.tenantId, id])).rows[0];
          if (trip) {
            if (b.expenseDate < trip.start_date || b.expenseDate > trip.end_date) throw badRequest(`Per diem for this trip must fall between ${trip.start_date} and ${trip.end_date}`);
            if (new Decimal(trip.claimed).plus(b.quantity).gt(trip.days)) throw badRequest(`The trip lasts ${trip.days} day(s); ${trip.claimed} already claimed as per diem`);
          }
        }
      } else if (!b.amount) throw badRequest('Enter the amount');
      const amount = priced ? priced.amount : b.amount!;
      const { tz } = await employeeTimezone(db, a.tenantId, c.employee_id);
      const today = localDate(new Date(), tz);
      const window = await getSettingValue<number>(db, a.tenantId, 'expenses.claim_window_days');
      if (b.expenseDate > today) throw badRequest('Expense date cannot be in the future');
      if (daysBetween(b.expenseDate, today) > window) throw badRequest(`Expenses older than ${window} days cannot be claimed`);
      if (cat.max_amount !== null && amount.gt(cat.max_amount)) throw badRequest(`${cat.name} is limited to ${cat.max_amount} per item`);
      if (cat.requires_receipt && !file) throw badRequest(`${cat.name} needs a receipt`);
      if ((b.gstin && !b.invoiceNumber) || (b.invoiceNumber && cat.gst_applicable && !b.gstin)) throw badRequest('For GST invoices enter both the supplier GSTIN and the invoice number');
      if (b.gstin && b.invoiceNumber) {
        const dup = await db.query(`SELECT 1 FROM expense_items i JOIN expense_claims c ON c.tenant_id=i.tenant_id AND c.id=i.claim_id
          WHERE i.tenant_id=$1 AND i.gstin=$2 AND upper(i.invoice_number)=upper($3) AND c.status <> 'cancelled'`, [a.tenantId, b.gstin, b.invoiceNumber]);
        if (dup.rowCount) throw conflict('This invoice (GSTIN + invoice number) has already been claimed');
      }
      // Possible duplicate: same employee, date, amount and category on another live claim → flag for the approver.
      const similar = await db.query<{ id: string }>(`SELECT i.id FROM expense_items i JOIN expense_claims c ON c.tenant_id=i.tenant_id AND c.id=i.claim_id
        WHERE i.tenant_id=$1 AND c.employee_id=$2 AND i.expense_date=$3 AND i.amount=$4 AND i.category_id=$5 AND c.status NOT IN ('cancelled','rejected') LIMIT 1`,
        [a.tenantId, c.employee_id, b.expenseDate, amount.toFixed(2), b.categoryId]);
      let key: string | null = null;
      if (file && detected && !('error' in detected)) {
        const store = getStore();
        if (!store) throw new AppError(503, 'storage_unavailable', 'Receipt storage is not configured');
        key = newKey(a.tenantId, c.employee_id, 'expenses');
        await store.put(key, file.buf, detected.contentType);
      }
      const ins = await db.query<{ id: string }>(`INSERT INTO expense_items (tenant_id, claim_id, category_id, expense_date, amount, description, merchant, invoice_number, gstin,
          receipt_key, receipt_name, receipt_type, receipt_sha256, duplicate_of, quantity, rate, rate_id, tier, vehicle)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
        [a.tenantId, id, b.categoryId, b.expenseDate, amount.toFixed(2), b.description, b.merchant ?? null, b.invoiceNumber ?? null, b.gstin ?? null,
         key, file && detected && !('error' in detected) ? safeFileName(file.name, detected.ext) : null, detected && !('error' in detected) ? detected.contentType : null,
         file ? createHash('sha256').update(file.buf).digest('hex') : null, similar.rows[0]?.id ?? null,
         priced ? b.quantity : null, priced?.rate.rate ?? null, priced?.rate.id ?? null, priced && cat.calc === 'per_diem' ? b.tier : null, priced && cat.calc === 'mileage' ? b.vehicle : null]);
      await recomputeTotal(db, a.tenantId, id);
      reply.code(201); return { id: ins.rows[0]!.id, possibleDuplicate: !!similar.rowCount, ...(priced ? { amount: amount.toFixed(2), rate: priced.rate.rate, allowance: priced.allowance.toFixed(2) } : {}) };
    });
  });

  app.delete('/claims/:id/items/:itemId', async (req) => {
    const a = tenantActor(req, 'expenses.self');
    const { id, itemId } = z.object({ id: Uuid, itemId: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const c = await loadClaim(db, a, id, true);
      assertEditable(a, c);
      const r = await db.query(`DELETE FROM expense_items WHERE tenant_id=$1 AND claim_id=$2 AND id=$3`, [a.tenantId, id, itemId]);
      if (!r.rowCount) throw notFound();
      await recomputeTotal(db, a.tenantId, id);
      return { ok: true };
    });
  });

  app.get('/items/:itemId/receipt', async (req, reply) => {
    const a = tenantActor(req);
    const { itemId } = z.object({ itemId: Uuid }).parse(req.params);
    const item = await a.tx(async (db) => {
      const i = (await db.query<{ claim_id: string; receipt_key: string | null; receipt_name: string; receipt_type: string; receipt_sha256: string }>(
        `SELECT claim_id, receipt_key, receipt_name, receipt_type, receipt_sha256 FROM expense_items WHERE tenant_id=$1 AND id=$2`, [a.tenantId, itemId])).rows[0];
      if (!i?.receipt_key) throw notFound('Receipt not found');
      await loadClaim(db, a, i.claim_id);
      await audit(db, { ...a.auditBase, action: 'expenses.receipt_downloaded', category: 'access', targetType: 'expense_item', targetId: itemId });
      return i;
    });
    const buf = await getStore()!.get(item.receipt_key!);
    if (createHash('sha256').update(buf).digest('hex') !== item.receipt_sha256) throw new AppError(500, 'integrity_failed', 'The stored receipt failed its integrity check');
    return reply.header('content-type', item.receipt_type).header('content-disposition', `attachment; filename="${item.receipt_name.replace(/"/g, '')}"`)
      .header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').send(buf);
  });

  app.post('/claims/:id/submit', async (req) => {
    const a = tenantActor(req, 'expenses.self');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'expenses');
      const c = await loadClaim(db, a, id, true);
      assertEditable(a, c);
      const items = await db.query<{ n: number; missing: number }>(`SELECT count(*)::int AS n, count(*) FILTER (WHERE cat.requires_receipt AND i.receipt_key IS NULL)::int AS missing
        FROM expense_items i JOIN expense_categories cat ON cat.tenant_id=i.tenant_id AND cat.id=i.category_id WHERE i.tenant_id=$1 AND i.claim_id=$2`, [a.tenantId, id]);
      if (!items.rows[0]!.n) throw badRequest('Add at least one expense before submitting');
      if (items.rows[0]!.missing) throw badRequest('Some items need a receipt');
      await db.query(`UPDATE expense_claims SET status='submitted', submitted_at=now(), version=version+1, updated_at=now() WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      // Manager (if they have a login) then finance — two separate approvals.
      const mgr = await db.query<{ user_id: string | null }>(`SELECT m.user_id FROM employees e JOIN employees m ON m.tenant_id=e.tenant_id AND m.id=e.reporting_manager_id
        WHERE e.tenant_id=$1 AND e.id=$2 AND m.status IN ('active','on_notice')`, [a.tenantId, c.employee_id]);
      const steps: StepSpec[] = [];
      if (mgr.rows[0]?.user_id && mgr.rows[0].user_id !== a.user.userId) steps.push({ kind: 'user', userId: mgr.rows[0].user_id });
      steps.push({ kind: 'permission', permission: 'expenses.approve' });
      const total = (await db.query<{ total: string }>('SELECT total FROM expense_claims WHERE tenant_id=$1 AND id=$2', [a.tenantId, id])).rows[0]!.total;
      const claimant = (await db.query<{ user_id: string | null }>('SELECT user_id FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, c.employee_id])).rows[0]?.user_id;
      const reqId = await createApprovalRequest(db, a.tenantId, { entityType: 'expense_claim', entityId: id, requesterId: a.user.userId, summary: `${c.title}: ₹${total}`, steps, excludeUserIds: [claimant] });
      await audit(db, { ...a.auditBase, action: 'expenses.claim_submitted', targetType: 'expense_claim', targetId: id, metadata: { total, approvalRequestId: reqId } });
      return { ok: true, approvalRequestId: reqId };
    });
  });

  app.post('/claims/:id/cancel', async (req) => {
    const a = tenantActor(req, 'expenses.self');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const c = await loadClaim(db, a, id, true);
      if (c.employee_id !== a.user.employeeId) throw forbidden();
      if (!['draft', 'returned', 'submitted'].includes(c.status)) throw conflict(`A ${c.status} claim cannot be cancelled`);
      if (c.status === 'submitted') {
        const ar = (await db.query<{ id: string }>(`SELECT id FROM approval_requests WHERE tenant_id=$1 AND entity_type='expense_claim' AND entity_id=$2 AND status='pending'`, [a.tenantId, id])).rows[0];
        if (ar) await cancelRequest(db, a.tenantId, ar.id, a.user.userId, { requestId: req.id, ip: req.ctx.ip });
      }
      await db.query(`UPDATE expense_claims SET status='cancelled', updated_at=now() WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ payment (finance)
  app.get('/payables', async (req) => {
    const a = tenantActor(req, 'expenses.pay');
    return a.tx(async (db) => ({ items: (await db.query(`SELECT c.id, c.title, c.total, c.advance_adjusted, (c.total - c.advance_adjusted) AS payable, c.approved_at, e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS employee_name,
        (current_date - c.approved_at::date) AS age_days FROM expense_claims c JOIN employees e ON e.tenant_id=c.tenant_id AND e.id=c.employee_id
      WHERE c.tenant_id=$1 AND c.status='approved' AND c.batch_id IS NULL ORDER BY c.approved_at`, [a.tenantId])).rows }));
  });

  app.post('/batches', async (req, reply) => {
    const a = tenantActor(req, 'expenses.pay');
    const b = z.object({ claimIds: z.array(Uuid).min(1).max(500) }).parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'expenses');
      const claims = await db.query<{ id: string; total: string }>(`SELECT id, (total - advance_adjusted)::text AS total FROM expense_claims WHERE tenant_id=$1 AND id = ANY($2) AND status='approved' AND batch_id IS NULL FOR UPDATE`,
        [a.tenantId, b.claimIds]);
      if (claims.rowCount !== new Set(b.claimIds).size) throw conflict('Some claims are not approved or are already in a batch');
      const total = claims.rows.reduce((s, c) => s.plus(c.total), new Decimal(0));
      const batch = (await db.query<{ id: string }>(`INSERT INTO reimbursement_batches (tenant_id, total, claim_count, prepared_by) VALUES ($1,$2,$3,$4) RETURNING id`,
        [a.tenantId, total.toFixed(2), claims.rowCount, a.user.userId])).rows[0]!.id;
      await db.query(`UPDATE expense_claims SET batch_id=$3 WHERE tenant_id=$1 AND id = ANY($2)`, [a.tenantId, b.claimIds, batch]);
      await audit(db, { ...a.auditBase, action: 'expenses.batch_prepared', targetType: 'reimbursement_batch', targetId: batch, metadata: { claims: claims.rowCount, total: total.toFixed(2) } });
      reply.code(201); return { id: batch, total: total.toFixed(2) };
    });
  });

  app.get('/batches', async (req) => {
    const a = tenantActorAny(req, 'expenses.pay', 'expenses.read');
    return a.tx(async (db) => ({ items: (await db.query(`SELECT b.*, p.display_name AS prepared_by_name, ap.display_name AS approved_by_name, pd.display_name AS paid_by_name
      FROM reimbursement_batches b JOIN users p ON p.id=b.prepared_by LEFT JOIN users ap ON ap.id=b.approved_by LEFT JOIN users pd ON pd.id=b.paid_by
      WHERE b.tenant_id=$1 ORDER BY b.created_at DESC LIMIT 100`, [a.tenantId])).rows }));
  });

  const batchFor = async (db: Db, a: TenantActor, id: string) => {
    const b = (await db.query<{ id: string; status: string; prepared_by: string; total: string }>(`SELECT id, status, prepared_by, total FROM reimbursement_batches WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [a.tenantId, id])).rows[0];
    if (!b) throw notFound('Batch not found');
    return b;
  };

  app.post('/batches/:id/approve', async (req) => {
    const a = tenantActor(req, 'expenses.pay');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const b = await batchFor(db, a, id);
      if (b.status !== 'prepared') throw conflict(`Batch is already ${b.status}`);
      if (b.prepared_by === a.user.userId) throw forbidden('A different person must approve a batch they did not prepare (maker-checker)');
      await db.query(`UPDATE reimbursement_batches SET status='approved', approved_by=$3, approved_at=now() WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, a.user.userId]);
      await audit(db, { ...a.auditBase, action: 'expenses.batch_approved', targetType: 'reimbursement_batch', targetId: id, metadata: { total: b.total } });
      return { ok: true };
    });
  });

  app.post('/batches/:id/cancel', async (req) => {
    const a = tenantActor(req, 'expenses.pay');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const b = await batchFor(db, a, id);
      if (!['prepared', 'approved'].includes(b.status)) throw conflict(`A ${b.status} batch cannot be cancelled`);
      await db.query(`UPDATE expense_claims SET batch_id=NULL WHERE tenant_id=$1 AND batch_id=$2`, [a.tenantId, id]);
      await db.query(`UPDATE reimbursement_batches SET status='cancelled' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      await audit(db, { ...a.auditBase, action: 'expenses.batch_cancelled', targetType: 'reimbursement_batch', targetId: id });
      return { ok: true };
    });
  });

  app.post('/batches/:id/paid', async (req) => {
    const a = tenantActor(req, 'expenses.pay');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const body = z.object({ paymentReference: z.string().trim().min(3).max(100) }).parse(req.body);
    return a.tx(async (db) => {
      const b = await batchFor(db, a, id);
      if (b.status === 'paid') throw conflict('This batch is already recorded as paid');
      if (b.status !== 'approved') throw conflict('Only an approved batch can be marked paid');
      await db.query(`UPDATE reimbursement_batches SET status='paid', paid_by=$3, paid_at=now(), payment_reference=$4 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, a.user.userId, body.paymentReference]);
      const paid = await db.query<{ created_by: string; title: string; total: string }>(`UPDATE expense_claims SET status='paid', paid_at=now(), payment_reference=$3, updated_at=now()
        WHERE tenant_id=$1 AND batch_id=$2 AND status='approved' RETURNING created_by, title, (total - advance_adjusted)::text AS total`, [a.tenantId, id, body.paymentReference]);
      for (const c of paid.rows) {
        await notifyUsers(db, a.tenantId, [c.created_by], { kind: 'expenses.paid', title: `Expense claim reimbursed: ₹${c.total}`, body: `${c.title} · reference ${body.paymentReference}`, link: '/expenses' });
      }
      await audit(db, { ...a.auditBase, action: 'expenses.batch_paid', targetType: 'reimbursement_batch', targetId: id, metadata: { reference: body.paymentReference, claims: paid.rowCount, total: b.total } });
      return { ok: true, claimsPaid: paid.rowCount };
    });
  });

  /** CSV for the bank / accounting. Full account numbers only with employees.bank.read as well; always audited. */
  app.get('/batches/:id/export.csv', async (req, reply) => {
    const a = tenantActor(req, 'expenses.pay');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const full = a.has('employees.bank.read');
    const rows = await a.tx(async (db) => {
      const b = (await db.query<{ status: string }>(`SELECT status FROM reimbursement_batches WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id])).rows[0];
      if (!b) throw notFound('Batch not found');
      if (!['approved', 'paid'].includes(b.status)) throw conflict('Export is available once the batch is approved');
      const r = await db.query<{ employee_code: string; name: string; total: string; claims: number; account_holder: string | null; ifsc: string | null; account_last4: string | null; account_number_enc: string | null }>(
        `SELECT e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, sum(c.total - c.advance_adjusted)::text AS total, count(*)::int AS claims,
           ba.account_holder, ba.ifsc, ba.account_last4, ba.account_number_enc
         FROM expense_claims c JOIN employees e ON e.tenant_id=c.tenant_id AND e.id=c.employee_id
         LEFT JOIN employee_bank_accounts ba ON ba.tenant_id=e.tenant_id AND ba.employee_id=e.id
         WHERE c.tenant_id=$1 AND c.batch_id=$2 GROUP BY e.employee_code, name, ba.account_holder, ba.ifsc, ba.account_last4, ba.account_number_enc ORDER BY e.employee_code`, [a.tenantId, id]);
      await audit(db, { ...a.auditBase, action: 'expenses.batch_exported', category: 'access', targetType: 'reimbursement_batch', targetId: id, metadata: { fullAccountNumbers: full, rows: r.rowCount } });
      return r.rows;
    });
    const cell = (v: string | null | number) => { const s = v === null ? '' : String(v); return /^[=+\-@]/.test(s) ? `'${s}` : /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [['employee_code', 'name', 'amount', 'claims', 'account_holder', 'ifsc', 'account_number'].join(',')];
    for (const r of rows) {
      const acct = r.account_number_enc ? (full ? app.deps.cipher.decrypt(r.account_number_enc) : `XXXXXX${r.account_last4}`) : '';
      lines.push([r.employee_code, r.name, r.total, r.claims, r.account_holder, r.ifsc, acct].map(cell).join(','));
    }
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="reimbursements-${id.slice(0, 8)}.csv"`)
      .header('cache-control', 'private, no-store').send(lines.join('\r\n') + '\r\n');
  });

  // ------------------------------------------------------------ reports
  app.get('/reports/ageing', async (req) => {
    const a = tenantActorAny(req, 'expenses.read', 'expenses.pay');
    return a.tx(async (db) => {
      const buckets = (await db.query(`SELECT CASE WHEN age <= 7 THEN '0-7' WHEN age <= 15 THEN '8-15' WHEN age <= 30 THEN '16-30' ELSE '30+' END AS bucket,
          count(*)::int AS claims, sum(total)::text AS amount
        FROM (SELECT total, current_date - approved_at::date AS age FROM expense_claims WHERE tenant_id=$1 AND status='approved') x GROUP BY 1 ORDER BY min(age)`, [a.tenantId])).rows;
      const pending = (await db.query(`SELECT status, count(*)::int AS claims, coalesce(sum(total),0)::text AS amount FROM expense_claims
        WHERE tenant_id=$1 AND status IN ('submitted','approved') GROUP BY status`, [a.tenantId])).rows;
      const byCategory = (await db.query(`SELECT cat.name, count(*)::int AS items, sum(i.amount)::text AS amount FROM expense_items i
          JOIN expense_claims c ON c.tenant_id=i.tenant_id AND c.id=i.claim_id JOIN expense_categories cat ON cat.tenant_id=i.tenant_id AND cat.id=i.category_id
        WHERE i.tenant_id=$1 AND c.status IN ('approved','paid') AND i.expense_date >= date_trunc('month', current_date) - interval '2 months'
        GROUP BY cat.name ORDER BY sum(i.amount) DESC`, [a.tenantId])).rows;
      return { approvedUnpaidByAge: buckets, pipeline: pending, last3MonthsByCategory: byCategory };
    });
  });
}
