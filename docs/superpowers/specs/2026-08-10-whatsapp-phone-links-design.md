# WhatsApp click-to-message on every rendered phone — design

**Status:** approved (brainstormed 2026-08-10)
**Line citations verified against:** `b5709ff` (v1.11.0.0) — re-check them if this spec is picked up after main has moved.
**Builds on:** #37 (tap-to-nudge), #295 / #397 (E.164 normalization + club default country code), #485 (`wa.me` dead-ends on desktop).

## Problem

A phone number rendered in this app is currently either a `tel:` link or inert text. `tel:` is the wrong default for how this club actually communicates: nobody reaches for the dialer from a roster screen, and someone who does want to call can copy the number into their own phone app. What people actually do is message on WhatsApp.

The outreach path already knows this — `NudgeButtons` (#37) opens a pre-drafted WhatsApp chat, and #485 taught it that `wa.me` is a *device redirector* that dead-ends on desktop. That knowledge is trapped inside `src/lib/nudge.ts`. Everywhere else a phone appears, it is a `tel:` link or plain text.

## Scope

**In:**

- One shared WhatsApp URL builder, extracted from `nudge.ts` so the #485 desktop/mobile rule has exactly one copy.
- One shared React component that renders a phone as a WhatsApp link.
- Both existing `tel:` links replaced.
- Two inert phone renders made clickable (guest pipeline card, and a new roster column).
- Read-time E.164 coalescing on the four payloads that carry a phone.
- Running the existing `scripts/backfill-phone-e164.ts` against prod.

**Out:**

- Any prefilled message on these surfaces — see "Blank chat" below.
- Changing what `NudgeButtons` drafts. Its message composition is untouched; only the URL construction moves.
- A DB `CHECK` constraint on phone format — see "Why read-time coalescing survives the backfill".
- The CSV import preview table (`roster.tsx:1192`). Those rows are not contacts yet; the table exists to show what *will* import.
- Any auto-send. As with #37, the app opens a chat; the human types and sends.

## Decisions

### Blank chat, no prefill

The link opens the conversation with an empty compose box. These surfaces have no role or meeting context — a prefill would be generic filler, and the context-aware drafts already belong to `NudgeButtons`, which stays as it is.

### The number stays the link text

The number remains the clickable text, with `MessageCircle` (the icon `NudgeButtons` already uses) replacing the `Phone` icon on member detail, and a `title` of `Message {name} on WhatsApp`. A `Phone` icon pointing at WhatsApp would misdescribe the destination.

Accepted cost: on mobile, long-pressing the link offers "copy link address" (the `wa.me` URL) rather than the number. Copying to call is still possible by selecting the text; a dedicated copy control was considered and cut as a third interactive element per row.

### Normalize server-side, not in the client

Considered and rejected: sending each club's `defaultCountryCode` to the client and normalizing at render. It touches the *same* read paths (so it saves no plumbing) while creating a second copy of a normalization decision that is also the **dedup key for guests and people** (#397). Two implementations of that rule drifting is a real hazard.

`src/server/meeting-contacts-logic.ts:70`, `:104` and `:123` already do it the right way — `toE164(r.phone, cc)` with `loadClubDefaultCountryCode`. This design extends that existing pattern to the read paths that never got it, rather than inventing a second one.

Also rejected: a client-side `+1` fallback. It produces a *wrong* link for a club that set another country code, and a working chat with a stranger's number is worse than no link.

### Why read-time coalescing survives the backfill

`scripts/backfill-phone-e164.ts` will be run (see "Data"), but the read-time `toE164` stays. The script's own header frames the pair correctly: the backfill makes read-time coalescing *"a no-op passthrough"* — not unnecessary.

Two reasons it stays:

1. **Nothing enforces the invariant.** There is no `CHECK` constraint, and `toStoredPhone` *by design* falls back to the raw trimmed string when it cannot derive E.164, so "every stored phone is E.164" is a convention the write paths honor, not a property the schema holds. `src/db/seed.ts:874` already writes `"+1 916 555 0181"` — spaces and all — bypassing `toStoredPhone` entirely.
2. **A future writer that skips normalization degrades to a dead link, silently.** With coalescing it degrades to a working one.

A `CHECK` constraint was considered and rejected: it would reject the digit-less raw fallback the write path deliberately preserves, turning a cosmetic data issue into a failed import.

## Components

### `src/lib/whatsapp.ts` — the URL primitive (pure, no `#/db`)

```
whatsappHref(
  phone: string | null | undefined,
  platform: Platform,
  message?: string,
): string | null
```

- Strips `phone` to digits. No digits ⇒ `null` (the caller renders plain text).
- `platform === "desktop"` ⇒ `https://web.whatsapp.com/send/?phone=<digits>&type=phone_number&app_absent=0`
- otherwise ⇒ `https://wa.me/<digits>`
- `message` present ⇒ appends `&text=` / `?text=` with `encodeURIComponent`.

`nudge.ts`'s private `waDigits` and `whatsappUrlFor` are **deleted** and their call sites re-pointed here, so the #485 rule has one copy. This is the only part of the change that touches working code, so it is pinned by a golden-output test (below).

### `src/components/whatsapp-phone-link.tsx`

```tsx
<WhatsAppPhoneLink phone={contact.phone} name={row.name} fallback="—" />
```

Three states:

| `phone` | Render |
|---|---|
| linkable | `<a href target="_blank" rel="noopener noreferrer" title="Message {name} on WhatsApp">` with `MessageCircle` + the number |
| present but no digits | the number as plain text — visible, not swallowed |
| `null` / blank | the `fallback` node |

**Hydration.** `platform = mounted ? detectPlatform(navigator) : "mobile"`, with `mounted` set in an effect. The first client render matches the server (`wa.me`), then it re-renders platform-correct. No hydration mismatch, and the number renders without JS.

This deliberately does **not** copy `NudgeButtons`' `if (!mounted) return null`. That guard exists there only because its `shareUrl` depends on `window.location.origin`; borrowing it here would blank the number and shift layout on every row.

## Server read paths

Each normalizes with `toE164(raw, cc)` via `loadClubDefaultCountryCode`, matching `meeting-contacts-logic.ts`.

| Path | Change | Gate (unchanged) |
|---|---|---|
| `season-grid-logic.ts:273` | normalize, **inside the `includeContact` branch only** | public grid still carries no phone |
| `club.ts:129` `getMemberProfile` | normalize existing `phone` | `requireUser` + `requireClubViewAccess` |
| `club.ts:32` `listClubMembers` | **add** `phone`, normalized | `requireUser` + `requireClubViewAccess` |
| `guest-pipeline-logic.ts:473` `loadGuestPipeline` | normalize guest rows' `phone` | `_authed/admin` |

`listClubMembers` already returns `email`, so adding `phone` is the same PII class behind the same gate — not a new exposure boundary. The public season grid is the one hard line, and it does not move.

## Surfaces

| File | Change |
|---|---|
| `src/components/club/season-grid.tsx:695` | `tel:` → `<WhatsAppPhoneLink>` |
| `src/routes/_authed/members.$id.tsx:213` | `tel:` → `<WhatsAppPhoneLink>`; `Phone` icon → `MessageCircle` |
| `src/routes/_authed/admin/vp-membership.tsx:302` | split the joined `phone · email` string into elements; phone links, email keeps `mailto:` |
| `src/routes/_authed/roster.tsx` | new Phone column |

**Roster responsive behavior.** `TABLE_GRID` is `grid-cols-[1fr_34px] sm:grid-cols-[1fr_150px_170px_34px]` — below `sm` the roster shows only Member + chevron.

**Amended during implementation (2026-08-10): the Phone column ships at `xl`, not `sm`.** Measured in Chrome, a fifth fixed column at `sm` wants 570px in a 542px content box, collapsing the `1fr` Member track to **0px** — the member's name disappears entirely and the avatar overlaps Speeches. `lg` fails too: the 248px sidebar returns at exactly that tier and consumes the whole viewport gain (+8px of content box), leaving a 108px Member track that cannot fit the 138px "Officer · full admin" badge. `xl` is the first tier with room.

The consequence is real and worth stating plainly: **below 1280px the roster has no phone column at all.** Nothing is unreachable — the same link sits on the member detail page and the sign-up sheet's Contact column, both one tap from a roster row — but the roster itself is desktop-only for this.

If it is ever wanted on narrow screens, the lever is **not** trimming the officer badge (that costs ~170px and the admin signal on every screen below `xl`, and still truncates long names). It is an icon-only WhatsApp button in the trailing Account cluster, which is already `relative z-[2] justify-self-end` and hit-tests correctly: ~32px on the trailing track, the badge survives, and it works at *every* breakpoint including phones.

## Data

Run `scripts/backfill-phone-e164.ts` against prod:

1. Dry run (default; prints every row it would change).
2. Review the **guest-collision report** — rows #397 duplicated. The script only *reports* these; merging two visit histories is a VP Membership judgment call, not a backfill's.
3. Re-run with `--apply`.

The script is idempotent and its header marks a re-run after #397 as required, not hygiene.

**Sourcing gotcha:** `set -a; . ./.env.prod.local` fails under zsh — the connection string's unquoted `&` is a parse error, `DATABASE_URL` never gets set, and Bun silently falls back to `.env.local`, running the whole thing against dev. Pass the variable inline instead, and confirm the `host=` line the script prints is the Railway host and not `localhost`. That line exists for exactly this misfire.

## Testing

Coverage is assessed against the diff. The repo's documented traps that apply here:

- **Fixture matrix by character class, not one happy value.** `+19165550181`; `+1 916 555 0181` (spaces — what the seed writes); `(555) 123-4567` (no country code, must arrive already normalized); `0044 20…`; `""`; `null`; and a digit-less string like `"ask at church"`.
- **A component tested through its props cannot see a wrong prop** (#319). All four call sites *compute* the prop they pass. `SeasonGrid` takes its data as props, so it gets a real component test with a raw-phone fixture asserting the rendered `href`. The two routes and the guest card are not cheaply renderable, so they get a source guard instead.
- **A source guard that no `` href={`tel: `` survives** under `src/routes/` and `src/components/`. This is an "offenders must be EMPTY" guard, so it reads source **raw**, not comment-blind — the comment-blind `readSource` read is for "this pattern must BE present" guards, where a comment naming the pattern would falsely pass.
- **Golden-output test on the extraction.** `buildNudge`'s WhatsApp URL, mobile and desktop, pinned as exact strings so moving `whatsappUrlFor` into `lib/whatsapp.ts` cannot silently change what #485 fixed.
- **Integration.** The existing season-grid PII assertions (`season-grid.integration.test.ts:182` for `includeContact: false`, `:242` for the public grid) stay green untouched; new assertions that a raw stored phone comes back E.164 from each of the four read paths.

  Note on the access test: `requireClubViewAccess` **throws** rather than returning a reduced payload, so the right assertion for `listClubMembers`' new field is that the call *rejects* for a non-member — not that the response lacks `phone`. An assertion written the second way would pass for the wrong reason and keep passing if the guard were removed.

## Open questions

None. All four brainstorm decisions (blank chat, server-side normalization, number-as-link, surface list) are settled above.
