import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { Client, ownerQuery, seal, type TenantFixture } from './helpers.js';

export interface PayrollWorld { app: FastifyInstance; T: TenantFixture; pay: Client; hr: Client }

/** Fixed pay components for payroll integration tests. Amounts are fixtures, not statutory values. */
export async function seedComponents(T: TenantFixture, extra: { code: string; taxable?: boolean; pf?: boolean; esi?: boolean }[] = []) {
  for (const c of [{ code: 'BASIC', taxable: true, pf: true, esi: true }, ...extra]) {
    await ownerQuery(`INSERT INTO pay_components (tenant_id, code, name, kind, taxable, pf_wage, esi_wage) VALUES ($1,$2,$2,'earning',$3,$4,$5) ON CONFLICT DO NOTHING`,
      [T.id, c.code, c.taxable ?? true, c.pf ?? false, c.esi ?? true]);
  }
}

export async function activeSalary(T: TenantFixture, employeeId: string, effectiveFrom: string, amounts: Record<string, number>) {
  const [s] = await ownerQuery<{ id: string }>(`INSERT INTO employee_salaries (tenant_id, employee_id, effective_from, amounts_enc, reason, status, created_by, approved_at)
    VALUES ($1,$2,$3,$4,'fixture','active',$5,now()) RETURNING id`, [T.id, employeeId, effectiveFrom, seal(amounts), T.users.payroll!.id]);
  return s!.id;
}

export async function activeRule(T: TenantFixture, kind: string, scope: string, params: unknown, effectiveFrom = '2020-01-01') {
  await ownerQuery(`INSERT INTO statutory_rules (tenant_id, kind, scope, effective_from, params, source_reference, status, created_by, verified_by, verified_at)
    VALUES ($1,$2,$3,$4,$5,'Test fixture, not a statutory source','active',$6,$7,now())`, [T.id, kind, scope, effectiveFrom, JSON.stringify(params), T.users.payroll!.id, T.users.hr!.id]);
}

export async function day(T: TenantFixture, employeeId: string, date: string, status: string, o: { leaveFraction?: number; code?: string; dayType?: string } = {}) {
  await ownerQuery(`INSERT INTO attendance_daily (tenant_id, employee_id, work_date, day_type, status, leave_fraction, leave_type_code, calc_version) VALUES ($1,$2,$3,$4,$5,$6,$7,3)
    ON CONFLICT (tenant_id, employee_id, work_date) DO UPDATE SET status=EXCLUDED.status, leave_fraction=EXCLUDED.leave_fraction, leave_type_code=EXCLUDED.leave_type_code, day_type=EXCLUDED.day_type`,
    [T.id, employeeId, date, o.dayType ?? 'working', status, o.leaveFraction ?? 0, o.code ?? null]);
}

export async function createRun(pay: Client, T: TenantFixture, period: string, o: { kind?: 'regular' | 'fnf'; employeeId?: string } = {}) {
  const r = await pay.post('/api/v1/payroll/runs', { period, legalEntityId: T.legalEntityId, ...o });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

export async function compute(pay: Client, runId: string) {
  const r = await pay.post(`/api/v1/payroll/runs/${runId}/compute?reveal=1`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

export interface Item { employee_id: string; lop_days: string; paid_days: string; employed_days: string; gross: string; net: string; hold: boolean; warnings: string[]; lines: { code: string; amount: number; basis?: string }[] }
export async function itemOf(pay: Client, runId: string, employeeId: string): Promise<Item | undefined> {
  const r = await pay.get(`/api/v1/payroll/runs/${runId}?reveal=1`);
  expect(r.statusCode, r.body).toBe(200);
  return (r.json().items as Item[]).find((i) => i.employee_id === employeeId);
}
export const lineOf = (i: Pick<Item, 'lines'> | undefined, code: string) => i?.lines.find((l) => l.code === code)?.amount;

/** Approve the request for an entity from the inbox of an approver. */
export async function approveEntity(c: Client, entityId: string) {
  const inbox = await c.get('/api/v1/approvals/inbox');
  const item = inbox.json().items.find((x: { entity_id: string }) => x.entity_id === entityId);
  expect(item, 'visible to approver').toBeTruthy();
  return c.post(`/api/v1/approvals/${item.id}/act`, { action: 'approve' });
}
