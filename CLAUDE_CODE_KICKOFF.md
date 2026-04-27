# Claude Code kickoff prompt — Courtside (Phase 0)

Copy everything below the line into Claude Code as your opening message.
Have these files already in the working directory before you start:

- `PLAN.md`
- `CLAUDE.md`
- `schema.sql`
- `MIGRATION_ORDER.md`

---

You are joining a project mid-design. Most of the architectural work
has been done in conversation already; my job in this session is to
hand it off to you cleanly, and your job is to start implementing
Phase 0.

Before you do anything, read these four files in this order:

1. `PLAN.md` — the project plan. Phases 0–6, scope decisions,
   v1.1 backlog, risks. This is the strategic context.
2. `CLAUDE.md` — terminology, conventions, gotchas, RLS discipline,
   credit ledger enforcement rules, glossary. Read this carefully —
   it has invariants you must not violate.
3. `schema.sql` — the canonical database schema. ~2100 lines, 20
   tables, comprehensive invariants. Don't skim it; the constraints
   matter.
4. `MIGRATION_ORDER.md` — the 11-file migration plan that splits
   `schema.sql` into deployable chunks, plus the privilege migration
   and out-of-band Phase 0 deliverables.

After reading, summarize back to me:

- What product are you building?
- Who is the first tenant going to be, and what's their current
  setup?
- What are the three biggest risks called out in PLAN.md for Phase 3?
- What is the rule about transactions and external API calls in
  CLAUDE.md?
- What does `apply_credit_change` do, when is it built, and why is it
  `SECURITY DEFINER`?

If you can't answer those crisply, re-read the files. Don't proceed
to coding until you can.

## What we are doing in this session

Phase 0 from PLAN.md. The whole of Phase 0, broken into checkpoints
where you stop and confirm with me before continuing. Phase 0's goal:
**a multi-tenant skeleton with no user-facing features, ready to
build on.**

Specifically:

- New repo (you'll scaffold; I'll create the GitHub repo and push)
- New Supabase project (I'll create; you'll write the migrations)
- New Railway service (I'll create; you'll write the deploy config)
- Multi-tenant schema applied via the migrations from
  `MIGRATION_ORDER.md` files 001–011
- Subdomain routing middleware (`{tenant}.app.com`)
- Tenant context middleware that wraps every tenant-scoped request —
  including login and register, not just authenticated ones — in a
  transaction with `set_config('app.current_tenant_id', ..., true)`
- Auth scaffolding (no UI yet — just the backend pieces)
- The `tenant_lookup` view + role grants per migration 011
- A smoke test that the runtime role cannot read billing fields from
  `tenants`
- Health check endpoint
- CI pipeline that runs the smoke test

We are NOT doing in this session:

- Any user-facing features (those are Phase 1+)
- Applying migrations to live Supabase (that happens after you've
  written all the migration files and I've created the Supabase
  project)
- Deploying to Railway (same — after migrations are written and
  Supabase exists)
- The `apply_credit_change` SECURITY DEFINER function (Phase 2)
- More granular RLS policies (Phase 2)

## Working agreement

These rules are non-negotiable:

1. **Stop at checkpoints.** When you've finished a meaningful unit
   of work, stop and tell me what you did. Don't barrel into the next
   thing. The natural checkpoints for Phase 0 are:
   - After scaffold (repo structure, package.json, deps)
   - After each migration file (or small group of related ones)
   - After the tenant context middleware
   - After the auth scaffolding
   - After the tenant_lookup view + privilege smoke test
   - After CI is green

2. **Ask before doing anything that touches a real service.**
   Creating Supabase projects, GitHub repos, Railway services,
   pushing branches, opening PRs, applying SQL to a live database —
   all of these need explicit confirmation from me first. You can
   prepare the work; you cannot execute the externally-visible part
   without me saying go.

3. **Don't deviate from the schema.** The schema in `schema.sql` has
   been through nine review rounds. If you find something that looks
   wrong, flag it and ask — don't silently "fix" it. Most of the
   non-obvious choices have explicit reasons in the comments or in
   `CLAUDE.md`.

4. **Use the canonical glossary.** `tenant`, `member`, `customer`,
   `offering`, `resource`, `booking`, `class_booking` — these are
   the only words. Don't introduce synonyms in code, route names,
   variable names, or docs. UI copy can be different (per CLAUDE.md);
   code cannot.

5. **No `pool.query` in tenant-scoped routes.** Use the
   `withTenantContext` middleware (which you'll write) and the
   transaction-bound client it provides. CLAUDE.md explains why.

6. **Don't reach for ORMs.** Stay on raw SQL via `pg`. The schema is
   complex enough that an ORM will fight us; the existing code
   patterns (visible in the old Diamond Club Portal repo if useful)
   work fine.

7. **Match the existing tech choices unless you have a strong
   reason to deviate.** Express, Vite + React + Tailwind v3, `pg`
   for Postgres, JWT auth, Resend for email. PLAN.md and CLAUDE.md
   list these. If you think something else is better, ask — don't
   change it unilaterally.

8. **Test the privilege boundary.** The smoke test that runtime
   cannot read `tenants.platform_stripe_customer_id` is load-bearing.
   Make it a real test that runs in CI, not a manual check.

## What to do first

Once you've read the four files and answered the comprehension
questions, propose a Phase 0 task breakdown. Roughly:

- Repo scaffold and dep choices
- Migration files 001–011
- Backend skeleton (Express, middleware, routes structure, no
  features)
- Frontend skeleton (Vite + React + Tailwind, just enough to render
  "hello tenant: foo")
- Supabase setup checklist (for me to follow)
- Railway setup checklist (for me to follow)
- CI configuration with the smoke test

Call out any decisions you'd make differently from what the docs
specify, and any places where the docs are silent and you'd want to
make a call. Don't start coding until I confirm the breakdown.

## On placeholder names

The repo placeholder name is `courtside`. I haven't picked a real
name yet. Use `courtside` everywhere for now; I'll do a global
find-and-replace when I land on the real name. Don't waste cycles
suggesting names — I'll handle that separately.

## On the existing Diamond Club Portal

This new project is a multi-tenant SaaS rebuild of an existing
single-tenant app called Diamond Club Portal that runs Momentum
Sports (a baseball facility in Staten Island). Momentum will be the
first tenant on the new platform once Phase 6 ships. The old portal
will be archived after migration.

You don't need to read the old codebase. The patterns we want from
it are already captured in `CLAUDE.md` and `schema.sql`. If you find
yourself wanting to look at the old code, ask first — usually the
answer is "no, the new shape is different enough that the old code
will mislead you."

## Caveat on speed

I've spent ~8 hours in conversation getting the schema and plan to
this point. The schema is comprehensive and the plan is realistic
(17 weeks at 15-20 hrs/week). The way this work fails is **going
fast and skipping steps**. The way it succeeds is methodical
checkpoint-by-checkpoint progress.

If you find yourself wanting to "just knock out Phase 0 in one big
push," that's the failure mode. Stop, propose, confirm, do, repeat.

Acknowledge this prompt by reading the files and answering the
comprehension questions. Then propose your Phase 0 task breakdown.
Don't write any code yet.
