import type pg from 'pg';

/**
 * A stable dump of the public schema, written in SQL against the catalogues, so it does not depend on a pg_dump binary matching the server.
 * Objects that belong to an extension are left out, and the extensions themselves are listed.
 *
 * Two things are compared by meaning, on purpose, and only these:
 *  - COLUMN ORDER is not compared: columns sort by name. A column dropped and added again by a down file sits at the end of the table, a physical fact that cannot
 *    be undone without rebuilding the table. No code here depends on it: to_jsonb and the row hash read columns by name. Type, default, nullability and the rest are compared.
 *  - A NULL acl and the explicit default it means are the same: acls are expanded through acldefault. `REVOKE` leaves an explicit list where none was, with the same effect.
 */
export type Catalogue = Record<string, string[]>;

const ACL_ROW = `(SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END || ' by ' || pg_get_userbyid(a.grantor), ', '
    ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, a.privilege_type) FROM aclexplode(%ACL%) a)`;
const acl = (expr: string) => ACL_ROW.replace('%ACL%', expr);
const NOT_EXTENSION = (classId: string, objId: string) => `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${classId}'::regclass AND d.objid = ${objId} AND d.deptype = 'e')`;
const PUBLIC_REL = `JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'`;

const SECTIONS: Record<string, string> = {
  schema: `SELECT 'public owner=' || pg_get_userbyid(nspowner) || ' acl=' || coalesce(${acl('coalesce(nspacl, acldefault(\'n\', nspowner))')}, '') AS line FROM pg_namespace WHERE nspname = 'public'`,

  defaultPrivileges: `SELECT pg_get_userbyid(d.defaclrole) || ' ' || d.defaclobjtype::text || ' ' || coalesce(${acl('d.defaclacl')}, '') AS line
    FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace AND n.nspname = 'public'`,

  extensions: `SELECT extname AS line FROM pg_extension WHERE extname <> 'plpgsql'`,

  relations: `SELECT c.relname || ' kind=' || c.relkind::text || ' owner=' || pg_get_userbyid(c.relowner) || ' persistence=' || c.relpersistence::text
      || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity || ' options=' || coalesce(c.reloptions::text, '') AS line
    FROM pg_class c ${PUBLIC_REL} WHERE c.relkind IN ('r','p','v','m','S','f') AND ${NOT_EXTENSION('pg_class', 'c.oid')}`,

  columns: `SELECT c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
      || ' generated=' || a.attgenerated::text || ' identity=' || a.attidentity::text || ' collation=' || coalesce((SELECT co.collname FROM pg_collation co WHERE co.oid = a.attcollation), '') AS line
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid ${PUBLIC_REL} LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE c.relkind IN ('r','p','v','m','f') AND a.attnum > 0 AND NOT a.attisdropped AND ${NOT_EXTENSION('pg_class', 'c.oid')}`,

  constraints: `SELECT coalesce(c.relname, '(domain)') || ' ' || k.conname || ' [' || k.contype::text || '] ' || pg_get_constraintdef(k.oid) AS line
    FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace AND n.nspname = 'public' LEFT JOIN pg_class c ON c.oid = k.conrelid`,

  indexes: `SELECT pg_get_indexdef(i.indexrelid) || ' valid=' || i.indisvalid AS line FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class c ON c.oid = i.indrelid ${PUBLIC_REL}
    WHERE ${NOT_EXTENSION('pg_class', 'ic.oid')}`,

  policies: `SELECT tablename || ' ' || policyname || ' ' || permissive || ' roles=' || roles::text || ' cmd=' || cmd || ' using=' || coalesce(qual, '') || ' check=' || coalesce(with_check, '') AS line
    FROM pg_policies WHERE schemaname = 'public'`,

  triggers: `SELECT t.tgname || ' enabled=' || t.tgenabled::text || ' ' || pg_get_triggerdef(t.oid) AS line FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid ${PUBLIC_REL}
    WHERE NOT t.tgisinternal`,

  functions: `SELECT 'owner=' || pg_get_userbyid(p.proowner) || ' ' || CASE WHEN p.prokind IN ('f','p') THEN pg_get_functiondef(p.oid) ELSE p.proname || ' kind=' || p.prokind::text END AS line
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public' WHERE ${NOT_EXTENSION('pg_proc', 'p.oid')}`,

  tableGrants: `SELECT c.relname || ' ' || coalesce(${acl(`coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))`)}, '') AS line
    FROM pg_class c ${PUBLIC_REL} WHERE c.relkind IN ('r','p','v','m','S','f') AND ${NOT_EXTENSION('pg_class', 'c.oid')}`,

  columnGrants: `SELECT c.relname || '.' || a.attname || ' ' || coalesce(${acl('a.attacl')}, '') AS line FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid ${PUBLIC_REL}
    WHERE a.attacl IS NOT NULL AND a.attnum > 0 AND NOT a.attisdropped AND cardinality(a.attacl) > 0`,

  functionGrants: `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || coalesce(${acl(`coalesce(p.proacl, acldefault('f', p.proowner))`)}, '') AS line
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public' WHERE ${NOT_EXTENSION('pg_proc', 'p.oid')}`,

  sequences: `SELECT s.sequencename || ' ' || s.data_type || ' start=' || s.start_value || ' min=' || s.min_value || ' max=' || s.max_value || ' inc=' || s.increment_by || ' cycle=' || s.cycle || ' cache=' || s.cache_size
      || ' owned_by=' || coalesce((SELECT oc.relname || '.' || a.attname FROM pg_class q JOIN pg_namespace qn ON qn.oid = q.relnamespace AND qn.nspname = 'public' JOIN pg_depend d ON d.objid = q.oid AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a','i') AND d.refobjsubid > 0
           JOIN pg_class oc ON oc.oid = d.refobjid JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid WHERE q.relname = s.sequencename), '') AS line
    FROM pg_sequences s WHERE s.schemaname = 'public'`,

  views: `SELECT c.relname || ' ' || pg_get_viewdef(c.oid) AS line FROM pg_class c ${PUBLIC_REL} WHERE c.relkind IN ('v','m') AND ${NOT_EXTENSION('pg_class', 'c.oid')}`,

  types: `SELECT t.typname || ' kind=' || t.typtype::text || ' base=' || CASE WHEN t.typtype = 'd' THEN format_type(t.typbasetype, t.typtypmod) ELSE '' END
      || ' labels=' || coalesce((SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), '') AS line
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace AND n.nspname = 'public' LEFT JOIN pg_class c ON c.oid = t.typrelid
    WHERE (t.typtype IN ('e','d','r') OR (t.typtype = 'c' AND c.relkind = 'c')) AND ${NOT_EXTENSION('pg_type', 't.oid')}`,
};

export async function schemaCatalogue(c: pg.Client): Promise<Catalogue> {
  const out: Catalogue = {};
  for (const [name, sql] of Object.entries(SECTIONS)) out[name] = (await c.query<{ line: string }>(sql)).rows.map((r) => r.line).sort();
  return out;
}
