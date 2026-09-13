# 0002 — Postgres + Drizzle for users, projects, and sessions

Status: Accepted · Date: 2026-09-12 · Phase: 4

## Context

Phase 4 introduces the first data that has to survive a server restart and
be queried relationally: users, the projects they own, and their active
sessions. Nothing before this phase needed a real datastore — the Yjs
document lives in memory and is out of scope here. `CLAUDE.md`'s stack table
already names Postgres + Drizzle for this phase, so the question isn't
whether but how it's wired in, and that wiring is itself a one-way door: the
schema, the migration tooling, and the query layer all become load-bearing
the moment auth and ownership checks depend on them. The measured forcing
function is in journal 0004: before queries could be scoped by owner, only
1 of 4 entry points that touch a protected resource checked who owned it.

## Decision

Run Postgres via Docker Compose, bound to `127.0.0.1` only, with credentials
in a gitignored `.env` (a committed `.env.example` documents the shape).
Drizzle ORM defines the schema in TypeScript (`server/src/db/schema.ts`) and
`drizzle-kit` generates SQL migration files committed to `server/drizzle/`,
applied with `drizzle-kit migrate` rather than relying on Drizzle to infer
and apply schema changes at boot.

Three tables: `users` (email, scrypt password hash), `projects` (owned by a
user, cascade-deleted with them), `sessions` (a random token, not a JWT —
looked up per request, so nothing needs signing and a session can be revoked
by deleting a row).

## Alternatives rejected

**SQLite.** Simpler to run (a file, no Compose service), and would have been
fine for this phase alone. Rejected because Phase 6 introduces Kubernetes —
a file on one pod's disk doesn't survive that pod being replaced, and
migrating a live schema from SQLite to Postgres later is exactly the kind of
one-way-door cost this decision exists to front-load. Postgres in Compose
now costs one more container and teaches the real shape of the system
sooner.

**Raw `pg` with hand-written SQL.** Would avoid a dependency, and some
projects genuinely prefer it. Rejected here because migrations become
something to build by hand exactly when other phases (Kubernetes, S3,
orchestration) already carry enough new surface area — a schema-as-code tool
that generates reviewable SQL is worth the dependency at this specific
moment.

**Prisma.** Comparable feature set to Drizzle. Rejected on a narrower
ground: Drizzle's queries are closer to SQL and its generated migrations are
plain, readable `.sql` files with no separate binary runtime — easier to
read a diff of what changed in `server/drizzle/*.sql` than to read a Prisma
migration's internal format.

## Consequences

Auth and project ownership now have somewhere real to live, and the fix for
this phase's wall (`docs/journal/0004-authn-is-not-authz.md`) depends on
being able to scope a query by `ownerId` — that requires a relational store
with real `WHERE` clauses, which was the actual forcing function for this
decision, not just "the plan said so."

What this makes harder:

- **A migration step now exists in the setup path.** Anyone cloning the repo
  needs Docker Compose running and `drizzle-kit migrate` applied before
  anything auth-related works — one more thing to get right, documented in
  the README.
- **Schema changes are no longer free.** Every future column or table is a
  generated migration file committed to git, reviewed, and applied in order.
  That's the point of using Drizzle this way rather than schema-push, but it
  is friction that wasn't there in Phases 1–3.
- **Postgres becomes a dependency of local dev**, not just of "production
  later." If Docker Desktop isn't running, nothing that touches auth or
  projects works, which is a new failure mode to recognize (see the README's
  setup section).
- **The eventual move to Kubernetes (Phase 6) will need this database
  reachable from inside the cluster**, or replaced with a managed instance —
  today's `127.0.0.1`-only binding is explicitly a localhost-phase choice,
  not a permanent one.
