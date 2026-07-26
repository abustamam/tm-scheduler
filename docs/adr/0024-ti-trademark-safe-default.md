# ADR-0024: Toastmasters trademarks — remove the official wordmark, keep nominative word use

Status: Accepted (decision 3 revisited 2026-07-26 — see "Revisited" below)

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

  **Audited 2026-07-26 (#382), so the claim is precise rather than merely unchallenged.** Two files
  looked like exceptions and neither is. `src/lib/pathways-catalog.ts` holds project *names, levels
  and course codes* — facts, not educational content. Titles and short phrases aren't copyrightable,
  and a compilation is protected only for original selection or arrangement; here selection is
  dictated entirely by TI's curriculum (the list must be exactly what TI defines, no creative
  choice) and arrangement is by level number, which is the "sweat of the brow" *Feist v. Rural
  Telephone* rejected. The public articles under `content/resources/` are original prose — invented
  examples, conversational register, hedged cross-club generalization where TI materials prescribe.
  What they state are facts about how meetings run; facts aren't copyrightable, and the expression
  is GavelUp's own.

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

## Revisited — 2026-07-26 (#380)

**Trigger: commercialization.** Decision 3 above ("keep the assets in-repo") and decision 4 ("defer
a lawyer's read until commercialization") were both explicitly conditioned on the trajectory being
undecided. It no longer is — monetization is on the table, which fires decision 4's own trigger and
invalidates the premise decision 3 rested on.

**What changes: decision 3 is reversed.** The ten vendored official TI mark assets
(`src/assets/ToastmastersWordmark*.{png,svg}`, `ToastmastersLogo3Color.{png,svg}`) are **deleted**
from the repository.

The original trade — carry the unreferenced assets so re-adding the wordmark is a near-trivial
revert — was sound for an exploratory project. It is not sound for a commercial one. Under a
commercial product, "we keep a full set of the other party's trademark assets in our repository,
just unused" reads materially worse in a due-diligence or discovery posture than not having them,
and the convenience it buys is worth very little: re-vendoring from TI's Brand Portal is a
five-minute job *if* a Trademark Use Request is ever approved. The asymmetry now runs the other way.

**Enforcement.** `src/components/agenda/ti-wordmark.guard.test.ts` was widened from three deck
renderers to (a) a grep of the whole `src/` + `extension/` tree for the asset-reference pattern and
(b) an on-disk existence assertion, so re-vendoring fails the build rather than passing silently.

**Not changed.** Decisions 1 (no reproduced mark in rendered/exported output) and 2 (the word
"Toastmasters" under nominative fair use) stand as written; the #256 non-affiliation disclaimer
still does not license the marks. Decision 4's deferral has now fired: counsel's read on the
nominative-use posture is due at commercialization, tracked separately.

**Deliberately out of scope: git history is not rewritten.** The assets remain in earlier commits.
That is expected and proportionate — a force-push across a repo with this much branch history costs
more than it buys, and deleting from `HEAD` is what the due-diligence posture actually turns on.
