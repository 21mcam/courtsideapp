# CI setup

The CI workflow lives at [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
and runs on every PR + every push to `main`. It activates
automatically the first time you push the repo to GitHub — no setup
needed in the GitHub UI, no secrets to configure.

## What it does

For each run:

1. Checkout + Node 20 LTS setup (with npm cache)
2. `npm ci` and `npm --prefix client ci`
3. `npm run lint` — ESLint must pass (warnings allowed, errors fail)
4. `npm --prefix client run build` — Vite must produce a build (catches
   React/JSX errors before merge)
5. **Spin up a disposable Postgres 15 service container** with a
   throwaway password and an empty `courtside_test` database
6. Wait for `pg_isready` (turns "DB wasn't ready yet" into a clean
   error rather than a silent migration failure)
7. **Replay migrations 001–011 in order** with `psql -v
   ON_ERROR_STOP=1 -f` — any SQL error aborts the loop loud
8. `ALTER ROLE app_runtime PASSWORD 'ci_password'` — sets a fixed
   disposable password
9. `npm test` with `DATABASE_URL` pointing at the disposable DB —
   runs the privilege smoke test:
   - **guard**: connected role is non-superuser, non-BYPASSRLS
     (catches misconfiguration before the next 3 tests can silently
     pass under a privileged role)
   - `SELECT … FROM tenants` errors with `42501 insufficient_privilege`
     → migration 011's REVOKE is in place
   - `SELECT … FROM tenant_lookup` succeeds → grant is in place
   - `nextval(credit_ledger_entries_entry_number_seq)` succeeds →
     `GRANT USAGE ON ALL SEQUENCES` is in place

If any of these fail, the PR can't merge (assuming branch protection
is on).

## No secrets required

Everything CI needs is created inside the workflow run:
- Postgres lives in a service container with a hardcoded throwaway
  password (`ci_postgres_password`)
- `app_runtime` is created by migration 011, then given a hardcoded
  throwaway password (`ci_password`)

Both passwords only exist for the lifetime of the runner VM. They
cannot leak anywhere meaningful — the Postgres instance is
unreachable from outside the runner.

This means you don't have to put your real Supabase credentials in
GitHub Secrets, and a compromised PR can't exfiltrate prod
credentials via the workflow.

## Triggers

```yaml
on:
  pull_request:
  push:
    branches: [main]
```

- **PR**: every PR, every commit to a PR. This is the real merge gate.
- **Push to `main`**: belt-and-suspenders coverage for direct commits,
  rebases, and merge commits. Won't *prevent* a Railway deploy (Railway
  reads `main` directly), but a red CI on `main` is a loud signal
  something slipped through review.

## Branch protection (recommended, not configured yet)

To turn CI from a "loud signal" into a hard merge gate:

1. GitHub repo → **Settings** → **Branches** → **Branch protection
   rules** → **Add rule**
2. Rule applies to `main`
3. Check **Require a pull request before merging**
4. Check **Require status checks to pass before merging** → search for
   `lint, build, migrations, smoke test` (the job name from `ci.yml`)
5. Check **Require branches to be up to date before merging**
6. Save

After this, GitHub refuses to merge a PR with a red CI, and you can't
push directly to `main` without a PR.

This is a follow-up step for after Phase 0 — the kickoff explicitly
deferred branch protection.

## Adding a new migration

Add `db/migrations/012_*.sql` (next number) and commit. CI's loop is
`for f in db/migrations/*.sql` — it picks up the new file
automatically. If your migration breaks the chain (forgets a FK,
references a missing table, etc.), CI fails on the migration replay
step before any test runs.

## Adding a new test

Drop a `tests/foo.test.js` file. The `npm test` command uses the glob
`tests/*.test.js`, so any new file is picked up. Each `test('name',
fn)` from `node:test` becomes a separate assertion in the report.

## Reading a failure

Click the failing run in the Actions tab → expand the failed step.
The most informative steps:

- **Lint** failure → ESLint output names the file and line.
- **Build client** failure → Vite/React error in the bundle.
- **Apply migrations** failure → `psql` output shows the offending
  SQL line. Look for the `::group::applying NNN_*.sql` marker
  immediately above to find which migration broke.
- **Run privilege smoke test** failure → assertion message names which
  invariant broke. The most common cause is editing migration 011's
  GRANTs or REVOKEs without updating the test.

## When the smoke test fires unexpectedly

If the **guard** test ("connected role is not a superuser") fails,
something changed `DATABASE_URL` to point at `postgres` instead of
`app_runtime`. Don't ignore it — fix immediately. The whole privilege
boundary depends on the runtime not being superuser; if the guard
were silent, the other three tests would pass against `postgres`
without proving anything.

## What CI does NOT do

- Deploy. Railway auto-deploys from `main` independently.
- Apply migrations to live Supabase. Migrations are manual against
  Supabase; CI only replays them against a disposable DB.
- Run frontend tests (we don't have any in Phase 0).
- Run end-to-end tests (we don't have any in Phase 0).

These are reasonable to add post-Phase-0 if/when needed.
