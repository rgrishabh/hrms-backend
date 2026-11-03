import type pg from 'pg';
import { FEATURES } from './registry.js';

/** Mirror the code registry into feature_definitions (owner role, at migrate time). */
export async function syncFeatureDefinitions(client: pg.Client | pg.PoolClient): Promise<void> {
  for (const d of FEATURES) {
    await client.query(
      `INSERT INTO feature_definitions (key, name, description, category, default_enabled, dependencies,
         platform_supported, requires_entitlement, core, configuration_schema, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (key) DO UPDATE SET name=$2, description=$3, category=$4, default_enabled=$5,
         dependencies=$6, platform_supported=$7, requires_entitlement=$8, core=$9, configuration_schema=$10, synced_at=now()`,
      [d.key, d.name, d.description, d.category, d.defaultEnabled, d.dependencies,
       d.availability !== 'planned', false, d.core,
       JSON.stringify({ requiredSettings: d.requiredSettings ?? [] })]);
  }
}
