import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { CODE_MIGRATIONS } from '../src/db/code-migrations.js';
import { isNoTransaction, migrationStatus, parseRollbackArgs, splitStatements } from '../src/db/migrate.js';
import { CODE_STEP, CONTRACT, EXPAND, MIGRATIONS, SEALED, type CycleResult } from './migration-cycle.js';
import { TEST_SINGLE_OWNER_URL } from './env.js';
import type { Catalogue } from './schema-catalogue.js';

/**
 * Every migration can be undone, and undoing it restores the schema it found.
 *
 * Which database: the cycle is destructive and cannot run while other files use a database, and this suite can create none (hrms_owner has no CREATEDB in the official
 * environment, and all three databases are shared). So test/global-setup.ts runs test/migration-cycle.ts on hrms_test_single_b before any test file starts, then resets it,
 * and writes down what happened; this file asserts on that record. It runs in every environment with only the existing variables, and is never skipped. A failed cycle fails here.
 *
 * What is compared: test/schema-catalogue.ts, a catalogue dump in SQL. Column order is not compared, and its comment says why. Nothing else is left out.
 */
const cycle = JSON.parse(readFileSync(inject('migrationCycleFile'), 'utf8')) as CycleResult;
const ok = () => expect(cycle.failure).toBeNull();

const shippedSql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();

describe('every migration has a way back', () => {
  it('a down file for every SQL migration on disk, a down function for every code migration', () => {
    expect(shippedSql.length).toBeGreaterThanOrEqual(46);
    expect(shippedSql.filter((f) => !existsSync(path.join(MIGRATIONS, 'down', f)))).toEqual([]);
    for (const step of CODE_MIGRATIONS) expect(typeof step.down).toBe('function');
  });

  it('no down file without a migration, and nothing in down/ counted as a forward migration', async () => {
    expect(readdirSync(path.join(MIGRATIONS, 'down')).filter((f) => !shippedSql.includes(f))).toEqual([]);
    expect(cycle.order).not.toContain('down');
    const c = new pg.Client({ connectionString: TEST_SINGLE_OWNER_URL });
    await c.connect();
    const st = await migrationStatus(c);
    await c.end();
    expect(st.pending).toEqual([]);
    expect(st.unknown).toEqual([]);
    expect(st.applied).toBe(shippedSql.length + CODE_MIGRATIONS.length);
  });
});

describe('the cycle on a seeded database', () => {
  it('ran to the end', ok);

  it('schema after rolling back each step equals the schema just before that step went up', () => {
    ok();
    const differences: Record<string, Record<string, { before: string[]; after: string[] }>> = {};
    cycle.order.forEach((name, i) => {
      const expected: Catalogue = cycle.up[i === 0 ? '' : cycle.order[i - 1]!]!;
      const actual = cycle.down[name]!;
      for (const section of Object.keys(expected)) {
        const before = expected[section]!.filter((l) => !actual[section]!.includes(l));
        const after = actual[section]!.filter((l) => !expected[section]!.includes(l));
        if (before.length || after.length) (differences[name] ??= {})[section] = { before, after };
      }
    });
    expect(differences).toEqual({});
  });

  it('nothing of the application is left after rolling back everything', () => {
    ok();
    const { catalogue, applied } = cycle.emptied!;
    expect(applied).toBe(0);
    expect(catalogue.relations!.map((l) => l.split(' ')[0])).toEqual(['schema_migrations']);
    for (const section of ['extensions', 'policies', 'triggers', 'functions', 'functionGrants', 'columnGrants', 'sequences', 'views', 'types', 'defaultPrivileges'])
      expect(catalogue[section], section).toEqual([]);
    expect(catalogue.indexes).toHaveLength(1);
    expect(catalogue.tableGrants!.join()).not.toContain('hrms_app');
    expect(catalogue.schema!.join()).not.toContain('hrms_app');
  });

  it('going all the way up again gives the same schema, and so does the pair round trip', () => {
    ok();
    const first = cycle.up[cycle.order[cycle.order.length - 1]!]!;
    expect(cycle.reup).toEqual(first);
    expect(cycle.runner.allBeforePair).toEqual(first);
    expect(cycle.pair!.catalogue).toEqual(first);
  });

  it('the dump really does see what it claims to', () => {
    ok();
    const all = cycle.up[cycle.order[cycle.order.length - 1]!]!;
    expect(all.defaultPrivileges!.join()).toContain('hrms_app');
    expect(all.policies!.some((l) => l.startsWith('users tenant_isolation'))).toBe(true);
    expect(all.triggers!.some((l) => l.includes('CONSTRAINT TRIGGER audit_logs_chain'))).toBe(true);
    expect(all.functions!.some((l) => l.includes('audit_chain_verify'))).toBe(true);
    expect(all.columnGrants!.some((l) => l.startsWith('attendance_events.status') && l.includes('hrms_app:UPDATE'))).toBe(true);
    expect(all.functionGrants!.some((l) => l.startsWith('audit_chain_verify') && l.includes('hrms_app:EXECUTE'))).toBe(true);
    expect(all.tableGrants!.some((l) => l.startsWith('audit_logs_id_seq') && l.includes('hrms_app:USAGE'))).toBe(true);
    expect(all.sequences!.some((l) => l.includes('owned_by=audit_logs.id'))).toBe(true);
    expect(all.extensions).toEqual(expect.arrayContaining(['pgcrypto', 'btree_gist']));
    // And a state with a replaced definition differs from the one after: the comparison can fail.
    expect(cycle.up['034_bank_change_requests.sql']!.functions).not.toEqual(cycle.up['035_payroll_hold_release.sql']!.functions);
  });
});

describe('what the down files do to rows', () => {
  it('047: sealed mail is failed, reset links are spent, an email-MFA account can sign in again', () => {
    ok();
    const [p] = cycle.probes['047_auth.sql'] as [{ mail: unknown; links: unknown; mfa: unknown }];
    expect(p.mail).toEqual([
      { to: 'a@seed.test', status: 'failed' },
      { to: 'b@seed.test', status: 'queued' },
    ]);
    expect(p.links).toEqual([
      { hash: 'r1', used: true },
      { hash: 's1', used: false },
    ]);
    expect(p.mfa).toEqual([
      { email: 'emailmfa@seed.test', on: false },
      { email: 'totp@seed.test', on: true },
    ]);
  });

  it('044: the chain is cleared, sealed values stay until the code step, and every owner still administers', () => {
    ok();
    const [p] = cycle.probes[CONTRACT] as [{ owners: number; roles: unknown; unchained: number; audit_rows: number; still_sealed: number }];
    expect(p.owners).toBe(0);
    expect(p.roles).toEqual([
      { email: 'admin@seed.test', role: 'tenant_admin' },
      { email: 'owner@seed.test', role: 'tenant_admin' },
    ]);
    expect(p.unchained).toBe(p.audit_rows);
    expect(p.audit_rows).toBeGreaterThan(0);
    expect(p.still_sealed).toBe(1);
  });

  it('043: placeholders are replaced by the sealed values', () => {
    ok();
    const [p] = cycle.probes[CODE_STEP] as [{ net: string; note: string; ctc: string; still_sealed: number }];
    expect(p).toEqual({ net: '40000.00', note: 'Arrears for March', ctc: '492000.00', still_sealed: 0 });
  });

  it('040, 038, 032, 021, 006: labels go back and rows the old checks refuse are rewritten, not lost', () => {
    ok();
    expect(cycle.probes['040_feature_splits.sql']).toEqual([{ entity_type: 'employee_loan' }]);
    const jobs = cycle.probes['038_job_runs_queued.sql'] as { period_key: string; status: string; error: string | null }[];
    expect(jobs.map((j) => [j.period_key, j.status])).toEqual([
      ['2026-01', 'succeeded'],
      ['manual:1', 'failed'],
    ]);
    expect(jobs[1]!.error).toContain('rolled back');
    const ledger = cycle.probes['032_leave_year_close.sql'] as { entry_type: string; days: string; note: string | null }[];
    expect(ledger.map((l) => [l.entry_type, l.days])).toEqual([
      ['opening', '5.00'],
      ['adjustment', '-2.00'],
    ]);
    expect(ledger[1]!.note).toContain('carry_out');
    expect((cycle.probes['021_field_duty.sql'] as { status: string }[]).map((d) => d.status)).toEqual(['present', 'on_leave', 'present']);
    expect((cycle.probes['006_leave_management.sql'] as { status: string }[]).map((d) => d.status)).toEqual(['present', 'absent', 'present']);
  });

  it('rows really were there when the tables they live in were dropped', () => {
    ok();
    expect(cycle.probes['002_core_hr_attendance.sql']).toEqual([{ tenants: 1 }]);
  });

  it('rolling 044 and 043 back together gives the plaintext exactly, and going up seals the same values and a chain that verifies', () => {
    ok();
    const { lastApplied, plaintext: p, resealed: r, chain } = cycle.pair!;
    expect(lastApplied).toBe(EXPAND);
    expect(p.salary).toEqual([{ amounts: SEALED.amounts, annual_ctc: '492000.00', amounts_enc: null }]);
    expect(p.item).toEqual([
      { lines: SEALED.item.lines, gross: '41000.00', deductions: '1000.00', net: '40000.00', employer_cost: '42000.00', warnings: SEALED.item.warnings, data_enc: null },
    ]);
    expect(p.runs).toEqual([
      { period: '2026-03', totals: SEALED.totals, totals_enc: null },
      { period: '2026-04', totals: {}, totals_enc: null },
    ]);
    expect(p.adjustment).toEqual([{ amount: '750.00', note: SEALED.adjustment.note, data_enc: null }]);
    expect(p.export).toEqual([{ total: '40000.50', total_enc: null }]);
    expect(p.snapshot).toEqual([{ rows: SEALED.snapshot.rows, totals: SEALED.snapshot.totals, data_enc: null }]);
    expect(
      p.chain!.every((x) => {
        const l = x as Record<string, unknown>;
        return l.chain_seq === null && l.prev_hash === null && l.row_hash === null;
      }),
    ).toBe(true);
    expect(p.chain!.length).toBeGreaterThan(0);

    expect(JSON.parse(r.amounts as string)).toEqual(SEALED.amounts);
    expect(Number(r.annualCtc)).toBe(SEALED.annualCtc);
    expect(JSON.parse(r.item as string)).toEqual(SEALED.item);
    expect(JSON.parse(r.totals as string)).toEqual(SEALED.totals);
    expect(JSON.parse(r.adjustment as string)).toEqual(SEALED.adjustment);
    expect(Number(r.exportTotal)).toBe(SEALED.exportTotal);
    // `subjects` lives only in a sealed snapshot: the plaintext columns of that release had nowhere to put it.
    expect(JSON.parse(r.snapshot as string)).toEqual({ rows: SEALED.snapshot.rows, totals: SEALED.snapshot.totals });
    expect(chain).toMatchObject({ ok: true, broken_seq: null, reason: null });
    expect((chain as { checked: number }).checked).toBeGreaterThan(0);
  });
});

describe('rollback refuses, before changing anything', () => {
  const refusal = (name: string) => {
    ok();
    const r = cycle.refusals.find((x) => x.name === name)!;
    expect(r.appliedAfter).toBe(r.appliedBefore);
    return r.error;
  };
  it('without saying how far', () => {
    expect(refusal('no target')).toMatch(/exactly one/);
    expect(refusal('two targets')).toMatch(/exactly one/);
  });
  it('with a count that makes no sense, or a name that is not applied', () => {
    expect(refusal('zero steps')).toMatch(/at least 1/);
    expect(refusal('too many steps')).toMatch(/applied/);
    expect(refusal('unknown name')).toMatch(/not an applied migration/);
  });
  it('when a down file is missing, naming it', () => {
    expect(refusal('missing down')).toContain(`no down file for ${cycle.order[cycle.order.length - 1]}`);
  });
  it('stopping between 044 and 043, which would leave placeholders in pay columns', () => {
    expect(refusal('stop inside the pair')).toMatch(/placeholder/);
  });
  it('with a key that cannot open the sealed values', () => {
    expect(refusal('wrong key')).toMatch(/data key cannot open/);
  });
});

describe('no-transaction files', () => {
  it('create indexes concurrently, statement by statement, and are recorded after', () => {
    ok();
    expect(cycle.runner.afterUp).toEqual({ indexes: ['probe_id', 'probe_note'], recorded: ['001_table.sql', '002_index.sql'] });
  });
  it('the same statement without the marker fails, which is why the marker exists', () => {
    ok();
    expect(cycle.runner.withoutMarker).toMatch(/cannot run inside a transaction block/);
  });
  it('a failure part way is not recorded, earlier statements stay, and an invalid index left behind is named, not skipped', () => {
    ok();
    const p = cycle.runner.partWay as { firstTry: string; earlierStatementKept: boolean; recordedAfterFailure: string[]; secondTry: string; recordedAtLast: string[] };
    expect(p.firstTry).toMatch(/could not create unique index/);
    expect(p.earlierStatementKept).toBe(true);
    expect(p.recordedAfterFailure).toEqual(['001_table.sql', '002_index.sql']);
    expect(p.secondTry).toMatch(/invalid index.*probe_uq/);
    expect(p.recordedAtLast).toEqual(['001_table.sql', '002_index.sql', '003_unique.sql']);
  });
  it('work for down files too, and the row goes after', () => {
    ok();
    expect(cycle.runner.afterDown).toEqual({ rolled: ['003_unique.sql', '002_index.sql'], indexes: [], recorded: ['001_table.sql'] });
    expect(cycle.runner.empty).toEqual([]);
  });

  it('the marker counts on the first line only', () => {
    expect(isNoTransaction('-- hrms:no-transaction\nSELECT 1;')).toBe(true);
    expect(isNoTransaction('-- hrms:no-transaction  \r\nSELECT 1;')).toBe(true);
    expect(isNoTransaction('-- a comment\n-- hrms:no-transaction\nSELECT 1;')).toBe(false);
    expect(isNoTransaction('SELECT 1; -- hrms:no-transaction')).toBe(false);
    expect(
      readdirSync(MIGRATIONS)
        .filter((f) => f.endsWith('.sql') && f < '048')
        .filter((f) => isNoTransaction(readFileSync(path.join(MIGRATIONS, f), 'utf8'))),
    ).toEqual([]);
  });

  it('statements split on top-level semicolons only', () => {
    expect(
      splitStatements(
        `-- one; comment\nSELECT 1;\n/* two; /* nested; */ */ SELECT ';', "a;b", E'it\\'s;', 'it''s;';\nDO $$ BEGIN PERFORM 1; END $$;\nDO $tag$ SELECT $$;$$; $tag$;\n-- trailing; comment\n`,
      ),
    ).toEqual([`-- one; comment\nSELECT 1`, `/* two; /* nested; */ */ SELECT ';', "a;b", E'it\\'s;', 'it''s;'`, 'DO $$ BEGIN PERFORM 1; END $$', 'DO $tag$ SELECT $$;$$; $tag$']);
    expect(splitStatements('SELECT 1')).toEqual(['SELECT 1']);
    expect(splitStatements('-- only a comment\n;\n')).toEqual([]);
    expect(splitStatements(`SELECT $1; SELECT 'x\\'; SELECT 2`)).toEqual(['SELECT $1', `SELECT 'x\\'`, 'SELECT 2']);
  });
});

describe('the command line', () => {
  it('has no default of everything', () => {
    expect(() => parseRollbackArgs(['--rollback'])).toThrow(/Say how far/);
    expect(() => parseRollbackArgs(['--rollback', '--steps'])).toThrow(/needs a value/);
    expect(() => parseRollbackArgs(['--rollback', '--steps', '--all'])).toThrow(/needs a value/);
    expect(() => parseRollbackArgs(['--rollback', '--steps', '0'])).toThrow(/at least 1/);
    expect(() => parseRollbackArgs(['--rollback', '--steps', '2', '--all'])).toThrow(/Say how far/);
    expect(() => parseRollbackArgs(['--rollback', '--to', 'a.sql', '--steps', '1'])).toThrow(/Say how far/);
  });
  it('takes steps, a name, or an explicit all, and nothing that allows stopping inside a pair', () => {
    expect(parseRollbackArgs(['--rollback', '--steps', '2'])).toEqual({ steps: 2 });
    expect(parseRollbackArgs(['--rollback', '--to', '042_data_policy_expand.sql'])).toEqual({ to: '042_data_policy_expand.sql' });
    expect(parseRollbackArgs(['--rollback', '--all'])).toEqual({ all: true });
    expect(parseRollbackArgs(['--rollback', '--steps', '1', '--allowUnsafeStop'])).toEqual({ steps: 1 });
  });
  it('the image has the command, and copies down/', () => {
    const root = path.join(MIGRATIONS, '..');
    expect(readFileSync(path.join(root, 'docker/entrypoint.sh'), 'utf8')).toMatch(/migrate-down\)\s+exec node dist\/src\/db\/migrate\.js --rollback "\$@"/);
    expect(readFileSync(path.join(root, 'Dockerfile'), 'utf8')).toMatch(/COPY --chown=root:root migrations \.\/migrations/);
    expect(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts['migrate:down']).toContain('--rollback');
    expect(readFileSync(path.join(root, '.dockerignore'), 'utf8')).not.toMatch(/migrations|\.sql/);
  });
});
