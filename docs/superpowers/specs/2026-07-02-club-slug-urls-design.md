# Human-readable club URLs (slug + club number)

**Date:** 2026-07-02
**Surface:** Public club URLs (`/club/$clubId/...`) + the club-identity model.

## Problem

Every public URL is `/club/<uuid>` — unreadable and untrustworthy in a share
message. Members should get `/club/mcf-toastmasters`. Toastmasters club numbers
are also globally unique and stable, so `/club/28677176` should work too.

## Approved decisions

- **Canonical URL = slug** (`/club/mcf-toastmasters`). The app generates this in
  every share link.
- **Also accept** the club number and the old UUID; both **redirect** to the
  canonical slug URL (subpath preserved).
- **Values are set via seed/DB** (no club-settings UI). The migration backfills
  `slug = slugify(name)`; the operator then sets the exact slug + club number.

## Schema (`clubs`)

Add two columns:

- `slug` — `text`, `NOT NULL`, `UNIQUE`. One canonical slug per club.
- `clubNumber` — `text`, nullable, `UNIQUE`. Toastmasters number stored as an
  opaque identifier string (never used for arithmetic; avoids int size/leading-
  zero concerns and lets the resolver match the raw URL segment directly).

The generated Drizzle migration must be **hand-edited** so it backfills before
enforcing constraints (a plain `ADD COLUMN slug text NOT NULL` fails on the
existing MCF row). It also sets MCF's real launch values directly, so a Railway
deploy is self-completing (the manual seed script does not run in prod):

1. `ALTER TABLE clubs ADD COLUMN slug text;` (nullable first)
2. `ALTER TABLE clubs ADD COLUMN club_number text;`
3. Generic backfill so every existing row satisfies the NOT NULL/unique
   constraint, mirroring `slugify` in SQL:
   `UPDATE clubs SET slug = trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')) WHERE slug IS NULL;`
4. Set MCF's real launch values (one-time data backfill for the launch club):
   `UPDATE clubs SET slug = 'mcf-toastmasters', club_number = '28677176' WHERE name = 'MCF';`
5. `ALTER TABLE clubs ALTER COLUMN slug SET NOT NULL;`
6. `CREATE UNIQUE INDEX clubs_slug_unique ON clubs (slug);`
7. `CREATE UNIQUE INDEX clubs_club_number_unique ON clubs (club_number);`

CI runs migrations (not `push`), so the hand-edited migration is exercised.

## `slugify` helper

Pure function in `src/lib/slug.ts`:

```
slugify(name: string): string
// lowercase → trim → non-alphanumeric runs to single "-" → strip leading/trailing "-"
// "MCF" -> "mcf";  "Downtown Speakers!" -> "downtown-speakers"
```

No auto-dedup (slugs are set deliberately; the unique constraint catches
collisions). Unit-tested.

## Resolver + redirect (core)

### `getClubByIdentifier` (public server fn, GET)

Input: the raw URL segment (string). Because `club_number` is `text`, no
"is this all digits?" branch is needed — match the segment directly, in
precedence order:

1. exact **slug** match (segment lowercased) → canonical (serve as-is);
2. else exact **club_number** match → redirect;
3. else, if the segment is a valid UUID, exact **id** match → redirect;
4. else → `notFound`.

Slug is tried first, so a (hypothetical) slug that equals a club number still
wins as a slug. Returns `{ id, slug, name, timezone, clubNumber }`.

Per the repo's client-bundle rule, the server fn stays thin and the query/logic
lives in a sibling `club-resolve-logic.ts` (integration-tested against the test
DB, like `members-logic.ts`).

### Route wiring

There are **two** resolution sites, because the print route opts out of the
shell.

**(a) The `/club/$clubId` shell** (`src/routes/club.$clubId.tsx`) resolves once
for its nested children (index + meeting):

- `beforeLoad`: call `getClubByIdentifier(params.clubId)`.
  - On `notFound`, render the existing not-found UX.
  - If `params.clubId !== club.slug`, **`throw redirect(...)`** (temporary — the
    slug is mutable, so no permanent/cacheable redirect) to the same pathname
    with the identifier segment replaced by `club.slug`
    (`/club/28677176/meeting/x` → `/club/mcf-toastmasters/meeting/x`). Use the raw
    `href` form so the child subpath is preserved verbatim.
  - Otherwise return `{ clubId: club.id, clubSlug: club.slug }` into route
    context.
- Nested-child **loaders read the resolved UUID from context** instead of
  `params.clubId`:
  - `club.$clubId.index.tsx`: `listUpcomingMeetings({ data: context.clubId })`.
  - `club.$clubId.meeting.$meetingId.tsx`: `listUpcomingMeetings({ data: context.clubId })`; the club-guard compares `data.meeting.clubId !== context.clubId` (UUID vs UUID) instead of the raw param.

**(b) The print route** (`club.$clubId_.meeting.$meetingId.print.tsx`) is
**escaped from the shell** (the trailing `_` in `$clubId_`), so the shell's
`beforeLoad` does NOT run for it. Today its loader does
`if (data.meeting.clubId !== params.clubId) throw notFound()` — which would
`notFound` on a slug URL (slug ≠ UUID). Fix it to resolve independently: call
`getClubByIdentifier(params.clubId)` in its loader, redirect to the slug URL when
`params.clubId !== club.slug`, and change the guard to
`data.meeting.clubId !== club.id`. In practice it's opened from the meeting page
(already on the slug), but a direct number/UUID hit must still resolve.

**Server functions are unchanged** — they stay keyed by UUID (`uuid.parse`).
Only the routes learn to resolve.

## Links & member identity

Because the served URL segment is always the slug (post-redirect), relative
`<Link to="/club/$clubId/...">` (nav strip, "back to meetings") carry the slug
automatically. Explicit path-building needs two fixes:

- **Public meeting share button** (`club.$clubId.meeting.$meetingId.tsx:250`)
  currently builds `path={`/club/${meeting.clubId}/meeting/${meeting.id}`}` using
  the UUID. Change to the route param (the slug):
  `path={`/club/${clubId}/meeting/${meeting.id}`}` (`clubId` is already
  destructured from `Route.useParams()`).
- **Authed VPE meeting share button** (`_authed/meetings.$id.tsx:244`) has no
  `$clubId` route param, so it needs the slug from loader data. Add `slug` to the
  club columns selected in `loadMeetingDetail` (`src/server/meetings.ts`) and
  return it (e.g. `clubSlug`); build the share path as
  `/club/${clubSlug}/meeting/${meeting.id}`.

**Member identity:** `useCurrentMember` keys localStorage as
`gavelup:member:${clubId}` (`src/lib/member-identity.ts:7`). The key becomes
slug-based. A returning member arriving on an *old UUID link* is redirected to
the slug URL and re-picks their name once. Pre-launch, acceptable; documented,
not mitigated.

## Seed / setup

MCF's real values (`slug='mcf-toastmasters'`, `club_number='28677176'`) are set
by the migration itself (step 4 above), so deploy is self-completing — no manual
prod step. For **future** clubs, setting slug + club number stays part of the
manual onboarding (seed/DB), same as roster import; a club-settings UI is out of
scope (below).

## Edge cases

- **Unknown identifier** → `notFound` (existing club/meeting not-found UX).
- **Numeric-looking slug** → slug precedence means it still resolves as a slug.
- **Old UUID / club-number links** → redirect to slug (subpath preserved).
- **Case:** slugs are stored lowercase; the resolver lowercases the incoming
  segment before matching so `/club/MCF-Toastmasters` resolves and redirects to
  the lowercase canonical.

## Testing

- **Unit** (`src/lib/slug.test.ts`): `slugify` — casing, spaces, punctuation,
  multiple separators, leading/trailing junk, already-slug input.
- **Integration** (test DB, `*-logic` pattern): `getClubByIdentifier` resolves
  by slug, by club number, by UUID; rejects unknown; slug-precedence over a
  numeric collision; case-insensitive slug match.
- **Route**: a thin check that a non-slug identifier redirects to the slug URL
  and that data still loads (can be asserted via the resolver + a targeted route
  test; full E2E is manual QA in the app).

## Out of scope

- Club-settings UI (slug/number/name/timezone editing) — deferred; values set via
  seed/DB.
- Slug auto-dedup / rename-through-the-app.
- Changing the authed (VPE) side's internal club resolution — it resolves club
  via membership, not URL, and is unaffected apart from the one share-link fix.
