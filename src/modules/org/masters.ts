import type { Db } from '../../db/tx.js';
import { badRequest } from '../../core/http/errors.js';

export type TitleKind = 'grades' | 'designations';
const PREFIX: Record<TitleKind, string> = { grades: 'G', designations: 'D' };
const LABEL: Record<TitleKind, string> = { grades: 'grade', designations: 'designation' };

/**
 * employees.designation and employees.grade stay text (D54). With no entries in a master, anything goes, as before. With entries, a new value must be one of the active
 * ones, by code or name, in any case. What someone already holds stays valid: only a change is checked.
 */
async function unknownTo(db: Db, tenantId: string, kind: TitleKind, value: string): Promise<{ known: boolean; hasMaster: boolean }> {
  const r = await db.query<{ total: string; hit: string }>(
    `SELECT count(*) AS total, count(*) FILTER (WHERE status='active' AND (lower(name)=lower($2) OR lower(code)=lower($2))) AS hit FROM ${kind} WHERE tenant_id=$1`,
    [tenantId, value.trim()],
  );
  return { hasMaster: Number(r.rows[0]!.total) > 0, known: Number(r.rows[0]!.hit) > 0 };
}

export async function assertKnownTitle(db: Db, tenantId: string, kind: TitleKind, value: string | null | undefined) {
  if (!value?.trim()) return;
  const { hasMaster, known } = await unknownTo(db, tenantId, kind, value);
  if (hasMaster && !known) throw badRequest(`'${value}' is not an active ${LABEL[kind]}. Add it under Organization, or choose another.`);
}

/** Whether an import would have to add this value to a master that has entries. */
export async function titleToAdd(db: Db, tenantId: string, kind: TitleKind, value: string | null | undefined) {
  if (!value?.trim()) return false;
  const { hasMaster, known } = await unknownTo(db, tenantId, kind, value);
  return hasMaster && !known;
}

/**
 * An import brings a whole organization's titles and must not fail on a new one: it is added to the master, reported in the answer and audited by the caller.
 * A name there but inactive is left inactive: the employee keeps the text, since nothing refuses it on import.
 */
export async function addTitle(db: Db, tenantId: string, kind: TitleKind, value: string) {
  const name = value.trim();
  const { n } = (await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${kind} WHERE tenant_id=$1`, [tenantId])).rows[0]!;
  for (let i = Number(n) + 1; ; i++) {
    const code = `${PREFIX[kind]}${String(i).padStart(4, '0')}`;
    if ((await db.query(`SELECT 1 FROM ${kind} WHERE tenant_id=$1 AND code=$2`, [tenantId, code])).rowCount) continue;
    await db.query(`INSERT INTO ${kind} (tenant_id, code, name) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, lower(name)) DO NOTHING`, [tenantId, code, name]);
    return;
  }
}
