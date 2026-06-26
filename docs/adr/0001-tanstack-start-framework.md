# ADR-0001: TanStack Start as the application framework

Status: Accepted

## Context

The app is interaction-heavy: authentication, frequent mutations (claim/release), and
live-ish reads of a shared agenda. Candidate stacks the author was fluent in included Astro,
Next.js, React Router, and TanStack. Astro is content-first and fights you once an app needs
pervasive client interactivity and server mutations.

## Decision

Use **TanStack Start** (React 19, SSR via Nitro, file-based routing), with TanStack Query
SSR-integrated for client data. Author's preferred stack and the best fit for an app-like
(not content-like) product.

## Consequences

- Server logic uses TanStack Start server functions (`createServerFn`), co-located in
  `src/server/*`.
- Nitro emits a self-contained Node server, which keeps deployment host-agnostic (see
  ADR-0003).
- Scaffolding was done with the TanStack CLI using explicit add-ons rather than the AI-first
  Builder, which had previously pulled in unrequested Convex/Cloudflare/Sentry.
