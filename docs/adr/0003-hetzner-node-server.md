# ADR-0003: Single Node server on a Hetzner VPS for the MVP

Status: Accepted

## Context

The product is one low-traffic club to start. Two hosting paths were considered: a single
small VPS running Node + Postgres, versus Cloudflare Workers (edge) + a serverless Postgres
(Neon via Hyperdrive). The author has an existing Cloudflare setup held in reserve and
familiarity with both.

## Decision

For the MVP, deploy the Nitro-built Node server and Postgres on a **single Hetzner VPS**. Do
not add Cloudflare Workers / wrangler, edge adapters, or Convex.

## Consequences

- No cold starts; the simplest possible Postgres access (same box, pooled connection).
- Pin the **same Postgres major** in dev (Docker) and on the VPS to avoid version-drift bugs.
- Cloudflare Workers + Neon/Hyperdrive remains a documented future option, justified only
  when multi-club scale (Phase 4) warrants it — not before.
