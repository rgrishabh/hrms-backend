## What and why

<!-- One or two sentences. Title must follow Conventional Commits: feat|fix|chore|docs|refactor|test|ci(scope): summary -->

## How it was tested

- [ ] `npm run lint` and `npm test` pass locally
- [ ] New/changed behaviour has tests
- [ ] Each new migration has a `migrations/down/` file, and works with the previous release (expand → migrate → contract). What a down cannot bring back is in the README
- [ ] `npm run test:coverage` keeps its thresholds; a new route declares its schema, permission and feature

## Risk

- [ ] Touches authentication, permissions, tenancy (RLS) or audit
- [ ] Needs new configuration (documented in `.env.example` and `hrms-deployment/docs/CONFIGURATION.md`)
- [ ] Changes an answer's shape: `npm run openapi` diff read; frontend told
