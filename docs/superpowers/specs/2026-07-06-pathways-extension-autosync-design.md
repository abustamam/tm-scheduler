# Pathways auto-sync browser extension — design

Date: 2026-07-06
Issue: closes #107 (browser-extension auto-sync).
Builds on: `docs/superpowers/specs/2026-07-06-pathways-progression-model-design.md`
(the v1 manual-paste ingest and the count-based mirror model).
Domain: extends CONTEXT.md "Pathways".

## North star

Base Camp is the system of record for Pathways education; this app mirrors it and celebrates
wins (see the progression-model spec). The v1 sync makes a club officer copy each
`/api/bcm/progress` page out of DevTools by hand and paste it into an admin box. **This ticket
removes that toil**: a Chromium extension, running in the officer's already-authenticated Base
Camp session, walks every progress page and POSTs the result straight to our server — one click,
no paste.

It changes **only how the data arrives**. The parse/upsert/mirror logic (`normalizePages`,
`parseProgressPages`, `syncClubProgress`) is reused verbatim; the manual paste box remains as a
documented fallback.

## Decisions (resolved during brainstorming + grilling)

1. **End-to-end auto-sync**, not just "automate the copy." The extension POSTs directly to a new
   authenticated REST endpoint — no clipboard round-trip.
2. **Per-club API token** is the auth mechanism, and the token *is* the club identity: the server
   derives `clubId` from the token, so auth and club-mapping collapse into one credential.
3. **Unpacked MV3 extension, Chromium only, in this repo** (`extension/`). No Chrome Web Store,
   no Firefox for v1. Officers install via "Load unpacked" / a hosted release.
4. **Two contexts, split by origin.** A content script on the Base Camp tab does the Base Camp
   fetch (same-origin → cookies flow, and it reads the `csrftoken` cookie); the service worker
   does the POST to us (host_permissions → no CORS needed on our endpoint).
5. **Club GUID is observed, not scraped from app state.** The content script captures the
   `club=<guid>` param off the page's own first `/api/bcm/progress` request; a manual GUID field
   in the popup is the fallback.
6. **Wrong-club guard is soft-warn, not hard-block.** The server stores the observed GUID on the
   token row and returns a `warning` when a later sync's GUID differs; roster-scoped matching
   already prevents cross-club corruption (mismatched rows land as `unmatched`).
7. **Tokens are standalone capabilities**, revoked explicitly — not tied to the minting admin's
   live role. Forced expiry is a documented future option, not built now.
8. **Two builds:** the released extension is pinned to `https://gavelup.app` (single host
   permission); a separate unpacked dev build also whitelists `http://localhost:3000` and exposes
   a "server URL" field. Prod officers get the locked-down build.
9. **All-or-nothing page walk.** Any Base Camp page error aborts the sync and POSTs nothing; the
   popup says "Sync failed on page N — retry." `syncClubProgress` is idempotent, so retrying the
   whole walk is free. A silent partial sync (some members stale, looks successful) is the failure
   mode we refuse.

## Architecture

Three independently testable pieces:

```
┌─ extension/ (MV3, Chromium) ──────────────────────────────────┐
│  content script (basecamp.toastmasters.org)                   │
│    · observe the page's first /api/bcm/progress → capture guid│
│    · on "Sync": walk pages 1..N (same-origin, cookies +        │
│      X-CSRFToken from document.cookie), collect raw page objs  │
│    · message the pages array to the service worker             │
│  service worker                                                │
│    · POST pages array → GavelUp /api/pathways/ingest           │
│      (Authorization: Bearer <token>)                           │
│  popup                                                          │
│    · token field (stored once), optional manual GUID field,    │
│      "Sync now", result/warning line                           │
└───────────────────────────────────────────────────────────────┘
                          │ Bearer gup_…   body: { basecampClubGuid, pages:[ {results:[…]}, … ] }
                          ▼
┌─ POST /api/pathways/ingest  (new TanStack server.handlers route)┐
│  1. Bearer token → SHA-256 → sync_tokens row (revokedAt IS NULL)│
│     · missing / revoked → 401                                   │
│  2. row → clubId; touch lastUsedAt; GUID soft-warn (see below)  │
│  3. normalizePages → parseProgressPages        ← reused verbatim│
│  4. syncClubProgress(clubId, rows)             ← reused verbatim│
│  5. 200 { ...SyncResult, warning? }                             │
└────────────────────────────────────────────────────────────────┘
┌─ Settings UI (existing admin area) ───────────────────────────┐
│  "Generate sync token" → shows gup_… ONCE (hash stored)        │
│  list tokens (name · createdBy · lastUsedAt) · revoke          │
└───────────────────────────────────────────────────────────────┘
```

Why the token skips `requireClubRole`: possessing a club-scoped token *is* the authorization
(it was minted by an admin). The endpoint checks `revokedAt IS NULL` and nothing about the
current caller's session — the extension has no GavelUp session.

## Server contract

### New table `sync_tokens`

| column              | type                     | notes                                        |
|---------------------|--------------------------|----------------------------------------------|
| `id`                | uuid pk                  |                                              |
| `clubId`            | uuid → clubs.id          | the club this token ingests into             |
| `tokenHash`         | text, unique, indexed    | SHA-256 hex of the raw token; raw never stored |
| `name`              | text, nullable           | officer-supplied label ("VPE laptop")        |
| `basecampClubGuid`  | text, nullable           | observed on sync; drives the soft-warn (#6)  |
| `createdBy`         | text/uuid (user id)      | audit                                        |
| `createdAt`         | timestamp, default now   |                                              |
| `lastUsedAt`        | timestamp, nullable      | touched on every successful ingest           |
| `revokedAt`         | timestamp, nullable      | non-null → 401                               |

Token format: 32 random bytes, base64url, prefixed `gup_`. Lookup is by `tokenHash` (indexed),
so there is no secret to compare in constant time. Plain SHA-256 is adequate — the token is
high-entropy and not brute-forceable, so a slow hash (bcrypt/argon2) buys nothing.

### New route `src/routes/api/pathways/ingest.ts`

`server.handlers` `POST` (same shape as `src/routes/api/health.ts`):

- Read `Authorization: Bearer <token>`; SHA-256; look up `sync_tokens` where `tokenHash` matches
  and `revokedAt IS NULL`. Miss → **401** `{ error }`.
- Parse `application/json` body — an object `{ basecampClubGuid: string, pages: BcmProgressPage[] }`
  where `pages` is the **array of raw Base Camp page objects** (each `{results:[…]}` as Base Camp
  returned it). Feed `pages` straight to `normalizePages` → `parseProgressPages`. Malformed →
  **400** `{ error }` (reuse the existing "doesn't look like a Base Camp progress payload" copy).
- Soft-warn (#6): if `sync_tokens.basecampClubGuid` is set and the body's `basecampClubGuid`
  differs, include
  `warning: "This looks like a different Base Camp club than last time."` in the response. If it
  is null, store the observed GUID. Either way, continue processing.
- Call `syncClubProgress(clubId, rows)`; touch `lastUsedAt`. Return **200** with
  `SyncResult & { warning?: string }`.

No CORS/OPTIONS handling: the service-worker POST uses `host_permissions`, so the request is not
subject to CORS.

### Token management server functions

Admin-guarded `createServerFn`s (reuse `requireUser` + `requireClubRole(user.id, clubId,
["admin"])`), living in a `sync-tokens.ts` server-fn module with DB logic in
`sync-tokens-logic.ts` (server-modules guard — `pg` must not reach the client bundle):

- `generateSyncToken({ clubId, name? })` → mints a token, stores only the hash, returns the raw
  value **once**.
- `listSyncTokens({ clubId })` → id, name, createdBy, lastUsedAt, revokedAt (never the raw token
  or hash).
- `revokeSyncToken({ tokenId })` → sets `revokedAt`.

### Settings UI

A section in the existing admin area (alongside `_authed/admin/pathways-sync`): generate (shows
the token once with a copy button and a "you won't see this again" note), list, revoke. Links to
the extension install instructions.

## Extension internals

- **`manifest.json`** (MV3): `host_permissions` = `https://basecamp.toastmasters.org/*` +
  `https://gavelup.app/*` (dev build adds `http://localhost:3000/*`); `storage`; an action popup;
  a content script matched on `https://basecamp.toastmasters.org/*`.
- **content script**: hooks `fetch`/`XMLHttpRequest` to observe the first `/api/bcm/progress`
  request and capture `club=<guid>`. On a Sync message, walks `GET /api/bcm/progress/?club=<guid>
  &page=N` following `next` until null, sending the recipe headers (`USE-JWT-COOKIE: true`,
  `X-Platform: pathways`, `X-CSRFToken` from the `csrftoken` cookie, `Accept: application/json`);
  the browser attaches the Base Camp cookie jar (same-origin). Collects the raw page objects into
  an array and messages it to the service worker. Any page error → abort, report the failing page
  number, send nothing (#9).
- **service worker**: receives the pages array, POSTs it to the configured server URL's
  `/api/pathways/ingest` with `Authorization: Bearer <token>`, relays the `SyncResult`/`warning`/
  error back to the popup.
- **popup**: token field + optional manual GUID field (both persisted in `chrome.storage.local`),
  a "Sync now" button, and a result line ("Matched 23 · 2 paths updated · 2 unmatched", or a
  warning, or an error). Dev build adds a "server URL" field defaulting to prod.

Secrets discipline: Base Camp cookies are attached by the browser and never read, logged, or
persisted by the extension. The only stored value is our own token (in `chrome.storage.local`).

## End-to-end data flow

```
Officer opens Base Camp → Paths Progress   (Base Camp session live)
  · page fires its own /api/bcm/progress → content script captures club-guid
  └ click extension → "Sync now"
       ├ content script: walk pages 1..N (follow `next`) → [ {results:[…]}, … ]
       │     (any page error → abort, "Sync failed on page N — retry")
       └ → service worker → POST /api/pathways/ingest (Bearer token, { basecampClubGuid, pages })
            ├ token hash → sync_tokens → clubId  (revokedAt IS NULL else 401)
            ├ GUID soft-warn vs stored basecampClubGuid; touch lastUsedAt
            ├ normalizePages → parseProgressPages
            └ syncClubProgress(clubId, rows)  → 200 { ...SyncResult, warning? }
  └ popup shows "Matched 23 · 2 paths updated · 2 unmatched" (+ warning if any)
```

## Error handling

| Failure                                | Behavior                                                        |
|----------------------------------------|----------------------------------------------------------------|
| No/invalid token in popup              | Popup blocks Sync, prompts to paste a token                     |
| Base Camp session expired (page fetch) | Abort; popup: "Sign into Base Camp and retry" — nothing sent    |
| Club GUID not observed                 | Popup falls back to the manual GUID field                       |
| Any page fails mid-walk (#9)           | Abort; "Sync failed on page N of M — retry"; nothing POSTed     |
| Bad/revoked token at our endpoint      | **401** `{ error }`; popup: "Token invalid — regenerate in Settings" |
| Malformed payload                      | **400** `{ error }` (reuses existing Base Camp-shape message)   |
| Wrong Base Camp club (#6)              | **200** with `warning`; popup surfaces it; unmatched rows listed |
| Partial success (unmatched members)    | **200**; popup lists unmatched, same semantics as the manual box |

## Security

- Sync tokens stored **hashed** (SHA-256), shown once, revocable, `lastUsedAt` for audit.
- Tokens are **club-scoped**: a leaked token can only write to its own club, and
  `syncClubProgress` already scopes identity matching to that club's roster — so a token can never
  overwrite another club's members' Base Camp identity.
- A token holder can POST arbitrary progress JSON for their club (e.g. fabricate `approved`), the
  same authority a club admin already has via the manual paste box. Accepted: tokens are
  admin-minted, Base Camp remains system of record, and the next real sync overwrites. Rate
  limiting is out of scope (low-traffic, admin-only credential).
- Base Camp session tokens are transient/browser-attached and never read, logged, or persisted;
  `.har` capture samples stay gitignored (progression-model spec's PII rule).

## Testing

- **Endpoint (Vitest, `tm_test`)**: token hash → clubId; 401 on missing/revoked/unknown token;
  400 on malformed body; happy path 200 returns a `SyncResult`; GUID soft-warn fires on mismatch
  and stores on first sync; `lastUsedAt` is touched.
- **Token mgmt logic**: generate returns the raw token once and stores only the hash; list never
  exposes raw/hash; revoke sets `revokedAt` and subsequent ingest 401s.
- **Server-modules guard**: the new server-fn module exports only `createServerFn`s/types; DB
  logic sits in `*-logic.ts` (existing guard test must still pass — `pg` out of the client bundle).
- **Extension**: unit-test the pure page-walk/concatenate logic against a mocked `fetch` over a
  multi-page `next` chain, including the mid-walk abort (#9). A written manual smoke-test checklist
  covers the real browser install (headless MV3 e2e is out of scope).

## Out of scope

- Any change to the parse/upsert/mirror logic (owned by the v1 manual-ingest work).
- Scraping speech-level data (Base Camp doesn't expose it).
- Chrome Web Store publishing; Firefox / cross-browser.
- Forced token expiry (documented future option).
- Rate limiting on the ingest endpoint.
- **Unattended / scheduled sync** (nightly, no officer present). Split out to #117 — it forces a
  credential-custody decision this officer-triggered design deliberately avoids. This extension is
  triggered by an officer with a live Base Camp session; it never holds Base Camp credentials.
- Deleting stale progress for members dropped from a path in Base Camp (pre-existing property of
  the sync; unchanged here).
