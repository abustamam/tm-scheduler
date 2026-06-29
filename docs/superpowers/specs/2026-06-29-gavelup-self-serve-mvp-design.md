# GavelUp — Self-Serve MVP Design

- **Date:** 2026-06-29
- **Status:** Approved (brainstorm + grilling complete); ready for implementation plan
- **Supersedes / amends:** ADR-0004 (magic-link is now VPE-only, not the member path), ADR-0005 (history keys to a *roster member*, not a Better-Auth user), ADR-0006 (membership model becomes a club roster)
- **Relationship to in-flight work:** builds on the **GavelUp workspace redesign** (the desktop club workspace currently WIP on the `club-workspace-views` worktree — reworking `_authed.tsx`/`_authed/index.tsx`, mock data in `src/data/club.ts`). That redesign is the *VPE desktop surface* described here; this spec defines the data model + the *member mobile* surface it pairs with.

## North star

Be the **better spreadsheet**: keep what makes the club's Google Sheet work — open a link, find your name, set your role, no account — and add the three things the sheet can't do: **validation** (no double-booked roles), **context** (what a role actually involves), and **history** (who did what, and who changed it). We are explicitly *not* building accounts, logins, or automated notifications for members.

### Why this pivot (recorded so we don't relitigate)
The earlier direction (magic-link for everyone + an automated reminder system) was over-built for one ~30-person club. The sheet's magic is **zero-signup self-serve**; magic-link reintroduced the signup it claimed to remove. And at club scale, the VPE personally nudging three people on WhatsApp beats a cron job. So: members go auth-free, and "notifications" for the MVP is the VPE manually sharing a link (made fast, see §7). Automated notifications are deferred (design preserved in `docs/design/reminders.md`).

## The model is already right

The app models a meeting as a set of **role slots** (one row per fillable position); claiming assigns one member to one slot. This already fixes the sheet's two flaws the VPE called out:
- **No duplicate roles** — each slot is filled at most once (race-guarded conditional update).
- **A member can hold multiple roles** — claim as many slots as you like.

So this is a **reskin + de-auth + add-a-log**, not a new engine. The slot/claim core stays.

## 1. Two surfaces, two auth models (the crux)

| | Members | VPE / admin |
|---|---|---|
| Auth | **None.** Self-asserted identity: pick your name from the club roster (remembered in-browser); self-add if you're new. Trust-based. | **Sign in** (existing magic-link). |
| Device | Mobile-first (they open a WhatsApp'd link on a phone) | Desktop/tablet (the workspace) |
| Can do | Browse everything; claim/release/reassign any slot (sheet parity, soft-confirm); mark Not-Available | Everything members can, plus: the season overview grid, roster management (merge/rename/remove), create meetings + edit the role template, the activity log, tap-to-nudge |

Magic-link is retained but **narrowed to the one person who needs it**. Members never hit a login.

## 2. Data model changes

Keep: `clubs`, `meetings`, `role_definitions`, `role_slots`, `speaker_details`. Auth tables (`user`/`session`/...) stay but back **only the VPE/admin**.

- **New `members` table** (the roster, per club): `id`, `club_id`, `name` (required), `email?`, `phone?`, `office?` (free-text title, informational), `created_at`. Self-add allowed; VPE can merge/rename/remove.
- **Re-key assignments:** `role_slots.assigned_user_id` → **`assigned_member_id`** (FK → `members`). `speaker_details` unchanged (still 1:1 with a slot). The conditional-update claim guard is unchanged.
- **New `member_availability`** (member × meeting): `member_id`, `meeting_id`, unique together. Presence = "Not Available" for that meeting. (Absence of a row = undecided/available.)
- **`role_definitions` gains `description`** (text / light markdown) — the role's responsibilities. Seeded with standard Toastmasters text.
- **New `activity_log`** (append-only): `id`, `club_id`, `actor` (a `member_id`, or the admin), `action` (enum: claim/release/reassign/availability_set/availability_clear/member_add/member_edit/member_merge/member_remove/meeting_create/meeting_edit), `target` (slot/meeting/member refs), `before`/`after` (jsonb or compact text), `created_at`. This is the change *history*, distinct from current state.
- **Admin linkage:** the signed-in admin maps to a roster member (by a flag or email match) so their actions log under their name and they appear in the grid like everyone else.

The VPE/admin is **both** a roster member (they hold roles) and an auth account (they sign in).

## 3. Member mobile experience (no auth)

1. **Land** (often via a shared link) → see the meeting/role publicly, no login.
2. **Identify** on first action: pick your name from the roster (one tap; **self-add** if absent — just type your name). Remembered in `localStorage`; switching is just picking another name.
3. **Personal view:** "Hi {name}" → your upcoming roles + meetings that still have open roles. Vertical, phone-friendly (no grid to fight).
4. **Meeting view:** roles grouped, each showing its **responsibilities**; open roles have a one-tap **Claim**; mark **Not Available** for the meeting.
5. **Edits:** sheet parity — you may reassign/clear any slot, but a slot held by someone else triggers a soft confirm (*"This is Mahbuba's slot — reassign it?"*). Every change is logged.

## 4. Role responsibilities (the differentiator)

One **description per role definition**, authored once by the VPE in the club's role template, **seeded** with standard Toastmasters responsibilities so it's useful day one. Shown **right before claiming** ("here's what you're taking on") and it **travels with the shared link**. Separate from the existing speaker-detail capture (speech title / Pathways), which stays as post-claim input for speaker roles. One text field — no time/prep/links structure in v1.

## 5. Not Available

A per-member-per-meeting toggle. Distinguishes "out — don't chase me" from "undecided/blank." Member sets it on the meeting view; the VPE overview renders empty-and-open differently from empty-but-unavailable, so gap-filling doesn't waste nudges on people on vacation.

## 6. VPE overview (signed-in, desktop) — builds on the workspace redesign

- **Season grid:** members × meetings, color-coded (filled / open / not-available), gaps obvious. This is the VPE's planning god-view (where a grid actually works — not a phone). Aligns with the in-flight `club-workspace-views` redesign.
- **Roster management:** add/edit/merge/rename/remove members (cleanup for self-add mess); set contact/office.
- **Meetings + role template:** create meetings (auto-generates slots from the template, as today); edit role definitions incl. descriptions, counts, order.
- **Activity log:** see §8.

## 7. Shareable link + tap-to-nudge (the manual-notification workflow, made fast)

- **Public per-meeting (ideally per-role) page** showing responsibilities and open roles — the URL the VPE pastes into WhatsApp. Opening it on a phone leads straight into the member flow (§3): identify → claim, no login.
- **Tap-to-nudge** in the VPE overview: tapping a member (or an empty slot) opens **WhatsApp (`wa.me/<phone>`) or email**, **prefilled** with a short message + the shareable link. Turns "week-before, WhatsApp three people a link" into three taps.

## 8. Activity log (VPE-only, read-only)

Every state change recorded as **actor · timestamp · what changed** (e.g., *"Toastmaster, Mtg 57: Schinthia → empty"*). Surfaced to the **VPE only** (behind sign-in) as a reverse-chron feed, filterable by meeting/member. **Read-only in v1** — the VPE sees an accidental unassign and re-assigns manually (itself logged). One-tap undo is deferred. Kept forever (cheap).

## Error handling & trust

- Claiming an open slot: race-guarded conditional update (unchanged) → clean "just claimed by someone else" on loss.
- Reassign/clear: allowed (trust), soft-confirmed, logged with before→after so nothing is silently lost.
- Self-asserted identity is spoofable by design — same trust the sheet runs on, now with a name attached to each edit. No attempt to prevent impersonation in v1.
- Admin/destructive actions (delete meeting, remove member) sit behind sign-in.

## Testing approach

- **Pure logic** (slot generation, label numbering, availability/grid derivations): unit tests (Vitest), following `src/lib/agenda.ts` + its test.
- **DB-backed** (claim race, reassign, availability, activity-log writes, roster merge): integration tests gated `describe.skipIf(!hasTestDb)` against a throwaway Postgres, following `src/server/claim.integration.test.ts` + `src/test/db.ts`.
- **Member-flow** (identify → claim, no auth): component/E2E later; at minimum the server fns are integration-tested.

## Out of scope / deferred (so the MVP stays tight)

- **Automated notifications / reminders** (email/SMS/WhatsApp) — deferred; manual tap-to-nudge is the MVP. Design preserved in `docs/design/reminders.md`.
- **Formal swap-request/accept flow** (old #6) — obsoleted by trust-based reassign + the log.
- **VPE analytics** (rotation/overdue/Pathways — #8/#9) — phase-2 enrichments of the overview; design in `docs/design/vpe-dashboard.md`.
- **Multi-club switcher** (#10) — single club for MVP; the roster model will need revisiting for multi-club.
- **One-tap undo** from the activity log.
- **Member accounts / contact verification** — not now (trust-based).

## Open questions / risks

- **Identity persistence:** `localStorage` is per-device/browser — a member on a new phone re-picks their name. Acceptable (no account), but note it.
- **Roster hygiene:** self-add will create dupes ("Mike"/"Michael"); merge tooling must make cleanup easy and re-point assignments + log on merge.
- **Migration of the deployed pet-project data:** the live Neon DB has the seed (Better-Auth users as members). Re-keying to a `members` roster likely means a re-seed rather than a data migration — confirm before the cutover.
- **Public pages + the existing `requireMembership` guards:** browsing must become public (read) while writes stay trust-based; the current server fns assume an authed user + membership and must be reworked.
