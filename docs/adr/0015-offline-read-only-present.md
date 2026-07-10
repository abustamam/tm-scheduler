# ADR-0015: Read-only offline Present/Print via a service worker

Status: Accepted

## Context

Clubs meet in person, often in venues with flaky or absent wifi. The meeting's projected slide
deck (`/club/$clubId/meeting/$meetingId/present`) and the printable agenda (`/…/print`) are the
surfaces a presenter relies on live, and today they simply break offline: the app is SSR-first
(TanStack Start over a Nitro node server, ADR-0007), so with no network there is no server to
render the HTML or run the route loader, and a reload white-screens (#174).

During triage we deliberately scoped this to **read-only** offline. Offline *minutes-taking*
(queuing attendance / Table Topics / award writes and syncing on reconnect — a local write queue,
optimistic state, last-write-wins reconciliation, and offline auth for the `_authed` minutes
screen) is a much larger effort and is deferred to a separate issue.

Two facts made a small, low-risk implementation possible:

- **Present and Print are public routes** (not under `_authed`), so there is no offline-session
  problem — no need to validate a magic-link session with no server.
- **TanStack Start inlines loader data into the SSR HTML** (the `$_TSR.router` dehydration blob)
  and does not refetch it on initial hydration, and `buildSlideDeck` / the print layouts render
  purely client-side. So a cached HTML **document** plus the cached JS/CSS assets is enough to
  re-render the full deck with zero network — we do **not** need to cache the server-function
  data endpoint.

## Decision

Ship a **hand-rolled service worker** (`public/sw.js`) rather than adopting `vite-plugin-pwa`.
For an SSR app with no static `index.html`, a build-time precache manifest buys little and adds
integration risk with the Nitro/TanStack Start build; runtime caching gives us exactly what the
warm-session model needs.

- **Priming is automatic on visit.** Loading a Present/Print page while online caches it — there
  is no "Make available offline" button. The presenter opening the deck at the top of the meeting
  *is* the priming step.
- **Caching strategy:**
  - Present/Print **navigations** → network-first (fresh when online and re-cached; the last
    cached copy when offline). Only these routes are cached at the navigation layer, so authed
    pages never enter the offline cache.
  - **Static assets** (script/style/font/image, `/_build/`, `/assets/`) → stale-while-revalidate.
  - POST and cross-origin requests are never intercepted.
- **Registration is production- and browser-only** (`registerServiceWorker`), so it never fights
  Vite's dev module graph / HMR.
- **Freshness is best-effort (stale-while-revalidate), not guaranteed.** When online, an agenda
  edit is picked up on the next load. When offline, a passive `OfflineBadge` names how stale the
  cached copy is ("Offline · showing the agenda as of …"); when online and cached it shows a quiet
  "Available offline" pill. No hard freshness rule, no conflict resolution.
- The **single Node-server model (ADR-0007) is unchanged** — the service worker is a client-side
  cache layer only.

## Consequences

- Present/Print survive a network drop **and an offline reload**, provided the page was loaded
  **as a full page at least once while online**. A meeting that was only ever reached by in-app
  client navigation (never a full document load) and then reloaded offline is not covered — this
  is an accepted limitation of the warm-session MVP, not a bug.
- Cold-start of a never-primed meeting with zero connectivity, and offline auth for `_authed`
  surfaces, remain out of scope.
- Bumping `VERSION` in `public/sw.js` invalidates all caches on the next activation.

## Deferred / out of scope

- **Offline minutes-taking** (writes queued during a live meeting, synced on reconnect) — separate
  issue. Single-device write queue, last-write-wins, and offline auth were all specified during
  triage but intentionally not built here.
- Full PWA install affordances beyond the existing (unused) `manifest.json`.
