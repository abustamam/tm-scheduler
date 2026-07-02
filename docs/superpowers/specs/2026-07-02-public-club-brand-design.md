# Light-touch GavelUp branding for public club pages

**Issue:** [#73](https://github.com/abustamam/tm-scheduler/issues/73) — Public club pages lack brand treatment (sans headings, no GavelUp mark)

**Date:** 2026-07-02

## Problem

The logged-out, member-facing club surface uses plain `text-2xl font-bold` sans
headings and shows no GavelUp mark, unlike the authed workspace which uses the
Fraunces `font-display` serif and the brand mark. Design review flagged this
(FINDING-006) but deferred it as a taste call rather than a bug.

There are **three** public surfaces, all rendered inside the shared club shell
(`src/routes/club.$clubId.tsx`, a `max-w-md` mobile column with no chrome):

| Surface | File | Heading today |
| --- | --- | --- |
| "Who are you?" name picker | `src/components/club/require-member.tsx` (`PickNameScreen`) | `font-bold text-2xl`, no mark |
| Club home ("Hi {name} 👋") | `src/routes/club.$clubId.index.tsx` (~line 55) | `font-bold text-2xl`, no mark |
| Meeting agenda | `src/routes/club.$clubId.meeting.$meetingId.tsx` (~line 209) | `font-bold text-2xl`, no mark |

(The issue names only the two route files; the "Who are you?" picker actually
lives in `require-member.tsx`.)

The brand treatment that exists today is the authed sidebar
(`src/routes/_authed.tsx:87-98`): a gradient chip containing a stroke-based
`GavelGlyph` SVG plus the "GavelUp" wordmark in `font-display` (Fraunces). The
glyph is a **private** helper inside `_authed.tsx` — unreachable from public
routes.

## Decision

**Brand the public surface with a light touch** (chosen over "full marketing
skin" and "keep deliberately plain"). Give it enough brand presence to read as
the same product as the authed workspace, without adding heavy chrome to screens
whose job is fast role-claiming.

Mark placement: **a slim brand header in the shared club shell.** Because all
three screens render inside `club.$clubId.tsx`, one header covers them all with
no per-page repetition.

## Design

### 1. Extract a shared brand mark — `src/components/brand-mark.tsx`

The `GavelGlyph` SVG (currently private in `_authed.tsx:208`) is extracted into a
shared component so both the authed and public surfaces can consume one source of
truth. Exports:

- `GavelGlyph` — the raw stroke-based gavel SVG, unchanged from today.
- `BrandMark` — the gradient chip + glyph + "GavelUp" Fraunces wordmark. Props:
  - `size?: "sm" | "md"` (default `"md"`). `md` reproduces the current authed
    sidebar dimensions **byte-for-byte** (38px chip, 19px wordmark); `sm` is a
    slightly smaller variant for the public bar.
  - `subtitle?: React.ReactNode` — optional caption line under the wordmark
    (used by the authed sidebar today for `{clubName} · Club 1492`). When
    omitted, only the wordmark shows.

Then refactor `_authed.tsx:87-98` to render `<BrandMark size="md" subtitle={…} />`
instead of its inline markup. The rendered output must be visually identical to
today's sidebar (this is the main regression surface).

### 2. Slim brand header in the club shell — `src/routes/club.$clubId.tsx`

Add a thin bar at the top of the `max-w-md` column, **above** `<RequireMember>`,
so it renders on all three public screens:

- Left: `<BrandMark size="sm" />` (mark + wordmark).
- Right: the club name (and number) as a muted, right-aligned caption, mirroring
  the authed sidebar's `{clubName} · Club {clubNumber}` pattern. Both are already
  available: `beforeLoad` calls `resolveClubOrRedirect`, whose returned club
  carries `name` and `clubNumber` (`getClubByIdentifier` selects them). Expose
  `clubName` / `clubNumber` into route context alongside the existing `clubUuid`
  / `clubSlug` so the header renders with no extra fetch. Fall back to just the
  name when `clubNumber` is null.
- Non-sticky. Hairline bottom border using `border-[var(--line)]` to match the
  sidebar's brand-block treatment. Padding consistent with the existing column.

This is the only new chrome introduced.

### 3. Serif the three main headings

Convert `font-bold text-2xl` → `font-display text-2xl font-semibold tracking-tight`
(matching the authed `font-display … font-semibold` idiom) on:

- `src/routes/club.$clubId.index.tsx` (~line 55) — "Hi {name} 👋"
- `src/routes/club.$clubId.meeting.$meetingId.tsx` (~line 209) — meeting theme
- `src/components/club/require-member.tsx` `PickNameScreen` — "Who are you?"

Section sub-headings (`h2`: "Your upcoming roles", "All meetings", category
labels, etc.) stay sans — this matches the authed pages, where only the page
`h1` is serif.

## Out of scope (YAGNI)

- The print route (`club.$clubId_.meeting.$meetingId.print.tsx`).
- The not-found / error screens (`ClubNotFound`, `MeetingNotFound`).
- Any color, spacing, dark-mode, or layout changes beyond the header + heading font.
- Marketing copy, taglines, or a landing/hero treatment.

Pure typographic + mark alignment with the existing authed visual language.

## Testing & verification

This change is presentational; there is no new server logic.

- `bun run check` (Biome lint/format) must pass.
- `bun run build` (or `bunx tsc --noEmit`) must pass — TS strict, no unused symbols.
- Existing test suite, including `server-modules.guard.test.ts`, stays green.
- Visual verification via `/browse` against `/club/<id>`:
  1. Name picker ("Who are you?") — header bar present, "Who are you?" in serif.
  2. After picking a name: home ("Hi {name}") and a meeting page — header bar
     present on both, `h1`s in serif.
  3. Authed sidebar (`_authed`) — unchanged from before the refactor.

## Risks

- **Near-zero, presentational.** The largest risk is the `_authed.tsx` refactor
  touching a shipped surface. Mitigated by keeping `BrandMark`'s `md` output
  equivalent to the current inline markup and eyeballing the sidebar after the
  swap.
