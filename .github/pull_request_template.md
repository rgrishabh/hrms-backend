## What and why

<!-- One or two sentences. Title must follow Conventional Commits: feat|fix|chore|docs|refactor|test|ci(scope): summary -->

## How it was tested

- [ ] `npm run lint` and `npm test` pass locally
- [ ] New/changed behaviour has tests
- [ ] Migrations are forward-only and backwards compatible with the previous release (expand → migrate → contract)

## Risk

- [ ] Touches authentication, permissions, tenancy (RLS) or audit
- [ ] Needs new configuration (documented in `.env.example` and hrms-deployment)
