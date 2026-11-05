# hrms-backend

HRMS API: Fastify 5 + TypeScript on Node.js 22, PostgreSQL 17 (row-level security), white-label per installation.
The web app lives in [hrms-frontend](https://github.com/rgrishabh/hrms-frontend); environments, Terraform and
pipelines in [hrms-deployment](https://github.com/rgrishabh/hrms-deployment).

## Develop

```bash
cp .env.example .env            # fill DATABASE_URL / DATABASE_MIGRATION_URL / DATA_ENCRYPTION_KEY
npm ci
npm run migrate && npm run seed # local demo data (refuses non-local databases)
npm run dev                     # http://127.0.0.1:4000 — run hrms-frontend's `npm run dev` for the UI
npm run lint && npm test        # tests need the hrms_test* databases (see TESTING.md)
```

## Demo data for dev installations

`demo` (image command) / `npm run demo` fills a **freshly bootstrapped, empty** installation with a synthetic
60-person testing laboratory: 3 branches, 11 departments, a manager hierarchy, 30 days of punches (calculated),
leave balances and approved leave history, expense claims, training records and technical authorizations, published policies,
recruitment pipeline, salaries, assets with calibration dates, an active review cycle and a POSH committee.
It creates 10 persona logins (`director@`, `hr.head@`, `hr.exec@`, `payroll@`, `finance@`, `lab.manager@`,
`quality@`, `it@`, `analyst@`, `sampler@` the organization's domain) sharing one random password, printed to
STDOUT only — redirect it to a protected file.

Guards: requires `DEMO_DATA_ALLOWED=true`; refuses if any employee exists whose code is not `DM-…` (so it can
never mix into real data); idempotent. It never creates statutory payroll rules.

## Image

One image for every environment and customer; configuration comes from the environment at runtime.

| Command | Does |
|---|---|
| `serve` (default) | API server on `:4000`, JSON logs to stdout, graceful shutdown on SIGTERM |
| `migrate` / `migrate-status` | Apply pending migrations (checksummed) / exit 0 current, 2 pending, 3 unknown |
| `migrate-down --steps N` \| `--to NAME` \| `--all` | Undo migrations, see [Rolling back migrations](#rolling-back-migrations). There is no default |
| `provision` | Create or rotate the database roles (needs admin credentials) |
| `bootstrap` | Create the organization and first administrator (one-time setup link) |

Health: `GET /health` (liveness) and `GET /ready` (database reachable, migrations current, organization bootstrapped).
`/health/live` and `/health/ready` remain for existing deployments.

### Rolling back migrations

An image rollback normally needs no migration rollback: migrations are expand/contract and an older build serves on a newer schema. Roll migrations back only when that does not hold, and take a backup first.

Every migration has a way back: `migrations/down/<same name>.sql`, or `down` for a code step in `src/db/code-migrations.ts`.

```sh
hrms migrate-down --steps 2            # the last two
hrms migrate-down --to 041_notification_feature.sql   # everything after this one, which stays applied
hrms migrate-down --all                # everything
npm run migrate:down -- --steps 1      # the same, from a checkout
```

1. Stop the API and worker of the release being left.
2. Run `migrate-down` **from the image being left**: only an image that shipped a migration has its down file. It needs `DATABASE_MIGRATION_URL`, and the data key if the range includes `043` and sealed rows exist.
3. Deploy the older image without running migrations, for example with `rollback-prod.yml` in the deployment repository.

Before changing anything, the command refuses when a down file is missing, an applied file was edited, the key cannot open the sealed values, or the target stops between `044` and `043`. Each down file is one transaction and its `schema_migrations` row goes with it, under the same advisory lock as `migrate`. If it stops part way, run it again: what finished is no longer applied, and `043` skips rows it already did. Down `044` leaves placeholders in the pay columns that only down `043` replaces, which is why the two cannot be separated. If a run stops between them, finish it before starting any older build.

**What a rollback gets back is the structure, not all the data.** These cannot return:

| Down of | Lost |
|---|---|
| `047` | Throttle counters, known devices, email codes, `security.mfa_enforcement` rows. Mail holding a sealed secret is marked failed, unused reset and invitation links are spent, and people enrolled in email codes have **MFA turned off** until they enrol again, since the older build would lock them out. |
| `044` | The audit hash chain. Going up again chains the rows as they are then, so it would not reveal a change made in between. `owner` becomes `tenant_admin`. |
| `043` | Pay comes back in plaintext, using the key. It does not undo what the step removed for good: text scrubbed of amounts, audit metadata scrubbed of amounts, and old `payroll_cost` and `department_overview` snapshots. A snapshot's sealed list of subjects has no plaintext column. |
| `042` | Aadhaar numbers, salary levels, who self-approved, snapshot viewer levels, the user agent on audit rows. |
| `040`, `039` | Geofences, selfie records, push subscriptions. All SMS data: the tables return empty and every opt-out returns to its default, on. The `tenant_modules`, entitlement and definition rows those migrations deleted. |
| `038` | Queued job runs are marked failed, to be run again by hand. |
| `036`, `035`, `034` | The `overlap_legacy` marks. Who released held pay, when and why. Bank changes waiting for approval. |
| `032` | `carry_out` ledger entries become `adjustment` with a note, so balances still add up. Going up does not turn them back. Year closures. |
| `021`, `006` | `on_duty` days become `present` and `on_leave` days become `absent`. Recalculate days that are not locked. |
| Anything else | A down that drops a table or column drops what it holds. Going up again gives an empty one. |

Stored files are not touched: rows for documents and selfies go, the objects stay.

A migration that needs `CREATE INDEX CONCURRENTLY` starts with the exact first line `-- hrms:no-transaction`, in the up file, the down file, or both. Each statement then runs on its own, and the file is recorded after the last one. A failure part way leaves earlier statements in place and the file unrecorded, so the next run starts it again: **such a file must be idempotent** (`IF NOT EXISTS`, `IF EXISTS`). If a failed build leaves an invalid index, the next run stops and names it rather than letting `IF NOT EXISTS` hide it. Drop it and run again.

A new migration needs its down file in the same commit. `test/migrations-reversible.test.ts` fails without one, and fails if the schema after a down differs from the schema before the up.

## Branches and releases

- Feature branches → PR to `develop` (squash). CI runs lint, tests, image build, Trivy and gitleaks, and comments on the PR.
- Merge to `develop` → image `ghcr.io/rgrishabh/hrms-backend:sha-<short>` is pushed, signed and **deployed to dev automatically**.
- PR `develop` → `main` (rebase). release-please keeps a release PR open from Conventional Commits; merging it tags `vX.Y.Z`,
  publishes `:vX.Y.Z`, and opens a production version PR in hrms-deployment (production needs one approval).

Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:` …).

## Documentation

[ARCHITECTURE](ARCHITECTURE.md) · [SECURITY](SECURITY.md) · [DECISIONS](DECISIONS.md) · [TESTING](TESTING.md) ·
[IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md) · [INDIAN_PAYROLL_COMPLIANCE](INDIAN_PAYROLL_COMPLIANCE.md) · [docs/](docs/) (API and per-module guides, incl. RECRUITMENT)
