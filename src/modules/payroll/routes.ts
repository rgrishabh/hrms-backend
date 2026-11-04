import type { FastifyInstance } from 'fastify';
import { only } from '../../core/features/routes.js';
import { closeRepaid, enabledLoanKinds } from '../loans/service.js';
import { featureOn } from '../lifecycle/service.js';
import { z } from 'zod';
import { tenantActor, tenantActorAny, requireFeature, type TenantActor, gateFeatures } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { IsoDate, Uuid } from '../../core/http/pagination.js';
import { createApprovalRequest, registerApprovalHandler } from '../../core/workflow/engine.js';
import { notifyUsers } from '../../core/notify/service.js';
import { orgToday } from '../competency/service.js';
import type { Db } from '../../db/tx.js';
import { RULE_PARAMS, type RuleKind } from './calc.js';
import { attendanceLocked, computeRun, periodBounds, staleReason } from './service.js';
import { balancesAt } from '../leave/service.js';
import { csv } from '../../core/http/csv.js';
import { xlsx, XLSX_TYPE } from '../../core/http/xlsx.js';

const F = 'payroll';
const Period = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const Text = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v || null);
const ComponentBody = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{0,19}$/), name: z.string().trim().min(2).max(80), kind: z.enum(['earning', 'deduction']),
  calc: z.enum(['fixed', 'percent']).default('fixed'), baseCodes: z.array(z.string().toUpperCase()).max(10).default([]), prorate: z.boolean().default(true),
  taxable: z.boolean().default(true), pfWage: z.boolean().default(false), esiWage: z.boolean().default(true), position: z.number().int().min(0).max(999).default(0),
  status: z.enum(['active', 'inactive']).default('active'),
}).refine((c) => c.calc !== 'percent' || c.baseCodes.length > 0, { message: 'Percent components need base components', path: ['baseCodes'] });

async function loadRun(db: Db, a: TenantActor, id: string, lock = false) {
  const r = (await db.query<{ id: string; period: string; legal_entity_id: string; kind: string; employee_id: string | null; status: string; created_by: string; warnings: number; warnings_acknowledged: boolean; computed_at: Date | null; computed_by: string | null }>(
    `SELECT id, period, legal_entity_id, kind, employee_id, status, created_by, warnings, warnings_acknowledged, computed_at, computed_by FROM payroll_runs WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [a.tenantId, id])).rows[0];
  if (!r) throw notFound('Payroll run not found');
  return r;
}

/** A finalized or paid run has this employee in a month reaching `date`: that pay can no longer change. */
async function finalizedRunCovers(db: Db, tenantId: string, employeeId: string, date: string) {
  return ((await db.query(`SELECT 1 FROM payroll_runs r JOIN payroll_items i ON i.tenant_id=r.tenant_id AND i.run_id=r.id
    WHERE r.tenant_id=$1 AND i.employee_id=$2 AND r.status IN ('finalized','paid') AND (r.period||'-01')::date + interval '1 month' - interval '1 day' >= $3::date LIMIT 1`, [tenantId, employeeId, date])).rowCount ?? 0) > 0;
}
const COVERED_BY_FINALIZED = 'A finalized payroll already covers that date; use an adjustment (arrears) in the next run instead';

/** Approval effects. Registered once at startup (core/runtime), whether or not the module's routes are. */
export function registerPayrollApprovals() {
  registerApprovalHandler('salary_change', {
    feature: F, label: 'Salary change', requesterLink: '/payroll?tab=salaries',
    async onApproved(db, tenantId, id) {
      const s = (await db.query<{ employee_id: string; effective_from: string; status: string }>(`SELECT employee_id, effective_from::text, status FROM employee_salaries WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, id])).rows[0];
      if (!s || s.status !== 'pending') throw conflict('Salary change is no longer pending');
      if (await finalizedRunCovers(db, tenantId, s.employee_id, s.effective_from)) throw conflict(COVERED_BY_FINALIZED);
      await db.query(`UPDATE employee_salaries SET status='superseded' WHERE tenant_id=$1 AND employee_id=$2 AND status='active' AND effective_from=$3`, [tenantId, s.employee_id, s.effective_from]);
      await db.query(`UPDATE employee_salaries SET status='active', approved_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    },
    async onRejected(db, tenantId, id, _a, status) {
      await db.query(`UPDATE employee_salaries SET status=$3 WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [tenantId, id, status === 'rejected' ? 'rejected' : 'cancelled']);
    },
  });
  registerApprovalHandler('payroll_run', {
    feature: F, label: 'Payroll run', requesterLink: '/payroll?tab=runs',
    async onApproved(db, tenantId, id) {
      const r = await db.query(`UPDATE payroll_runs SET status='approved', approved_at=now() WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [tenantId, id]);
      if (!r.rowCount) throw conflict('Run is no longer pending');
    },
    async onRejected(db, tenantId, id) {
      await db.query(`UPDATE payroll_runs SET status='computed' WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [tenantId, id]);
    },
  });
}

export async function payrollRoutes(app: FastifyInstance) {
  gateFeatures(app, 'payroll');
  const cipher = app.deps.cipher;

  // ------------------------------------------------------------ components
  app.get('/components', async (req) => {
    const a = tenantActorAny(req, 'payroll.read', 'payroll.manage');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, F);
      return { items: (await db.query(`SELECT id, code, name, kind, calc, base_codes, prorate, taxable, pf_wage, esi_wage, position, status FROM pay_components WHERE tenant_id=$1 ORDER BY status, kind DESC, position, code`, [a.tenantId])).rows };
    });
  });
  async function saveComponent(db: Db, a: TenantActor, b: z.infer<typeof ComponentBody>, id?: string) {
    await requireFeature(db, a.tenantId, F);
    if (b.baseCodes.includes(b.code)) throw badRequest('A component cannot be a percent of itself');
    if (b.baseCodes.length) {
      const base = (await db.query<{ code: string; calc: string }>(`SELECT code, calc FROM pay_components WHERE tenant_id=$1 AND code = ANY($2::text[])`, [a.tenantId, b.baseCodes])).rows;
      if (base.length !== new Set(b.baseCodes).size) throw badRequest('Unknown base component');
      if (base.some((c) => c.calc !== 'fixed')) throw badRequest('Percent components can only be based on fixed components');
    }
    const cols = [b.code, b.name, b.kind, b.calc, b.calc === 'percent' ? b.baseCodes : [], b.prorate, b.taxable, b.pfWage, b.esiWage, b.position, b.status];
    if (id) {
      const r = await db.query(`UPDATE pay_components SET code=$3, name=$4, kind=$5, calc=$6, base_codes=$7, prorate=$8, taxable=$9, pf_wage=$10, esi_wage=$11, position=$12, status=$13 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, ...cols]);
      if (!r.rowCount) throw notFound();
    } else {
      id = (await db.query<{ id: string }>(`INSERT INTO pay_components (tenant_id, code, name, kind, calc, base_codes, prorate, taxable, pf_wage, esi_wage, position, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [a.tenantId, ...cols])).rows[0]!.id;
    }
    await audit(db, { ...a.auditBase, action: 'payroll.component_saved', category: 'configuration', targetType: 'pay_component', targetId: id, metadata: b });
    return id;
  }
  app.post('/components', async (req, reply) => {
    const a = tenantActor(req, 'payroll.manage');
    const b = ComponentBody.parse(req.body);
    return a.tx(async (db) => { const id = await saveComponent(db, a, b); reply.code(201); return { id }; });
  });
  app.put('/components/:id', async (req) => {
    const a = tenantActor(req, 'payroll.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const b = ComponentBody.parse(req.body);
    return a.tx(async (db) => { await saveComponent(db, a, b, id); return { ok: true }; });
  });

  // ------------------------------------------------------------ salaries (maker-checker)
  app.get('/employees/:id/salaries', async (req) => {
    const a = tenantActorAny(req, 'payroll.read', 'payroll.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, F);
      return { items: (await db.query(`SELECT s.id, s.effective_from::text, s.amounts, s.annual_ctc, s.reason, s.status, s.created_at, s.approved_at, u.display_name AS created_by_name
        FROM employee_salaries s JOIN users u ON u.id=s.created_by WHERE s.tenant_id=$1 AND s.employee_id=$2 ORDER BY s.effective_from DESC, s.created_at DESC`, [a.tenantId, id])).rows };
    });
  });
  app.post('/employees/:id/salaries', async (req, reply) => {
    const a = tenantActor(req, 'payroll.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const b = z.object({ effectiveFrom: IsoDate, amounts: z.record(z.string().toUpperCase(), z.number().min(0).max(1e8)).refine((o) => Object.keys(o).length > 0, 'Add at least one component'),
      annualCtc: z.number().positive().nullable().default(null), reason: z.string().trim().min(3).max(500) }).parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, F);
      const e = (await db.query<{ name: string; user_id: string | null }>(`SELECT trim(first_name||' '||coalesce(last_name,'')) AS name, user_id FROM employees WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id])).rows[0];
      if (!e) throw notFound('Employee not found');
      if (e.user_id === a.user.userId) throw forbidden('You cannot change your own salary');
      const comps = (await db.query<{ code: string; calc: string }>(`SELECT code, calc FROM pay_components WHERE tenant_id=$1 AND status='active' AND code = ANY($2::text[])`, [a.tenantId, Object.keys(b.amounts)])).rows;
      const unknown = Object.keys(b.amounts).filter((k) => !comps.some((c) => c.code === k));
      if (unknown.length) throw badRequest(`Unknown or inactive components: ${unknown.join(', ')}`);
      for (const c of comps) if (c.calc === 'percent' && b.amounts[c.code]! > 100) throw badRequest(`${c.code} is a percentage (0–100)`);
      if (await finalizedRunCovers(db, a.tenantId, id, b.effectiveFrom)) throw conflict(COVERED_BY_FINALIZED);
      const sid = (await db.query<{ id: string }>(`INSERT INTO employee_salaries (tenant_id, employee_id, effective_from, amounts, annual_ctc, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [a.tenantId, id, b.effectiveFrom, JSON.stringify(b.amounts), b.annualCtc, b.reason, a.user.userId])).rows[0]!.id;
      // No figures in the summary: it goes into notifications and email.
      await createApprovalRequest(db, a.tenantId, { entityType: 'salary_change', entityId: sid, requesterId: a.user.userId,
        summary: `${e.name}: salary effective ${b.effectiveFrom} — ${b.reason}`, steps: [{ kind: 'permission', permission: 'payroll.approve' }],
        excludeUserIds: [e.user_id] }); // nobody approves their own salary
      await audit(db, { ...a.auditBase, action: 'payroll.salary_proposed', category: 'data', targetType: 'employee', targetId: id, metadata: { salaryId: sid, effectiveFrom: b.effectiveFrom, components: Object.keys(b.amounts) } });
      reply.code(201); return { id: sid };
    });
  });

  // ------------------------------------------------------------ employee statutory details
  only(app, 'payroll.statutory').get('/employees/:id/statutory', async (req) => {
    const a = tenantActorAny(req, 'payroll.read', 'payroll.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, F);
      const s = (await db.query(`SELECT uan, pf_member_id, pf_excluded, esi_ip_number, pan_last4, tax_regime, pt_state, updated_at FROM employee_statutory WHERE tenant_id=$1 AND employee_id=$2`, [a.tenantId, id])).rows[0];
      return s ? { ...s, pan: s.pan_last4 ? `XXXXXX${s.pan_last4}` : null } : { uan: null, pf_member_id: null, pf_excluded: false, esi_ip_number: null, pan: null, tax_regime: 'new', pt_state: null };
    });
  });
  only(app, 'payroll.statutory').put('/employees/:id/statutory', async (req) => {
    const a = tenantActor(req, 'payroll.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    // Only what is sent changes: an omitted field keeps its value, null clears it.
    const b = z.object({ uan: z.string().regex(/^[0-9]{12}$/).nullable().optional(), pfMemberId: z.string().trim().max(40).nullable().optional(), pfExcluded: z.boolean().optional(),
      esiIpNumber: z.string().regex(/^[0-9]{10}$/).nullable().optional(), pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'PAN format: AAAAA9999A').optional(),
      taxRegime: z.enum(['new', 'old']).optional(), ptState: z.string().trim().max(60).nullable().optional() }).parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, F);
      if (!(await db.query('SELECT 1 FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, id])).rowCount) throw notFound('Employee not found');
      const cur = (await db.query<{ uan: string | null; pf_member_id: string | null; pf_excluded: boolean; esi_ip_number: string | null; tax_regime: string; pt_state: string | null }>(
        'SELECT uan, pf_member_id, pf_excluded, esi_ip_number, tax_regime, pt_state FROM employee_statutory WHERE tenant_id=$1 AND employee_id=$2 FOR UPDATE', [a.tenantId, id])).rows[0];
      const uan = b.uan === undefined ? cur?.uan ?? null : b.uan; const pfExcluded = b.pfExcluded ?? cur?.pf_excluded ?? false;
      const pfMemberId = b.pfMemberId === undefined ? cur?.pf_member_id ?? null : b.pfMemberId || null;
      const esiIpNumber = b.esiIpNumber === undefined ? cur?.esi_ip_number ?? null : b.esiIpNumber;
      const taxRegime = b.taxRegime ?? cur?.tax_regime ?? 'new';
      const ptState = b.ptState === undefined ? cur?.pt_state ?? null : b.ptState || null;
      await db.query(`INSERT INTO employee_statutory (tenant_id, employee_id, uan, pf_member_id, pf_excluded, esi_ip_number, pan_enc, pan_last4, tax_regime, pt_state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (tenant_id, employee_id) DO UPDATE SET uan=EXCLUDED.uan, pf_member_id=EXCLUDED.pf_member_id, pf_excluded=EXCLUDED.pf_excluded, esi_ip_number=EXCLUDED.esi_ip_number,
          pan_enc=coalesce(EXCLUDED.pan_enc, employee_statutory.pan_enc), pan_last4=coalesce(EXCLUDED.pan_last4, employee_statutory.pan_last4),
          tax_regime=EXCLUDED.tax_regime, pt_state=EXCLUDED.pt_state, updated_at=now()`,
        [a.tenantId, id, uan, pfMemberId, pfExcluded, esiIpNumber, b.pan ? cipher.encrypt(b.pan) : null, b.pan ? b.pan.slice(-5, -1) : null, taxRegime, ptState]);
      await audit(db, { ...a.auditBase, action: 'payroll.statutory_details_updated', category: 'data', targetType: 'employee', targetId: id,
        metadata: { uanSet: !!uan, panChanged: !!b.pan, pfExcluded, taxRegime, ptState } });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ statutory rule register
  only(app, 'payroll.statutory').get('/statutory-rules', async (req) => {
    const a = tenantActorAny(req, 'payroll.read', 'payroll.statutory');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'payroll.statutory');
      return { items: (await db.query(`SELECT r.id, r.kind, r.scope, r.effective_from::text, r.effective_to::text, r.params, r.source_reference, r.status, r.created_at, r.verified_at,
          cu.display_name AS created_by_name, vu.display_name AS verified_by_name, r.created_by
        FROM statutory_rules r JOIN users cu ON cu.id=r.created_by LEFT JOIN users vu ON vu.id=r.verified_by WHERE r.tenant_id=$1 ORDER BY r.kind, r.scope, r.effective_from DESC`, [a.tenantId])).rows };
    });
  });
  const RuleBody = z.object({ kind: z.enum(['pf', 'esi', 'pt', 'lwf', 'tds']), scope: z.string().trim().min(2).max(60), effectiveFrom: IsoDate, effectiveTo: IsoDate.nullable().default(null),
    params: z.unknown(), sourceReference: z.string().trim().min(5).max(500) });
  function checkRule(b: z.infer<typeof RuleBody>) {
    const p = RULE_PARAMS[b.kind].safeParse(b.params);
    if (!p.success) throw badRequest(`Invalid ${b.kind.toUpperCase()} parameters: ${p.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    if (b.kind === 'tds' && !['new', 'old'].includes(b.scope)) throw badRequest('TDS scope is the regime: new or old');
    if (['pf', 'esi'].includes(b.kind) && b.scope !== 'IN') throw badRequest('PF and ESI rules are national: scope IN');
    return p.data;
  }
  only(app, 'payroll.statutory').post('/statutory-rules', async (req, reply) => {
    const a = tenantActor(req, 'payroll.statutory');
    const b = RuleBody.parse(req.body);
    const params = checkRule(b);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'payroll.statutory');
      const id = (await db.query<{ id: string }>(`INSERT INTO statutory_rules (tenant_id, kind, scope, effective_from, effective_to, params, source_reference, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [a.tenantId, b.kind, b.scope, b.effectiveFrom, b.effectiveTo, JSON.stringify(params), b.sourceReference, a.user.userId])).rows[0]!.id;
      await audit(db, { ...a.auditBase, action: 'payroll.rule_drafted', category: 'configuration', targetType: 'statutory_rule', targetId: id, metadata: { ...b, params } });
      reply.code(201); return { id };
    });
  });
  only(app, 'payroll.statutory').put('/statutory-rules/:id', async (req) => {
    const a = tenantActor(req, 'payroll.statutory');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const b = RuleBody.parse(req.body);
    const params = checkRule(b);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'payroll.statutory');
      const r = await db.query(`UPDATE statutory_rules SET kind=$3, scope=$4, effective_from=$5, effective_to=$6, params=$7, source_reference=$8, created_by=$9 WHERE tenant_id=$1 AND id=$2 AND status='draft'`,
        [a.tenantId, id, b.kind, b.scope, b.effectiveFrom, b.effectiveTo, JSON.stringify(params), b.sourceReference, a.user.userId]);
      if (!r.rowCount) throw conflict('Only draft rules can be edited; retire and replace an active rule');
      await audit(db, { ...a.auditBase, action: 'payroll.rule_updated', category: 'configuration', targetType: 'statutory_rule', targetId: id, metadata: { ...b, params } });
      return { ok: true };
    });
  });
  /** A second person checks the values against the cited source and activates the rule. */
  only(app, 'payroll.statutory').post('/statutory-rules/:id/verify', async (req) => {
    const a = tenantActor(req, 'payroll.statutory');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'payroll.statutory');
      const r = (await db.query<{ created_by: string; status: string; kind: RuleKind; scope: string; effective_from: string }>(`SELECT created_by, status, kind, scope, effective_from::text FROM statutory_rules WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [a.tenantId, id])).rows[0];
      if (!r) throw notFound();
      if (r.status !== 'draft') throw conflict(`Rule is ${r.status}`);
      if (r.created_by === a.user.userId) throw forbidden('Rules must be verified by someone other than the person who entered them');
      // Close the previous active rule of the same kind/scope the day before this one starts.
      await db.query(`UPDATE statutory_rules SET effective_to=($5::date - 1) WHERE tenant_id=$1 AND kind=$2 AND lower(scope)=lower($3) AND status='active' AND id<>$4
        AND effective_from < $5::date AND (effective_to IS NULL OR effective_to >= $5::date)`, [a.tenantId, r.kind, r.scope, id, r.effective_from]);
      await db.query(`UPDATE statutory_rules SET status='active', verified_by=$3, verified_at=now() WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, a.user.userId]);
      await audit(db, { ...a.auditBase, action: 'payroll.rule_verified', category: 'configuration', targetType: 'statutory_rule', targetId: id });
      return { ok: true };
    });
  });
  only(app, 'payroll.statutory').post('/statutory-rules/:id/retire', async (req) => {
    const a = tenantActor(req, 'payroll.statutory');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'payroll.statutory');
      const r = await db.query(`UPDATE statutory_rules SET status='retired' WHERE tenant_id=$1 AND id=$2 AND status IN ('draft','active')`, [a.tenantId, id]);
      if (!r.rowCount) throw notFound();
      await audit(db, { ...a.auditBase, action: 'payroll.rule_retired', category: 'configuration', targetType: 'statutory_rule', targetId: id });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ runs
  app.get('/runs', async (req) => {
    const a = tenantActorAny(req, 'payroll.read', 'payroll.manage', 'payroll.approve');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, F);
      return { items: (await db.query(`SELECT r.id, r.period, r.kind, r.status, r.totals, r.warnings, r.warnings_acknowledged, r.computed_at, r.finalized_at, r.paid_at, r.payment_reference,
          le.name AS legal_entity_name, trim(e.first_name||' '||coalesce(e.last_name,'')) AS employee_name, u.display_name AS created_by_name
        FROM payroll_runs r JOIN legal_entities le ON le.tenant_id=r.tenant_id AND le.id=r.legal_entity_id LEFT JOIN employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id
        JOIN users u ON u.id=r.created_by WHERE r.tenant_id=$1 ORDER BY r.period DESC, r.created_at DESC LIMIT 100`, [a.tenantId])).rows };
    });
  });
  app.post('/runs', async (req, reply) => {
    const a = tenantActor(req, 'payroll.manage');
    const b = z.object({ period: Period, legalEntityId: Uuid, kind: z.enum(['regular', 'fnf']).default('regular'), employeeId: Uuid.optional() })
      .refine((r) => r.kind !== 'fnf' || r.employeeId, { message: 'F&F runs are for one employee', path: ['employeeId'] }).parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, F);
      if (!(await db.query('SELECT 1 FROM legal_entities WHERE tenant_id=$1 AND id=$2', [a.tenantId, b.legalEntityId])).rowCount) throw badRequest('Unknown legal entity');
      if (b.kind === 'fnf') {
        const sep = await db.query(`SELECT 1 FROM separations WHERE tenant_id=$1 AND employee_id=$2 AND status IN ('approved','completed')`, [a.tenantId, b.employeeId]);
        if (!sep.rowCount) throw conflict('F&F needs an approved separation');
        // One settlement per leaver: the employee row serializes two people creating it at once.
        await db.query('SELECT 1 FROM employees WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, b.employeeId]);
        const existing = await db.query<{ period: string }>(`SELECT period FROM payroll_runs WHERE tenant_id=$1 AND kind='fnf' AND employee_id=$2 AND status <> 'cancelled' LIMIT 1`, [a.tenantId, b.employeeId]);
        if (existing.rowCount) throw conflict(`This employee already has an F&F run for ${existing.rows[0]!.period}; cancel it before creating another`);
      }
      const id = (await db.query<{ id: string }>(`INSERT INTO payroll_runs (tenant_id, legal_entity_id, period, kind, employee_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [a.tenantId, b.legalEntityId, b.period, b.kind, b.employeeId ?? null, a.user.userId])).rows[0]!.id;
      if (b.kind === 'fnf') await db.query(`UPDATE separations SET fnf_status='in_progress' WHERE tenant_id=$1 AND employee_id=$2 AND status IN ('approved','completed') AND fnf_status='not_started'`, [a.tenantId, b.employeeId]);
      await audit(db, { ...a.auditBase, action: 'payroll.run_created', targetType: 'payroll_run', targetId: id, metadata: b });
      reply.code(201); return { id };
    });
  });

  app.post('/runs/:id/compute', async (req) => {
    const a = tenantActor(req, 'payroll.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, F);
      const r = await loadRun(db, a, id, true);
      if (!['draft', 'computed'].includes(r.status)) throw conflict(`A ${r.status} run cannot be recomputed`);
      const res = await computeRun(db, a.tenantId, id);
      await db.query('UPDATE payroll_runs SET computed_by=$3 WHERE tenant_id=$1 AND id=$2', [a.tenantId, id, a.user.userId]);
      await audit(db, { ...a.auditBase, action: 'payroll.run_computed', targetType: 'payroll_run', targetId: id, metadata: { ...res.totals, warnings: res.warnings } });
      return res;
    });
  });

  app.get('/runs/:id', async (req) => {
    const a = tenantActorAny(req, 'payroll.read', 'payroll.manage', 'payroll.approve');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, F);
      const run = (await db.query(`SELECT r.*, le.name AS legal_entity_name FROM payroll_runs r JOIN legal_entities le ON le.tenant_id=r.tenant_id AND le.id=r.legal_entity_id WHERE r.tenant_id=$1 AND r.id=$2`, [a.tenantId, id])).rows[0];
      if (!run) throw notFound('Payroll run not found');
      const items = (await db.query(`SELECT i.id, i.employee_id, e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS employee_name, i.employed_days, i.lop_days, i.paid_days,
          i.gross, i.deductions, i.net, i.employer_cost, i.warnings, i.hold, i.lines
        FROM payroll_items i JOIN employees e ON e.tenant_id=i.tenant_id AND e.id=i.employee_id WHERE i.tenant_id=$1 AND i.run_id=$2 ORDER BY e.employee_code`, [a.tenantId, id])).rows;
      const adjustments = (await db.query(`SELECT a.id, a.employee_id, a.kind, a.label, a.amount, a.taxable, a.note, u.display_name AS created_by_name FROM payroll_adjustments a JOIN users u ON u.id=a.created_by
        WHERE a.tenant_id=$1 AND a.run_id=$2 ORDER BY a.created_at`, [a.tenantId, id])).rows;
      const locked = await attendanceLocked(db, a.tenantId, run.period);
      return { ...run, items, adjustments, attendanceLocked: locked };
    });
  });

  app.post('/runs/:id/adjustments', async (req, reply) => {
    const a = tenantActor(req, 'payroll.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const b = z.object({ employeeId: Uuid, kind: z.enum(['earning', 'deduction', 'lop_days']), label: z.string().trim().min(2).max(80), amount: z.number().refine((v) => v !== 0, 'Not zero'),
      taxable: z.boolean().default(true), note: Text(500) }).refine((x) => x.kind === 'lop_days' || x.amount > 0, { message: 'Amounts are positive; choose earning or deduction', path: ['amount'] }).parse(req.body);
    return a.tx(async (db) => {
      const r = await loadRun(db, a, id, true);
      if (!['draft', 'computed'].includes(r.status)) throw conflict(`A ${r.status} run cannot be adjusted`);
      if (r.kind === 'fnf' && b.employeeId !== r.employee_id) throw badRequest('This F&F run is for another employee');
      const aid = (await db.query<{ id: string }>(`INSERT INTO payroll_adjustments (tenant_id, run_id, employee_id, kind, label, amount, taxable, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [a.tenantId, id, b.employeeId, b.kind, b.label, b.amount, b.taxable, b.note, a.user.userId])).rows[0]!.id;
      await db.query(`UPDATE payroll_runs SET status='draft' WHERE tenant_id=$1 AND id=$2 AND status='computed'`, [a.tenantId, id]);  // must recompute
      await audit(db, { ...a.auditBase, action: 'payroll.adjustment_added', targetType: 'payroll_run', targetId: id, metadata: b });
      reply.code(201); return { id: aid };
    });
  });
  app.delete('/runs/:id/adjustments/:adjId', async (req) => {
    const a = tenantActor(req, 'payroll.manage');
    const p = z.object({ id: Uuid, adjId: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const r = await loadRun(db, a, p.id, true);
      if (!['draft', 'computed'].includes(r.status)) throw conflict(`A ${r.status} run cannot be adjusted`);
      const d = await db.query('DELETE FROM payroll_adjustments WHERE tenant_id=$1 AND run_id=$2 AND id=$3', [a.tenantId, p.id, p.adjId]);
      if (!d.rowCount) throw notFound();
      await db.query(`UPDATE payroll_runs SET status='draft' WHERE tenant_id=$1 AND id=$2 AND status='computed'`, [a.tenantId, p.id]);
      await audit(db, { ...a.auditBase, action: 'payroll.adjustment_removed', targetType: 'payroll_run', targetId: p.id, metadata: { adjustmentId: p.adjId } });
      return { ok: true };
    });
  });

  app.post('/runs/:id/hold', async (req) => {
    const a = tenantActor(req, 'payroll.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const b = z.object({ employeeId: Uuid, hold: z.boolean() }).parse(req.body);
    return a.tx(async (db) => {
      const r = await loadRun(db, a, id, true);
      if (r.status !== 'computed') throw conflict('Compute the run first');
      const u = await db.query('UPDATE payroll_items SET hold=$4 WHERE tenant_id=$1 AND run_id=$2 AND employee_id=$3 AND (net >= 0 OR $4)', [a.tenantId, id, b.employeeId, b.hold]);
      if (!u.rowCount) throw conflict('Item not found, or its net pay is negative (keep it on hold)');
      await audit(db, { ...a.auditBase, action: 'payroll.item_hold', targetType: 'payroll_run', targetId: id, metadata: b });
      return { ok: true };
    });
  });

  /**
   * Pays out an item held at finalize. A payroll approver decides, not the person who prepared the run; the item leaves
   * the hold, the employee gets their payslip, and it goes out in its own bank file so the run's file never changes.
   */
  app.post('/runs/:id/items/:employeeId/release', async (req) => {
    const a = tenantActor(req, 'payroll.approve');
    const { id, employeeId } = z.object({ id: Uuid, employeeId: Uuid }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body);
    return a.tx(async (db) => {
      const r = await loadRun(db, a, id, true);
      if (!['finalized', 'paid'].includes(r.status)) throw conflict('Only held pay in a finalized run is released here; before that, take it off hold');
      if (employeeId === a.user.employeeId) throw forbidden('You cannot release your own held pay');
      if (r.computed_by === a.user.userId) throw forbidden('Someone other than the person who computed this run must release it');
      const u = await db.query(`UPDATE payroll_items SET hold=false, hold_released_at=now(), hold_released_by=$4, hold_release_reason=$5 WHERE tenant_id=$1 AND run_id=$2 AND employee_id=$3 AND hold AND net >= 0`,
        [a.tenantId, id, employeeId, a.user.userId, reason]);
      if (!u.rowCount) throw conflict('No held pay to release for this employee (or its net pay is negative)');
      if (enabledLoanKinds().length) await closeRepaid(db, a.tenantId, [employeeId]);
      const user = (await db.query<{ user_id: string | null }>('SELECT user_id FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, employeeId])).rows[0]?.user_id;
      if (user) await notifyUsers(db, a.tenantId, [user], { kind: 'payroll.payslip', title: `Your payslip for ${r.period} is available`, body: 'Open HRMS to view or print it.', link: '/payslips', actionLabel: 'View payslip', dedupeKey: `payslip:${id}:${employeeId}` });
      await audit(db, { ...a.auditBase, action: 'payroll.hold_released', category: 'security', targetType: 'payroll_run', targetId: id, metadata: { employeeId, reason } });
      return { ok: true };
    });
  });

  app.post('/runs/:id/acknowledge-warnings', async (req) => {
    const a = tenantActor(req, 'payroll.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const { note } = z.object({ note: z.string().trim().min(5).max(1000) }).parse(req.body);
    return a.tx(async (db) => {
      const r = await loadRun(db, a, id, true);
      if (r.status !== 'computed') throw conflict('Compute the run first');
      await db.query(`UPDATE payroll_runs SET warnings_acknowledged=true WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      await audit(db, { ...a.auditBase, action: 'payroll.warnings_acknowledged', targetType: 'payroll_run', targetId: id, metadata: { warnings: r.warnings, note } });
      return { ok: true };
    });
  });

  app.post('/runs/:id/submit', async (req) => {
    const a = tenantActor(req, 'payroll.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const r = await loadRun(db, a, id, true);
      if (r.status !== 'computed') throw conflict('Compute the run before submitting');
      if (r.warnings > 0 && !r.warnings_acknowledged) throw conflict(`The run has ${r.warnings} warning(s); review and acknowledge them first`);
      await db.query(`UPDATE payroll_runs SET status='pending' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      // Maker-checker covers everyone who shaped the figures, not only the person pressing submit.
      const makers = (await db.query<{ user_id: string | null }>(`SELECT computed_by AS user_id FROM payroll_runs WHERE tenant_id=$1 AND id=$2
        UNION SELECT created_by FROM payroll_adjustments WHERE tenant_id=$1 AND run_id=$2`, [a.tenantId, id])).rows.map((x) => x.user_id);
      await createApprovalRequest(db, a.tenantId, { entityType: 'payroll_run', entityId: id, requesterId: a.user.userId,
        summary: `Payroll ${r.period}${r.kind === 'fnf' ? ' (F&F)' : ''} — review the register before approving`, steps: [{ kind: 'permission', permission: 'payroll.approve' }], excludeUserIds: makers });
      await audit(db, { ...a.auditBase, action: 'payroll.run_submitted', targetType: 'payroll_run', targetId: id });
      return { ok: true };
    });
  });

  /** Locks the run: items can no longer change (database trigger), payslips become visible. */
  app.post('/runs/:id/finalize', async (req) => {
    const a = tenantActor(req, 'payroll.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const r = await loadRun(db, a, id, true);
      if (r.status !== 'approved') throw conflict('Only an approved run can be finalized');
      if (r.kind === 'regular' && !(await attendanceLocked(db, a.tenantId, r.period))) throw conflict(`Lock attendance for ${r.period} before finalizing payroll`);
      const stale = await staleReason(db, a.tenantId, r);
      if (stale) throw conflict(`${stale}. Reopen the run, recompute it and send it for approval again.`);
      await db.query(`UPDATE payroll_runs SET status='finalized', finalized_at=now() WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      // Loans whose last instalment was in this run are now fully recovered.
      if (enabledLoanKinds().length) await closeRepaid(db, a.tenantId, (await db.query<{ employee_id: string }>(`SELECT employee_id FROM payroll_items WHERE tenant_id=$1 AND run_id=$2`, [a.tenantId, id])).rows.map((x) => x.employee_id));
      const users = (await db.query<{ user_id: string }>(`SELECT e.user_id FROM payroll_items i JOIN employees e ON e.tenant_id=i.tenant_id AND e.id=i.employee_id
        WHERE i.tenant_id=$1 AND i.run_id=$2 AND NOT i.hold AND e.user_id IS NOT NULL`, [a.tenantId, id])).rows.map((x) => x.user_id);
      await notifyUsers(db, a.tenantId, users, { kind: 'payroll.payslip', title: `Your payslip for ${r.period} is available`, body: 'Open HRMS to view or print it.', link: '/payslips', actionLabel: 'View payslip', dedupeKey: `payslip:${id}` });
      await audit(db, { ...a.auditBase, action: 'payroll.run_finalized', targetType: 'payroll_run', targetId: id, metadata: { payslips: users.length } });
      return { ok: true, payslips: users.length };
    });
  });

  /** Back to draft from approved, for a result that is out of date: it is recomputed and approved again. */
  app.post('/runs/:id/reopen', async (req) => {
    const a = tenantActor(req, 'payroll.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const r = await loadRun(db, a, id, true);
      if (r.status !== 'approved') throw conflict('Only an approved run can be reopened');
      await db.query(`UPDATE payroll_runs SET status='draft', approved_at=NULL WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      await audit(db, { ...a.auditBase, action: 'payroll.run_reopened', targetType: 'payroll_run', targetId: id });
      return { ok: true };
    });
  });

  app.post('/runs/:id/paid', async (req) => {
    const a = tenantActor(req, 'payroll.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const { paymentReference } = z.object({ paymentReference: z.string().trim().min(3).max(100) }).parse(req.body);
    return a.tx(async (db) => {
      const r = await loadRun(db, a, id, true);
      if (r.status !== 'finalized') throw conflict('Finalize the run first');
      await db.query(`UPDATE payroll_runs SET status='paid', paid_at=now(), payment_reference=$3 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, paymentReference]);
      if (r.kind === 'fnf') await db.query(`UPDATE separations SET fnf_status='settled', fnf_note=coalesce(fnf_note, 'F&F paid: '||$3) WHERE tenant_id=$1 AND employee_id=$2 AND status IN ('approved','completed')`, [a.tenantId, r.employee_id, paymentReference]);
      await audit(db, { ...a.auditBase, action: 'payroll.run_paid', targetType: 'payroll_run', targetId: id, metadata: { paymentReference } });
      return { ok: true };
    });
  });

  app.post('/runs/:id/cancel', async (req) => {
    const a = tenantActor(req, 'payroll.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const r = await loadRun(db, a, id, true);
      if (!['draft', 'computed'].includes(r.status)) throw conflict(`A ${r.status} run cannot be cancelled`);
      await db.query(`UPDATE payroll_runs SET status='cancelled' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      await audit(db, { ...a.auditBase, action: 'payroll.run_cancelled', targetType: 'payroll_run', targetId: id });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ exports (finalized runs)
  // Statutory and bank files keep their CSV layouts; the salary register is also offered as an Excel workbook.
  const exportRun = (name: string, build: (db: Db, a: TenantActor, run: { id: string; period: string }) => Promise<unknown[][]>, perm = 'payroll.read', formats: readonly ('csv' | 'xlsx')[] = ['csv']) =>
    formats.forEach((format) => app.get(`/runs/:id/${name}.${format}`, async (req, reply) => {
      const a = tenantActorAny(req, perm, 'payroll.manage');
      const { id } = z.object({ id: Uuid }).parse(req.params);
      const { rows, period } = await a.tx(async (db) => {
        await requireFeature(db, a.tenantId, F);
        const r = await loadRun(db, a, id);
        if (!['finalized', 'paid'].includes(r.status) && name !== 'register') throw conflict('Exports are available once the run is finalized');
        const rows = await build(db, a, r);
        await audit(db, { ...a.auditBase, action: `payroll.export_${name}`, category: 'access', targetType: 'payroll_run', targetId: id, metadata: { rows: rows.length - 1, format } });
        return { rows, period: r.period };
      });
      const file = `payroll-${period}-${name}.${format}`;
      if (format === 'xlsx') {
        // Employee codes and names stay text (leading zeros); amounts and days become numbers.
        const [head = [], ...body] = rows;
        const book = xlsx([{ name: `${name} ${period}`, columns: head.map((h, i) => ({ label: String(h), type: i < 2 ? 'text' : 'auto' })), rows: body }]);
        return reply.header('content-type', XLSX_TYPE).header('content-disposition', `attachment; filename="${file}"`).header('cache-control', 'private, no-store').send(book);
      }
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${file}"`).header('cache-control', 'private, no-store').send(csv(rows));
    }));
  const itemsOf = (db: Db, tenantId: string, runId: string) => db.query<{ employee_code: string; name: string; employee_id: string; lines: { code: string; amount: number; kind: string }[]; gross: string; deductions: string; net: string; paid_days: string; lop_days: string; hold: boolean; hold_released_at: Date | null }>(
    `SELECT e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, i.employee_id, i.lines, i.gross, i.deductions, i.net, i.paid_days, i.lop_days, i.hold, i.hold_released_at
     FROM payroll_items i JOIN employees e ON e.tenant_id=i.tenant_id AND e.id=i.employee_id WHERE i.tenant_id=$1 AND i.run_id=$2 ORDER BY e.employee_code`, [tenantId, runId]);
  const amt = (lines: { code: string; amount: number }[], code: string) => lines.find((l) => l.code === code)?.amount ?? 0;

  exportRun('register', async (db, a, run) => {
    const items = (await itemsOf(db, a.tenantId, run.id)).rows;
    const codes = [...new Set(items.flatMap((i) => i.lines.map((l) => l.code)))];
    return [['employee_code', 'name', 'paid_days', 'lop_days', ...codes, 'gross', 'deductions', 'net', 'hold'],
      ...items.map((i) => [i.employee_code, i.name, i.paid_days, i.lop_days, ...codes.map((c) => amt(i.lines, c)), i.gross, i.deductions, i.net, i.hold ? 'yes' : ''])];
  }, 'payroll.read', ['csv', 'xlsx']);
  const bankFile = (include: (i: { hold: boolean; hold_released_at: Date | null; net: string }) => boolean) => async (db: Db, a: TenantActor, run: { id: string }) => {
    const full = a.has('employees.bank.read');
    const items = (await itemsOf(db, a.tenantId, run.id)).rows.filter((i) => include(i) && Number(i.net) > 0);
    const out: unknown[][] = [['employee_code', 'name', 'amount', 'account_holder', 'ifsc', 'account_number']];
    for (const i of items) {
      const b = (await db.query<{ account_holder: string; ifsc: string; account_last4: string; account_number_enc: string }>(`SELECT account_holder, ifsc, account_last4, account_number_enc FROM employee_bank_accounts WHERE tenant_id=$1 AND employee_id=$2`, [a.tenantId, i.employee_id])).rows[0];
      out.push([i.employee_code, i.name, i.net, b?.account_holder ?? '', b?.ifsc ?? '', b ? (full ? cipher.decrypt(b.account_number_enc) : `XXXXXX${b.account_last4}`) : 'MISSING']);
    }
    return out;
  };
  // The run's file stays as it was at finalize; pay released later goes out in its own file.
  exportRun('bank', bankFile((i) => !i.hold && !i.hold_released_at));
  exportRun('bank-released', bankFile((i) => !i.hold && !!i.hold_released_at));
  exportRun('pf', async (db, a, run) => {
    const items = (await itemsOf(db, a.tenantId, run.id)).rows.filter((i) => i.lines.some((l) => l.code === 'PF_EE'));
    const out: unknown[][] = [['uan', 'employee_code', 'name', 'gross', 'pf_employee', 'eps_employer', 'epf_employer', 'lop_days']];
    for (const i of items) {
      const s = (await db.query<{ uan: string | null }>('SELECT uan FROM employee_statutory WHERE tenant_id=$1 AND employee_id=$2', [a.tenantId, i.employee_id])).rows[0];
      out.push([s?.uan ?? 'MISSING', i.employee_code, i.name, i.gross, amt(i.lines, 'PF_EE'), amt(i.lines, 'PF_EPS'), amt(i.lines, 'PF_EPF_ER'), i.lop_days]);
    }
    return out;
  });
  exportRun('esi', async (db, a, run) => {
    const items = (await itemsOf(db, a.tenantId, run.id)).rows.filter((i) => i.lines.some((l) => l.code === 'ESI_EE'));
    const out: unknown[][] = [['esi_ip_number', 'employee_code', 'name', 'paid_days', 'gross', 'esi_employee', 'esi_employer']];
    for (const i of items) {
      const s = (await db.query<{ esi_ip_number: string | null }>('SELECT esi_ip_number FROM employee_statutory WHERE tenant_id=$1 AND employee_id=$2', [a.tenantId, i.employee_id])).rows[0];
      out.push([s?.esi_ip_number ?? 'MISSING', i.employee_code, i.name, i.paid_days, i.gross, amt(i.lines, 'ESI_EE'), amt(i.lines, 'ESI_ER')]);
    }
    return out;
  });

  // ------------------------------------------------------------ payslips
  only(app, 'payroll.payslips').get('/payslips/mine', async (req) => {
    const a = tenantActor(req, 'payslips.self');
    if (!a.user.employeeId) return { items: [] };
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'payroll.payslips');
      return { items: (await db.query(`SELECT i.id, r.period, r.kind, i.gross, i.deductions, i.net, r.status FROM payroll_items i JOIN payroll_runs r ON r.tenant_id=i.tenant_id AND r.id=i.run_id
        WHERE i.tenant_id=$1 AND i.employee_id=$2 AND r.status IN ('finalized','paid') AND NOT i.hold ORDER BY r.period DESC`, [a.tenantId, a.user.employeeId])).rows };
    });
  });
  only(app, 'payroll.payslips').get('/payslips/:id', async (req) => {
    const a = tenantActor(req);
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const p = (await db.query<{ employee_id: string; status: string; hold: boolean }>(`SELECT i.employee_id, r.status, i.hold FROM payroll_items i JOIN payroll_runs r ON r.tenant_id=i.tenant_id AND r.id=i.run_id WHERE i.tenant_id=$1 AND i.id=$2`, [a.tenantId, id])).rows[0];
      const own = !!p && p.employee_id === a.user.employeeId && a.has('payslips.self') && ['finalized', 'paid'].includes(p.status) && !p.hold;
      const admin = a.has('payroll.read') || a.has('payroll.manage');
      if (!p || !(own || admin)) throw notFound('Payslip not found');
      if (!admin) await requireFeature(db, a.tenantId, 'payroll.payslips');
      const d = (await db.query(`SELECT r.period, r.kind, i.days_in_period, i.employed_days, i.lop_days, i.paid_days, i.lines, i.gross, i.deductions, i.net,
          e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, e.designation, e.date_of_joining::text, d.name AS department, b.name AS branch, le.name AS legal_entity,
          s.uan, s.pan_last4, ba.account_last4, ba.ifsc
        FROM payroll_items i JOIN payroll_runs r ON r.tenant_id=i.tenant_id AND r.id=i.run_id JOIN employees e ON e.tenant_id=i.tenant_id AND e.id=i.employee_id
        JOIN legal_entities le ON le.tenant_id=r.tenant_id AND le.id=r.legal_entity_id JOIN branches b ON b.tenant_id=e.tenant_id AND b.id=e.branch_id
        LEFT JOIN departments d ON d.tenant_id=e.tenant_id AND d.id=e.department_id LEFT JOIN employee_statutory s ON s.tenant_id=e.tenant_id AND s.employee_id=e.id
        LEFT JOIN employee_bank_accounts ba ON ba.tenant_id=e.tenant_id AND ba.employee_id=e.id WHERE i.tenant_id=$1 AND i.id=$2`, [a.tenantId, id])).rows[0]!;
      if (own) await audit(db, { ...a.auditBase, action: 'payroll.payslip_viewed', category: 'access', targetType: 'payroll_item', targetId: id });
      return { ...d, pan: d.pan_last4 ? `XXXXXX${d.pan_last4}X` : null, account: d.account_last4 ? `XXXXXX${d.account_last4}` : null };
    });
  });

  // ------------------------------------------------------------ F&F helper
  /** Suggested F&F inputs for a leaver (HR confirms each as an adjustment). */
  app.get('/fnf-suggestions/:employeeId', async (req) => {
    const a = tenantActor(req, 'payroll.manage');
    const { employeeId } = z.object({ employeeId: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const s = (await db.query<{ shortfall_days: number; waive_shortfall: boolean; lwd: string; kind: string }>(`SELECT shortfall_days, waive_shortfall, coalesce(approved_lwd, requested_lwd)::text AS lwd, kind
        FROM separations WHERE tenant_id=$1 AND employee_id=$2 AND status IN ('approved','completed') ORDER BY created_at DESC LIMIT 1`, [a.tenantId, employeeId])).rows[0];
      if (!s) throw notFound('No approved separation');
      const leave = await balancesAt(db, a.tenantId, employeeId, s.lwd);
      const sal = (await db.query<{ amounts: Record<string, number> }>(`SELECT amounts FROM employee_salaries WHERE tenant_id=$1 AND employee_id=$2 AND status='active' ORDER BY effective_from DESC LIMIT 1`, [a.tenantId, employeeId])).rows[0];
      return { lastWorkingDay: s.lwd, kind: s.kind, noticeShortfallDays: s.waive_shortfall ? 0 : s.shortfall_days, shortfallWaived: s.waive_shortfall, leaveYear: leave.leaveYear, leaveBalances: leave.items, salary: sal?.amounts ?? null,
        note: 'Leave encashment, notice recovery and gratuity depend on your policies, appointment terms and applicable law; enter confirmed amounts as adjustments.',
        period: periodBounds(s.lwd.slice(0, 7)).start.slice(0, 7), today: await orgToday(db, a.tenantId) };
    });
  });
}
