# ADR-0024: Toastmasters trademarks — remove the official wordmark, keep nominative word use

Status: Accepted

## Context

GavelUp reproduces Toastmasters International (TI) trademarks in two distinct ways, and issue
#257 (split from #256, the non-affiliation disclaimer) asked for a ruling on each — a
founder/legal call an agent cannot make.

1. **The official TI wordmark image.** A suite of vendored official assets
   (`src/assets/ToastmastersWordmark*.{png,svg}`, `ToastmastersLogo3Color.*`) is rendered by the
   `ToastmastersWordmark` component in **`src/components/agenda/meeting-present.tsx`** (projector
   header + navy footer) and inlined into the **PPTX export** (`src/lib/deck-to-pptx.ts`). This is
   the highest-exposure use: it reproduces the actual mark, shown to live audiences/guests and
   embedded in an exported file.

2. **The word "Toastmasters".** Used throughout the UI to name the program the product
   interoperates with (DCP, Pathways, meeting roles, dues presets).

TI's Trademark & Copyright FAQ is explicit that reproducing its "name, logo, tagline, or words …
[is] considered unauthorized use unless an exception has been made by the Chief Executive Officer,"
granted via an approved **Trademark Use Request**. A non-affiliation disclaimer (#256, shipped)
prevents *implying endorsement* but does **not** license the marks.

Two facts frame the risk:

- **Trajectory is undecided.** GavelUp may become a public/commercial product, stay free, or
  remain a private tool — not yet chosen. The decision should foreclose none of these.
- **GavelUp is positioned as a companion to TI's software, not a competitor.** It hosts **no
  copyrighted TI educational material**. Members and officers conduct club business on the official
  platforms — Base Camp (Pathways) and Club Central (roster/dues/officer/DCP admin) — and GavelUp
  *syncs from* them, serving as a view of how far a member has come and where they stand against
  their goals, plus a meeting-day layer (agenda, role sign-up, present mode, reminders) that has no
  TI first-party equivalent. So the relationship is complementary: it reads from the official tools
  rather than replacing them or reproducing their protected content. (TI's "requests are typically
  denied" language concerns its merchandise store, not software.)

## Decision

Take the **safe default**, proportionate to an undecided trajectory: remove the reproduced mark,
keep the necessary name.

### 1. Remove the official wordmark image from all rendered/exported outputs

The `ToastmastersWordmark` reproduction is dropped from `meeting-present.tsx` (present/print) and
the PPTX export. It is replaced with GavelUp's own mark plus plain descriptive text (e.g.
"Toastmasters Meeting Agenda"). This eliminates the one use TI policy explicitly prohibits.

### 2. Keep the word "Toastmasters" under nominative fair use

Naming the real program the product interoperates with is necessary to describe what GavelUp does
and is a defensible nominative use — reinforced by the #256 disclaimer. No attempt is made to
scrub the word.

### 3. Do not file a Trademark Use Request now; keep the assets in-repo

Filing is premature while the trajectory is undecided (and would announce GavelUp to TI). The
vendored TI assets stay tracked in the repo but **unreferenced**, so authorizing and re-adding the
wordmark later is a near-trivial revert if a future TI request is approved.

### 4. Defer a lawyer's read until commercialization

The logo reproduction is the clear-cut part and needs no counsel to identify as exposure. A
trademark attorney's opinion — on both the logo and the nominative-use posture — is worth the cost
**if/when** GavelUp commercializes, not at the current exploratory stage.

## Consequences

- **Follow-up implementation issue** (mechanical, `ready-for-agent`): remove the wordmark render
  from `meeting-present.tsx` + `deck-to-pptx.ts`, replace with the GavelUp mark + descriptive text,
  leave `src/assets/Toastmasters*` in place unreferenced, and delete/repurpose the
  `toastmasters-wordmark.tsx` component. Tracked separately from this decision.
- **Reversible.** Re-adding the wordmark is a small revert once (if) authorization exists.
- **Residual risk accepted:** reliance on nominative fair use for the word "Toastmasters". This is
  the standard posture for a product that interoperates with a named program, but it is a judgment
  call, not a settled fact — to be revisited with counsel at commercialization.
- **Unaffected:** #256 disclaimer proceeds independently; Base Camp sync (which consumes TI data
  but reproduces no mark) is out of scope.
