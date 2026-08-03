# ADR-0024: Toastmasters trademarks — remove the official wordmark, keep nominative word use

Status: Accepted (decision 3 revisited 2026-07-26; decisions 1 and 4 revisited 2026-07-31 against
Brand Manual v2.0 — see both "Revisited" sections below). The club-supplied logo the second
revisit describes shipped 2026-08-03 (#495).

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

> **Correction (2026-07-31):** "fires decision 4's own trigger" overstates it, and this sentence has
> since been read literally as "counsel is due now." Monetization was, and remains, *intent* —
> GavelUp is not charging. Decision 4's trigger is **money changing hands**, which has not happened;
> see the 2026-07-31 revisit. Decision 3 (delete the vendored assets) is unaffected and stands: that
> call turns on git history being permanent, not on the timing of revenue.

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
still does not license the marks. Decision 4's deferral stands, with commercialization as the
trigger. *(2026-07-31: the original wording here said the deferral "has now fired," which was wrong
on the facts — see the correction above and the 2026-07-31 revisit.)*

**Deliberately out of scope: git history is not rewritten.** The assets remain in earlier commits.
That is expected and proportionate — a force-push across a repo with this much branch history costs
more than it buys, and deleting from `HEAD` is what the due-diligence posture actually turns on.

## Revisited — 2026-07-31 (Brand Manual v2.0, rev. 07/2026)

**Trigger: reading the actual source.** Every prior decision here was made against TI's Trademark &
Copyright FAQ. The Brand Manual itself (v2.0, 41pp,
`content.toastmasters.org/image/upload/02330-001-0001-brand-manual.pdf`) is more specific, and it
moves the line.

**p.32 explicitly authorizes agendas.** The Trademark Use Request chart is keyed on *who the user
is*, and the first row reads:

> **Clubs, Areas, Divisions, and Districts** — Authorized: "Stationery, business cards, bulletins,
> newsletters, electronic media, websites, program covers, **agendas**, and similar items, only if
> directly related to, and focused on, the mission." **Responsible: Club President.**

So a club putting the TI logo on its own agenda is the *sanctioned* case, needs no Trademark Use
Request, and has a named responsible party. Decision 1 was written as "no reproduced mark in
rendered output" on the assumption that any mark on an agenda was exposure. That assumption was
wrong.

**What changes: decision 1 narrows from "no mark" to "GavelUp does not supply the mark."**
The exposure was never the logo appearing on an agenda — it is *GavelUp hosting and distributing
the asset*. Two things make that distinct from the club's own authorized use:

- **p.34** — TI materials "may not be reuploaded, rehosted, or otherwise made available in any
  other format on any other website."
- **Every agenda surface here is public and un-authed** (`club.$clubId_.meeting.$meetingId.{print,
  present,word}`, `club.$clubId_.roles`, `club.$clubId.meeting.$meetingId`). A Word document goes
  to whoever the author sends it to; these are URLs anyone can fetch.

Ship the asset and GavelUp made every copy, with no authorized user anywhere in the chain. Let the
club supply it and an authorized user made one copy of a mark it may use on exactly this material,
with GavelUp as the tool — the Word/Canva model, neither of which bundles TI's logo. Same pixels
rendered, materially different position. This holds even when the file a club uploads *is* the
official TI wordmark: that is the p.32 case, not a loophole.

**Constraints for the club-supplied implementation.** These are what keep the above true, and they
are not obvious from the feature description — an implementer gets them wrong by default:

1. **Do not induce the use.** Label the field **"Club logo."** Never name the mark in UI copy,
   placeholder, help text, onboarding, or docs; ship no TM example image and no preseeded default.
   Third-party protection for user uploads (*Tiffany v. eBay*, 2d Cir. 2010 — no contributory
   liability absent specific knowledge of particular infringing instances) is forfeited by
   soliciting the specific use. This rule is free and is the highest-leverage one.
2. **Scope uploads strictly per-club.** No shared asset library, template gallery, "logos other
   clubs use," or cross-club reuse of an uploaded image — that makes GavelUp the distributor and
   collapses the whole posture. This is the constraint most likely to be violated later as an
   obvious convenience.
3. **Attestation at upload** — one checkbox, "I confirm my club is authorized to use this image,"
   putting the representation on the party p.32 already names.
4. **A removal path** plus a contact route, so specific knowledge can be acted on.

**Enforcement gap — closed 2026-08-03 (#495).** `ti-wordmark.guard.test.ts` still does **not**
cover this: it matches filenames like `ToastmastersWordmark*.{png,svg}` in `src/` and
`extension/`, and a club upload named `logo.png` living in the `club_logos` table (a `bytea`
column, not object storage) is invisible to it. That remains correct — its job is to stop the repo
from re-vendoring the mark, which decision 3 still forbids. Constraints 1 and 2 now have their own
automated backstop instead of relying on review alone:
`src/components/agenda/club-logo-copy.guard.test.ts` (constraint 1 — no shipped copy names the
mark) and `src/components/agenda/club-logo-scope.guard.test.ts` (constraint 2 — every `club_logos`
read is scoped to the requesting club, and no cross-club "shared library" concept exists in
source).

**Decision 4 (counsel) has NOT fired.** GavelUp is not charging as of 2026-07-31; monetization is
intent, not fact. The trigger is money changing hands. Paying a trademark attorney pre-revenue to
answer "don't host the file yourself" is bad sequencing.

**Not changed.** Decision 2 (nominative use of the word "Toastmasters") and decision 3 (no vendored
TI assets in the repo) stand as written. Decision 3 in particular does **not** relax: this revisit
permits a *club-uploaded* image at runtime, never a TI mark committed to the tree.

**On the brand palette.** Adopting TI's colors is a bad trade in both directions and is not
proposed: p.12 forbids placing the logo on colors outside the brand palette (so the mark *costs*
palette freedom rather than granting it), and using TI's palette *without* the mark only increases
the affiliation confusion the #256 disclaimer exists to manage. GavelUp keeps its own palette.
