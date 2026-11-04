import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantActor, gateFeatures } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { badRequest, conflict } from '../../core/http/errors.js';
import { getSmsSender, maskPhone, normalizePhone, renderSms } from '../../core/notify/sms.js';

/** Notifications that can also go by SMS (each needs its own DLT-registered template). */
export const SMS_KINDS: Record<string, string> = {
  'approval.requested': 'Something is waiting for your approval',
  'approval.reminder': 'Reminder: approvals still waiting',
  'payroll.payslip': 'Payslip available',
  'expenses.paid': 'Expense claim reimbursed',
  'travel.advance_paid': 'Travel advance paid',
  'loans.disbursed': 'Advance or loan paid out',
  'recruitment.interview': 'Interview scheduled',
  'lifecycle.task_due': 'Onboarding / exit task due',
  'policies.published': 'New policy to read',
  'documents.expiring': 'Document expiring',
  'training.expiring': 'Training expiring',
  'cases.update': 'Update on your grievance / complaint',
  'security.password_changed': 'Your password was changed',
  'security.mfa_disabled': 'Two-step sign-in turned off',
};

export async function smsRoutes(app: FastifyInstance) {
  gateFeatures(app, 'notifications.sms');

  app.get('/templates', async (req) => {
    const a = tenantActor(req, 'settings.manage');
    return a.tx(async (db) => {
      const rows = (await db.query<{ kind: string; dlt_template_id: string; text: string; enabled: boolean; updated_at: string }>(
        `SELECT kind, dlt_template_id, text, enabled, updated_at FROM sms_templates WHERE tenant_id=$1`, [a.tenantId])).rows;
      return { items: Object.entries(SMS_KINDS).map(([kind, label]) => ({ kind, label, template: rows.find((r) => r.kind === kind) ?? null })), transport: !!getSmsSender() };
    });
  });

  app.put('/templates/:kind', async (req) => {
    const a = tenantActor(req, 'settings.manage');
    const { kind } = z.object({ kind: z.string() }).parse(req.params);
    if (!SMS_KINDS[kind]) throw badRequest('Unknown notification kind');
    const b = z.object({ dltTemplateId: z.string().trim().regex(/^[0-9]{10,25}$/, 'The DLT template ID is a 10–25 digit number'), text: z.string().trim().min(5).max(500), enabled: z.boolean().default(true) }).parse(req.body);
    if ((b.text.match(/\{#var#\}/gi) ?? []).length > 2) throw badRequest('Use at most two {#var#} placeholders: the notification title, then its detail');
    return a.tx(async (db) => {
      await db.query(`INSERT INTO sms_templates (tenant_id, kind, dlt_template_id, text, enabled, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (tenant_id, kind) DO UPDATE SET dlt_template_id=EXCLUDED.dlt_template_id, text=EXCLUDED.text, enabled=EXCLUDED.enabled, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [a.tenantId, kind, b.dltTemplateId, b.text, b.enabled, a.user.userId]);
      await audit(db, { ...a.auditBase, action: 'sms.template_saved', category: 'configuration', metadata: { kind, ...b } });
      return { ok: true };
    });
  });

  app.delete('/templates/:kind', async (req) => {
    const a = tenantActor(req, 'settings.manage');
    const { kind } = z.object({ kind: z.string() }).parse(req.params);
    return a.tx(async (db) => {
      await db.query(`DELETE FROM sms_templates WHERE tenant_id=$1 AND kind=$2`, [a.tenantId, kind]);
      await audit(db, { ...a.auditBase, action: 'sms.template_removed', category: 'configuration', metadata: { kind } });
      return { ok: true };
    });
  });

  /** Recent SMS with masked numbers (delivery problems show here). */
  app.get('/outbox', async (req) => {
    const a = tenantActor(req, 'settings.manage');
    const q = z.object({ status: z.enum(['queued', 'sending', 'sent', 'failed']).optional() }).parse(req.query);
    return a.tx(async (db) => {
      const rows = (await db.query<{ to_phone: string } & Record<string, unknown>>(`SELECT o.id, o.kind, o.to_phone, o.status, o.attempts, o.last_error, o.created_at, o.sent_at, u.display_name
        FROM sms_outbox o LEFT JOIN users u ON u.id=o.to_user_id WHERE o.tenant_id=$1 AND ($2::text IS NULL OR o.status=$2) ORDER BY o.created_at DESC LIMIT 100`, [a.tenantId, q.status ?? null])).rows;
      return { items: rows.map(({ to_phone, ...r }) => ({ ...r, to: maskPhone(normalizePhone(to_phone) ?? to_phone) })) };
    });
  });

  /** Send one template to a number now, to check the provider and the DLT registration. */
  app.post('/test', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req) => {
    const a = tenantActor(req, 'settings.manage');
    const b = z.object({ phone: z.string().max(20), kind: z.string() }).parse(req.body);
    const to = normalizePhone(b.phone);
    if (!to) throw badRequest('Enter a mobile number (10 digits, or +country code and number)');
    const s = getSmsSender();
    if (!s) throw conflict('No SMS provider is configured for this installation');
    const t = await a.tx(async (db) => (await db.query<{ dlt_template_id: string; text: string }>(`SELECT dlt_template_id, text FROM sms_templates WHERE tenant_id=$1 AND kind=$2`, [a.tenantId, b.kind])).rows[0]);
    if (!t) throw badRequest('Save a template for this notification first');
    const text = renderSms(t.text, [SMS_KINDS[b.kind] ?? 'Test', 'Test message']);
    try {
      await s.send({ to, text, templateId: t.dlt_template_id });
    } catch (e) {
      await a.tx((db) => audit(db, { ...a.auditBase, action: 'sms.test_failed', category: 'configuration', metadata: { kind: b.kind, to: maskPhone(to), error: (e as Error).message.slice(0, 200) } }));
      throw conflict(`The provider refused it: ${(e as Error).message.slice(0, 300)}`);
    }
    await a.tx((db) => audit(db, { ...a.auditBase, action: 'sms.test_sent', category: 'configuration', metadata: { kind: b.kind, to: maskPhone(to) } }));
    return { ok: true, text };
  });
}
