import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as R from '../../core/http/responses.js';
import { z } from 'zod';
import { tenantActor, tenantActorAny, gateFeatures } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { conflict } from '../../core/http/errors.js';
import { Uuid } from '../../core/http/pagination.js';
import { getSettingValue } from '../../core/settings/service.js';
import { featureOn } from '../lifecycle/service.js';
import { sealJson } from '../../core/crypto/index.js';
import { auditL4, l4RowFilter, policyViewer, readContext, refuseHigherLevel, wantsReveal } from '../../core/policy/salary.js';
import { visibleRunTotals } from '../payroll/sealed.js';
import { payrollJournal, reimbursementJournal, toCsv, toTallyXml, type Journal } from './service.js';

const KEY = /^(earning|deduction|employer_expense|employer_payable|expense):([A-Z0-9_]{1,30}|\*)$|^(net_pay|reimbursement_payable|travel_advance)$/;

const LedgerMapBody = z.object({
  entries: z
    .array(z.object({ key: z.string().regex(KEY, 'Unknown head'), ledger: z.string().trim().max(200) }))
    .min(1)
    .max(500),
});
const ExportQuery = z.object({ format: z.enum(['csv', 'tally_xml']).default('csv') });
const IdParams = z.object({ id: Uuid });

export async function accountingRoutes(app: FastifyInstance) {
  gateFeatures(app, 'accounting_exports');

  /** The organization's ledger names, and the heads this installation uses (to map). */
  app.get('/ledger-map', { schema: { response: { 200: R.GetAccountingLedgerMap200 } }, config: { permAny: ['accounting.export', 'accounting.configure'] } }, async (req) => {
    const a = tenantActorAny(req, 'accounting.export', 'accounting.configure');
    return a.tx(async (db) => {
      const items = (await db.query(`SELECT map_key, ledger_name, updated_at FROM accounting_ledger_map WHERE tenant_id=$1 ORDER BY map_key`, [a.tenantId])).rows;
      const heads: { key: string; label: string }[] = [];
      for (const c of (
        await db.query<{ code: string; name: string; kind: string }>(`SELECT code, name, kind FROM pay_components WHERE tenant_id=$1 AND status='active' ORDER BY position, code`, [
          a.tenantId,
        ])
      ).rows)
        heads.push({ key: `${c.kind}:${c.code}`, label: c.name });
      // Lines payroll itself produces (statutory, overtime, loans), and catch-alls for one-off adjustments.
      for (const [k, l] of [
        ['earning:OT', 'Overtime'],
        ['earning:*', 'Other earnings (adjustments, arrears)'],
        ['deduction:PF_EE', 'Provident fund (employee)'],
        ['deduction:ESI_EE', 'ESI (employee)'],
        ['deduction:PT', 'Professional tax'],
        ['deduction:LWF_EE', 'Labour welfare fund (employee)'],
        ['deduction:TDS', 'Income tax (TDS)'],
        ['deduction:LOAN', 'Salary advance / loan recovery'],
        ['deduction:*', 'Other deductions (adjustments, further loans)'],
        ['employer_expense:PF_EPF_ER', 'Provident fund (employer) — expense'],
        ['employer_payable:PF_EPF_ER', 'Provident fund (employer) — payable'],
        ['employer_expense:PF_EPS', 'Pension EPS (employer) — expense'],
        ['employer_payable:PF_EPS', 'Pension EPS (employer) — payable'],
        ['employer_expense:ESI_ER', 'ESI (employer) — expense'],
        ['employer_payable:ESI_ER', 'ESI (employer) — payable'],
        ['employer_expense:LWF_ER', 'Labour welfare fund (employer) — expense'],
        ['employer_payable:LWF_ER', 'Labour welfare fund (employer) — payable'],
        ['net_pay', 'Net salary payable'],
      ] as const)
        if (!heads.some((h) => h.key === k)) heads.push({ key: k, label: l });
      if (await featureOn(db, a.tenantId, 'expenses')) {
        for (const c of (await db.query<{ code: string; name: string }>(`SELECT code, name FROM expense_categories WHERE tenant_id=$1 ORDER BY name`, [a.tenantId])).rows)
          heads.push({ key: `expense:${c.code}`, label: c.name });
        heads.push({ key: 'expense:*', label: 'Other expense categories' }, { key: 'reimbursement_payable', label: 'Reimbursements payable' });
        if (await featureOn(db, a.tenantId, 'travel')) heads.push({ key: 'travel_advance', label: 'Travel advances (employee advances account)' });
      }
      return { items, heads };
    });
  });

  app.put('/ledger-map', { schema: { response: { 200: R.PutAccountingLedgerMap200 }, body: LedgerMapBody }, config: { perm: ['accounting.configure'] } }, async (req) => {
    const a = tenantActor(req, 'accounting.configure');
    const b = LedgerMapBody.parse(req.body);
    return a.tx(async (db) => {
      for (const e of b.entries) {
        if (e.ledger)
          await db.query(
            `INSERT INTO accounting_ledger_map (tenant_id, map_key, ledger_name, updated_by) VALUES ($1,$2,$3,$4)
          ON CONFLICT (tenant_id, map_key) DO UPDATE SET ledger_name=EXCLUDED.ledger_name, updated_by=EXCLUDED.updated_by, updated_at=now()`,
            [a.tenantId, e.key, e.ledger, a.user.userId],
          );
        else await db.query(`DELETE FROM accounting_ledger_map WHERE tenant_id=$1 AND map_key=$2`, [a.tenantId, e.key]);
      }
      await audit(db, { ...a.auditBase, action: 'accounting.ledger_map_updated', category: 'configuration', metadata: { entries: b.entries } });
      return { ok: true };
    });
  });

  /** What can be exported, with the last export of each. */
  app.get('/sources', { schema: { response: { 200: R.GetAccountingSources200 } }, config: { perm: ['accounting.export'] } }, async (req) => {
    const a = tenantActor(req, 'accounting.export');
    return a.tx(async (db) => {
      const last = `(SELECT json_build_object('at', x.created_at, 'format', x.format, 'by', u.display_name) FROM accounting_exports x JOIN users u ON u.id=x.exported_by
        WHERE x.tenant_id=$1 AND x.source_type=%s AND x.source_id=%s ORDER BY x.created_at DESC LIMIT 1) AS last_export`;
      const v = await policyViewer(db, a.tenantId, a.user);
      const reveal = wantsReveal(req);
      const raw = (
        await db.query<{ id: string; totals_enc: string | null } & Record<string, unknown>>(
          `SELECT r.id, r.period, r.kind, r.status, r.totals_enc, le.name AS legal_entity, ${last.replace('%s', `'payroll_run'`).replace('%s', 'r.id')}
        FROM payroll_runs r JOIN legal_entities le ON le.tenant_id=r.tenant_id AND le.id=r.legal_entity_id
        WHERE r.tenant_id=$1 AND r.status IN ('finalized','paid') ORDER BY r.period DESC, r.created_at DESC LIMIT 60`,
          [a.tenantId],
        )
      ).rows;
      const runs = [];
      const read = new Set<string>();
      for (const { totals_enc, ...r } of raw) {
        if (!totals_enc) {
          runs.push({ ...r, totals: null });
          continue;
        }
        if (!reveal) {
          runs.push({ ...r, totals: null, masked: true as const, maskedFields: ['totals'] });
          continue;
        }
        const { excluded, subjects, ...totals } = await visibleRunTotals(db, a.tenantId, v, r.id);
        subjects.forEach((x) => read.add(x));
        runs.push({ ...r, totals, excluded });
      }
      await auditL4(
        db,
        readContext(req, a),
        'reveal',
        'accounting.sources',
        [...read].map((employeeId) => ({ employeeId, fields: ['totals'] })),
      );
      const batches = (await featureOn(db, a.tenantId, 'expenses'))
        ? (
            await db.query(
              `SELECT b.id, b.status, b.total, b.claim_count, b.created_at, b.paid_at, b.payment_reference,
          ${last.replace('%s', `'reimbursement_batch'`).replace('%s', 'b.id')}
        FROM reimbursement_batches b WHERE b.tenant_id=$1 AND b.status IN ('approved','paid') ORDER BY b.created_at DESC LIMIT 60`,
              [a.tenantId],
            )
          ).rows
        : [];
      return { runs, batches };
    });
  });

  const load = async (req: FastifyRequest, a: ReturnType<typeof tenantActor>, kind: 'payroll_run' | 'reimbursement_batch', read: 'read' | 'export') => {
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      if (kind === 'reimbursement_batch' && !(await featureOn(db, a.tenantId, 'expenses'))) throw conflict('Expenses are not in use');
      if (kind === 'payroll_run') {
        // A journal has to balance, so it covers everyone or nobody: someone who cannot see the whole run does not get it.
        const v = await policyViewer(db, a.tenantId, a.user);
        const hidden = await db.query<{ employee_id: string }>(
          `SELECT i.employee_id FROM payroll_items i JOIN employees e ON e.tenant_id=i.tenant_id AND e.id=i.employee_id WHERE i.tenant_id=$1 AND i.run_id=$2 AND NOT ${l4RowFilter(v, 'e')}`,
          [a.tenantId, id],
        );
        if (hidden.rowCount) throw refuseHigherLevel(hidden.rowCount!);
        const everyone = await db.query<{ employee_id: string }>('SELECT employee_id FROM payroll_items WHERE tenant_id=$1 AND run_id=$2', [a.tenantId, id]);
        await auditL4(
          db,
          readContext(req, a),
          read,
          'accounting.journal',
          everyone.rows.map((x) => ({ employeeId: x.employee_id, fields: ['journal'] })),
        );
      }
      return { id, j: kind === 'payroll_run' ? await payrollJournal(db, a.tenantId, id) : await reimbursementJournal(db, a.tenantId, id) };
    });
  };

  const exportFile = async (
    a: ReturnType<typeof tenantActor>,
    reply: FastifyReply,
    kind: 'payroll_run' | 'reimbursement_batch',
    id: string,
    j: Journal,
    format: 'csv' | 'tally_xml',
  ) => {
    if (j.missing.length) throw conflict(`Map these heads to ledgers first: ${j.missing.join(', ')}`);
    if (!j.balanced) throw conflict('The journal does not balance; the run needs to be checked before export');
    const body = await a.tx(async (db) => {
      const company = await getSettingValue<string>(db, a.tenantId, 'accounting.tally_company');
      const voucherType = await getSettingValue<string>(db, a.tenantId, 'accounting.tally_voucher_type');
      await db.query(`INSERT INTO accounting_exports (tenant_id, source_type, source_id, format, voucher_date, total_enc, exported_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
        a.tenantId,
        kind,
        id,
        format,
        j.date,
        sealJson(j.total),
        a.user.userId,
      ]);
      await audit(db, { ...a.auditBase, action: 'accounting.exported', category: 'access', targetType: kind, targetId: id, metadata: { format, voucher: j.number } });
      return format === 'csv' ? toCsv(j) : toTallyXml(j, { company: company || null, voucherType: voucherType || 'Journal' });
    });
    const ext = format === 'csv' ? 'csv' : 'xml';
    return reply
      .header('content-type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/xml; charset=utf-8')
      .header('content-disposition', `attachment; filename="${j.number}.${ext}"`)
      .header('cache-control', 'private, no-store')
      .send(body);
  };

  for (const [path, kind] of [
    ['payroll-runs', 'payroll_run'],
    ['reimbursement-batches', 'reimbursement_batch'],
  ] as const) {
    /** Preview: the voucher, its entries and any heads still to map. */
    app.get(
      `/${path}/:id/journal`,
      { schema: { response: { 200: R.GetAccountingPayrollRunsByIdJournal200 }, params: IdParams }, config: { perm: ['accounting.export'] } },
      async (req) => {
        const a = tenantActor(req, 'accounting.export');
        return (await load(req, a, kind, 'read')).j;
      },
    );
    app.get(
      `/${path}/:id/export`,
      { schema: { response: { 200: R.file('text/csv', 'application/xml') }, params: IdParams, querystring: ExportQuery }, config: { perm: ['accounting.export'] } },
      async (req, reply) => {
        const a = tenantActor(req, 'accounting.export');
        const { format } = ExportQuery.parse(req.query);
        const { id, j } = await load(req, a, kind, 'export');
        return exportFile(a, reply, kind, id, j, format);
      },
    );
  }
}
