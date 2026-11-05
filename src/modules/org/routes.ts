import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cached, invalidate } from '../../core/cache/index.js';
import { tenantActor, tenantActorAny } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { notFound } from '../../core/http/errors.js';
import { Uuid } from '../../core/http/pagination.js';

const Code = z.string().trim().regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/, 'Uppercase letters, digits, - or _ (max 20)');
const LegalEntityBody = z.object({ name: z.string().trim().min(2).max(200), cin: z.string().trim().max(30).nullable().optional(),
  gstin: z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z0-9]{13}$/, 'GSTIN must be 15 characters').nullable().optional(),
  stateCode: z.string().trim().max(10).nullable().optional(), status: z.enum(['active', 'inactive']).default('active') });
const BranchBody = z.object({ legalEntityId: Uuid, code: Code, name: z.string().trim().min(2).max(200), state: z.string().trim().min(2).max(80),
  city: z.string().trim().max(80).nullable().optional(), status: z.enum(['active', 'inactive']).default('active') });
const DepartmentBody = z.object({ code: Code, name: z.string().trim().min(2).max(200), parentId: Uuid.nullable().optional(), status: z.enum(['active', 'inactive']).default('active') });

const IdParams = z.object({ id: Uuid });
export async function orgRoutes(app: FastifyInstance) {
  app.get('/', { schema: {}, config: { permAny: ['org.read', 'employees.directory'] } }, async (req) => {
    // Directory users need branch/department names for filters; full management needs org.manage.
    const a = tenantActorAny(req, 'org.read', 'employees.directory');
    return a.tx((db) => cached(db, a.tenantId, 'org', 'lists', async () => ({
      legalEntities: (await db.query('SELECT id, name, cin, gstin, state_code, status FROM legal_entities WHERE tenant_id=$1 ORDER BY name', [a.tenantId])).rows,
      branches: (await db.query('SELECT id, legal_entity_id, code, name, state, city, status FROM branches WHERE tenant_id=$1 ORDER BY name', [a.tenantId])).rows,
      departments: (await db.query('SELECT id, code, name, parent_id, status FROM departments WHERE tenant_id=$1 ORDER BY name', [a.tenantId])).rows,
    })));
  });

  const upsert = <B extends z.ZodTypeAny>(entity: string, table: string, schema: B,
    cols: (b: z.infer<B>) => Record<string, unknown>) => {
    app.post(`/${entity}`, { schema: { body: schema }, config: { perm: ['org.manage'] } }, async (req, reply) => {
      const a = tenantActor(req, 'org.manage');
      const b = schema.parse(req.body);
      const c = cols(b);
      const keys = Object.keys(c);
      return a.tx(async (db) => {
        const r = await db.query<{ id: string }>(`INSERT INTO ${table} (tenant_id, ${keys.join(',')}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING id`,
          [a.tenantId, ...Object.values(c)]);
        invalidate(db, a.tenantId, 'org');
        await audit(db, { ...a.auditBase, action: `org.${entity}_created`, targetType: entity, targetId: r.rows[0]!.id, metadata: c });
        reply.code(201); return { id: r.rows[0]!.id };
      });
    });
    app.put(`/${entity}/:id`, { schema: { params: IdParams, body: schema }, config: { perm: ['org.manage'] } }, async (req) => {
      const a = tenantActor(req, 'org.manage');
      const { id } = IdParams.parse(req.params);
      const c = cols(schema.parse(req.body));
      const keys = Object.keys(c);
      return a.tx(async (db) => {
        const prev = await db.query(`SELECT ${keys.join(',')} FROM ${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [a.tenantId, id]);
        if (!prev.rowCount) throw notFound();
        await db.query(`UPDATE ${table} SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(',')} WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, ...Object.values(c)]);
        invalidate(db, a.tenantId, 'org');
        await audit(db, { ...a.auditBase, action: `org.${entity}_updated`, targetType: entity, targetId: id, metadata: { from: prev.rows[0], to: c } });
        return { ok: true };
      });
    });
  };

  upsert('legal-entities', 'legal_entities', LegalEntityBody, (b) => ({ name: b.name, cin: b.cin ?? null, gstin: b.gstin ?? null, state_code: b.stateCode ?? null, status: b.status }));
  upsert('branches', 'branches', BranchBody, (b) => ({ legal_entity_id: b.legalEntityId, code: b.code, name: b.name, state: b.state, city: b.city ?? null, status: b.status }));
  upsert('departments', 'departments', DepartmentBody, (b) => ({ code: b.code, name: b.name, parent_id: b.parentId ?? null, status: b.status }));
}
