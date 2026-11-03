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

## Image

One image for every environment and customer; configuration comes from the environment at runtime.

| Command | Does |
|---|---|
| `serve` (default) | API server on `:4000`, JSON logs to stdout, graceful shutdown on SIGTERM |
| `migrate` / `migrate-status` | Apply pending migrations (forward-only, checksummed) / exit 0 current, 2 pending, 3 unknown |
| `provision` | Create or rotate the database roles (needs admin credentials) |
| `bootstrap` | Create the organization and first administrator (one-time setup link) |

Health: `GET /health` (liveness) and `GET /ready` (database reachable, migrations current, organization bootstrapped).
`/health/live` and `/health/ready` remain for existing deployments.

## Branches and releases

- Feature branches → PR to `develop` (squash). CI runs lint, tests, image build, Trivy and gitleaks, and comments on the PR.
- Merge to `develop` → image `ghcr.io/rgrishabh/hrms-backend:sha-<short>` is pushed, signed and **deployed to dev automatically**.
- PR `develop` → `main` (rebase). release-please keeps a release PR open from Conventional Commits; merging it tags `vX.Y.Z`,
  publishes `:vX.Y.Z`, and opens a production version PR in hrms-deployment (production needs one approval).

Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:` …).

## Documentation

[ARCHITECTURE](ARCHITECTURE.md) · [SECURITY](SECURITY.md) · [DECISIONS](DECISIONS.md) · [TESTING](TESTING.md) ·
[IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md) · [INDIAN_PAYROLL_COMPLIANCE](INDIAN_PAYROLL_COMPLIANCE.md) · [docs/](docs/) (API and per-module guides)
