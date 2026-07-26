# ADR-0025: No automated Base Camp sync in the commercial product

Status: Accepted

Supersedes nothing. Narrows the scope of the Base Camp sync extension (#107 / #119) without
retiring it. Relates to ADR-0011 (Base Camp /detail project completion) and ADR-0024 (TI
trademarks), whose "defer a lawyer's read until commercialization" trigger has now fired (#384).

## Context

The Pathways sync extension (`extension/`, WXT, Chromium + Firefox) runs on
`basecamp.toastmasters.org`, walks a club's paginated Paths Progress and per-member `/detail`
responses, and POSTs them to `/api/pathways/ingest` under a per-club bearer token. It is the only
automated way GavelUp learns a member's Pathways level progress, and as of 2026-07-24 it still
works against Base Camp's re-platformed LMS.

GavelUp is moving toward being a paid product (#384). That changes what the extension is, without
changing a line of its code. Four things are true at commercialization that were not true for a
personal tool:

1. **Chrome Web Store review is the binding constraint — not Base Camp's API.** Sideloading an
   unpacked build is fine; shipping to customers means a store listing. The extension's profile is
   the hard case for review: broad host permissions on a *third party's* authenticated domain,
   collecting user data there, transmitting it to a first-party server. That engages the Limited
   Use and user-data policies, needs a published privacy policy and a justification for each host
   permission, and draws elevated scrutiny. Review is slow and rejection has no clean appeal —
   the Pathways feature would be hostage to a reviewer.
2. **Per-user install doesn't scale as a paid feature.** Every club admin must install an
   extension, stay signed into Base Camp, and trigger a walk by hand. That is an onboarding cliff
   standing directly in front of the thing being charged for, and a partial walk fails with no
   server-side visibility to debug it.
3. **It makes TI's release cycle our SLA.** It works until a deploy we don't control, can't test
   against, and won't be notified about. Base Camp has *just* re-platformed, so "worked yesterday"
   is a weaker guarantee than usual.
4. **The legal role changes.** Today: a member reading their own clubs' data. As a vendor:
   processing TI member PII *on behalf of* clubs — a different role with real obligations (lawful
   basis, privacy notice, DPAs with clubs, deletion and rectification handling). TI's membership is
   global, so GDPR applies. This compounds the Conditions of Use and unauthorized-access questions
   already flagged in #383, which is why #384 routes the extension to counsel.

Any one of these is survivable. Together, in front of a feature that was never the
differentiator, they are not worth it. TI is also closing this gap themselves — the new Base Camp
auto-submits path and level completions to Club Central, with a mobile app to follow.

## Decision

**The commercial product ships with no automated Base Camp sync.**

### 1. The extension stays, unlisted and internal

It is not part of the commercial product: not in the Chrome Web Store, not advertised to
customers, not supported for them. It continues to serve the maintainer's own clubs. This is a
legitimate split rather than a dodge — using a tool on your own clubs' data is different in kind
from shipping it to paying customers and processing other clubs' member PII as a vendor.

Nothing is deleted. `sync_tokens`, `/api/pathways/ingest`, `reconcileCatalog` and the
`bcm_project_progress` mirror all stay: the internal instance runs on them, and they are what
would be reused if TI ever grants API access.

### 2. Manual paste stays the supported Base Camp path

`/admin/pathways-sync` already accepts pasted Base Camp progress JSON, officer-initiated, with no
extension and no host permissions. It is DevTools-grade (copy the JSON out of the Network tab), so
it is an advanced path rather than a headline feature — but it is real, it works, and it belongs to
the officer who is already authorized as a Base Camp Manager.

### 3. Member-initiated paste/import is deferred, not rejected

Letting each member paste their own Base Camp progress is the consented, member-controlled version
of this feature. It is also real work — format parsing, a per-member flow, a whole consent surface
— for something that isn't the wedge. Build it when a paying club asks, not before.

### 4. Asking TI for API access is opportunistic, not a plan

Worth raising in any partnership conversation, especially now that official completion data flow is
improving. Nothing depends on it.

## Consequences

- **Pathways in the paid product is thinner, and the UI must say so honestly.** For a club that
  never syncs, `pathwaysForPerson` returns `[]` — path enrollments come only from a sync — so the
  Pathways panel is permanently empty. The empty state previously read "No Pathways synced yet,"
  which implies a sync is pending. It now states plainly where that panel's data comes from and
  points at the per-speech path and project recorded on the agenda.
- **A speech-derived Pathways view is a real gap, tracked separately.** Officers already record a
  Pathways path and project as free text per speech, and `resolveSpeechProjects` links those to
  catalog projects — but nothing renders a path-level view from them, because the view model is
  keyed on enrollments. Building one raises genuine design questions (a free-text path name is not
  an enrollment; levels and completion percentages cannot be derived from speeches), so it is its
  own feature, not a copy fix.
- **`/admin/sync-tokens` and `/admin/pathways-sync` stay in the officer nav**, with copy that no
  longer markets the extension. Gating the token page behind superadmin is deliberately *not* done
  here: tokens are harmless to hold, and the internal instance still issues them.
- **Highest-exposure item in the codebase is contained rather than removed.** The counsel question
  in #384 narrows accordingly — it becomes "is internal-only use of this defensible?" rather than
  "can we sell a product built on it?"
- **Reversible.** If TI grants access, or if store review turns out to be tractable, re-listing is
  a distribution decision, not a rewrite — the ingest path never went away.
