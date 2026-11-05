import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { FieldCipher } from '../core/crypto/index.js';
import { loadFieldCipherFromProcess } from '../core/crypto/keys.js';
import { ENCRYPTED_COLUMNS } from '../core/crypto/columns.js';
import { pgSsl } from './ssl.js';

const BATCH = 500;

/**
 * Rewrites every encrypted column with the active key. Load the new key as active and the old one as previous first
 * (DATA_ENCRYPTION_KEY_PREVIOUS, or DATA_KEY_CIPHERTEXT_PREVIOUS), run this, then remove the old key. Each batch commits, a row
 * already on the active key is skipped, and a second run finds nothing: it is safe to resume and safe to repeat.
 */
export async function rotateKeys(connectionString: string, cipher: FieldCipher, log: (m: string) => void = () => undefined) {
  const client = new pg.Client({ connectionString, ssl: pgSsl() });
  await client.connect();
  const out: Record<string, number> = {};
  try {
    for (const col of ENCRYPTED_COLUMNS) {
      const stale = `${col.column} IS NOT NULL AND ${col.column} NOT LIKE $1`;
      let total = 0;
      for (;;) {
        await client.query('BEGIN');
        if (col.guardTrigger) await client.query(`ALTER TABLE ${col.table} DISABLE TRIGGER ${col.guardTrigger}`);
        const r = await client.query<Record<string, string>>(`SELECT ${col.key.join(', ')}, ${col.column} AS token FROM ${col.table} WHERE ${stale} LIMIT ${BATCH} FOR UPDATE`, [
          `v2.${cipher.activeKeyId}.%`,
        ]);
        for (const row of r.rows) {
          const where = col.key.map((k, i) => `${k}=$${i + 2}`).join(' AND ');
          await client.query(`UPDATE ${col.table} SET ${col.column}=$1 WHERE ${where}`, [cipher.encrypt(cipher.decrypt(row.token!)), ...col.key.map((k) => row[k])]);
        }
        if (col.guardTrigger) await client.query(`ALTER TABLE ${col.table} ENABLE TRIGGER ${col.guardTrigger}`);
        await client.query('COMMIT');
        total += r.rowCount ?? 0;
        if ((r.rowCount ?? 0) < BATCH) break;
      }
      out[`${col.table}.${col.column}`] = total;
      if (total) log(`${col.table}.${col.column}: ${total} rewritten`);
    }
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) {
    process.stderr.write('DATABASE_MIGRATION_URL is required\n');
    process.exit(1);
  }
  loadFieldCipherFromProcess()
    .then((c) => rotateKeys(url, c, (m) => process.stdout.write(`${m}\n`)))
    .then(() => process.stdout.write('rotation complete\n'))
    .catch((e: Error) => {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    });
}
