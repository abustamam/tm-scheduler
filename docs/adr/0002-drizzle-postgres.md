# ADR-0002: Drizzle ORM + PostgreSQL for the data layer

Status: Accepted

## Context

The domain is relational: clubs, memberships, meetings, role definitions, slots, and the
links between them (a slot belongs to a meeting and a role definition; an evaluator slot
references a speaker slot). Reporting like "who has done what" is a join over historical
slots. An early scaffold attempt brought in **Convex**, a hosted reactive backend, which
replaces this relational model and nudges toward Convex Cloud hosting — against the self-host
plan (ADR-0003).

## Decision

Use **Drizzle ORM** over **PostgreSQL** via `drizzle-orm/node-postgres` (the `pg` driver).
The db client is `src/db/index.ts`; schema in `src/db/schema.ts`. Convex was removed.

## Consequences

- Foreign keys, indexes, and joins model the domain directly; the history query is just SQL.
- Migrations via `drizzle-kit` (`db:generate` / `db:migrate`, `db:push` for dev).
- Better-Auth persists through its Drizzle adapter; its generated tables live in
  `src/db/auth-schema.ts` and are re-exported from `schema.ts` so one namespace covers all.
- A long-lived Node process holds a pooled `pg` connection — consistent with ADR-0003 and
  simpler than edge/serverless Postgres access.
