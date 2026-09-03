# TODOS

> **GitHub issues are the canonical tracker** (`abustamam/tm-scheduler`, managed via `gh`). See `docs/agents/issue-tracker.md`.
>
> This file is for in-flight work that is not worth an issue yet: follow-ups noticed mid-branch, deferred pieces of something currently being built. Anything that outlives the branch it was noticed on should become an issue, and the entry here should be deleted rather than mirrored.
>
> Format: group under `## <Component>`, one `**Priority:**` (P0-P4) per item, completed items move to `## Completed` with the version that shipped them. `/ship` reads this file and moves items itself when the diff shows the work is done.

## Meetings

- A club's Table Topics window is SNAPSHOTTED into a meeting's agenda template at
  materialisation (#443). A club that edits the window afterwards keeps the frozen
  marks on that meeting until the row is edited. Re-deriving stored marks at render
  time is the fix; it is a wider change than #443 because `resolveMarks`
  (`agenda-template-rows.ts`) deliberately makes the STORED copy authoritative so an
  officer's per-meeting edit survives, and re-derivation has to tell "never edited"
  from "edited to the same value". Filed for #679.
  **Priority:** P2

- The standard Table Topics row on the Timer's blank role sheet still prints the
  ±30s speech grace (`0:30–2:30`), while the product's own rule for that segment is
  the cap with no grace — which is what `formatTableTopicsTiming` states, what
  `firstQualifyingWindow` reasons about (#357 skips non-speaker rows precisely so the
  Table Topics window is never shown as a speech window), and what the sheet now
  prints for a club that has stated its own. #443 deliberately left the no-rule case
  alone: changing it rewrites the committed PDFs in `public/role-sheets/` for every
  club, which is a product decision rather than a wiring one.
  **Priority:** P3

- No DB `CHECK` constraint on `clubs.table_topics_min_seconds` /
  `_max_seconds` (#443). Both bounds, ordering and the 10-minute ceiling are enforced
  by the zod schema on the write path and re-checked by `hasTableTopicsLimits` before
  anything renders, so a bad row degrades to the standard window rather than to a
  wrong one — but a script writing directly still gets to store it.
  **Priority:** P4

- The personal meeting page's roles payload is unbounded on both axes (#665). The
  slot select has no `LIMIT`, and `role_definitions.name` is an uncapped `text`
  column whose write path validates only `z.string().trim().min(1)` — unlike
  `members.ts`'s 80-char name cap. The route interpolates every role name into the
  H1 and the dialog copy. NOT the #519/#522 shape: the size takes an officer to
  create, not an anonymous caller, and the render is client-side so no server event
  loop is blocked. Left undone deliberately rather than half-done — a `.limit()`
  whose test asserts `<= LIMIT` is the "stated relative to the constant it guards"
  trap, so doing it properly means measuring a ceiling and capping the name on the
  write path too.
  **Priority:** P3

- `?as=` seeding is covered by unit + guard tests, but the one behaviour that
  decided its final shape was only visible in a browser (#665): when the seed is
  REFUSED because the device already holds a different identity, stripping the
  param makes `targetMemberId` fall back to the stored pick, so the page silently
  flips to the other member. Fixed by not stripping in that arm. There is no
  in-process test that would have caught it — the route cannot be mounted — so if
  that derivation moves, re-check it in a browser rather than trusting the suite.
  **Priority:** P4

- An ex-member can still see a departed club's forward schedule. `userMemberIds` deliberately ignores `members.status`, and the deactivation sweep in `members-logic.ts` skips slots on CANCELLED meetings, while `applyReopenMeeting` restores a meeting without clearing assignments. Cancel a meeting, deactivate a member, reopen it, and their `/me` shows that club's date, theme and location with a Release button that dead-ends. Needs all three steps, so it is debt rather than scheduled work.
  **Priority:** P4

- The attendance rail drafts a role confirmation to someone who never accepted the slot. `nudgeMode` branches on the member's ANSWER (`m.status !== "not_coming"`) but not on whether the slot was accepted, and it structurally cannot: `PanelRowRole` is `Omit<PanelRole, "confirmed">`, so the row deliberately discards the one bit separating "they said yes" from "the VPE put them on the programme". A member with an unconfirmed slot and no plan row shows a status control reading "Ask" beside a draft saying "just confirming you're our Toastmaster". It matches the agenda slot card's existing rule (any non-open slot gets `mode="confirm"`), so this may be the intended behaviour — but the two surfaces should agree deliberately rather than by accident, and re-introducing `confirmed` to the row is exactly what v1.19.0.0 removed to stop a second answer disagreeing with `assumed`.
  **Priority:** P3

- `role_definitions.name` and `members.name` are uncapped at every writer, and v1.19.0.0 added a new per-row sink for the first. `createRoleSchema` / `updateRoleSchema` (`role-definitions-logic.ts:135,174`) and `editSchema.name` / `bulkImportSchema.rows[].name` (`members-logic.ts:210,607`) are all bare `z.string()`, while `preferredName` two lines above the first of those is capped at 80 with a comment explaining why, and `members.ts:34` caps the public self-add path. Before v1.19.0.0 the rail was always `mode="attendance"`, which interpolates no role name; a slot-holder's row now runs it through `encodeURIComponent` three times. Measured at n=40: baseline 43ms, 100,000-char names 96ms, 20,000 emoji code points 186ms — linear, not #522's 13x blow-up, and the trigger is authenticated admin, which is why this is hygiene rather than a DoS. Per the #519 lesson, assert an ABSOLUTE ceiling (80) rather than a test stated relative to the constant.
  **Priority:** P3

- Two small things in the rail worth doing together next time it is open. (1) `fetchedPlan` is `tmodPanelData?.plan ?? []`, a fresh array identity every render whenever the TMOD query is disabled or unresolved — which is every render for a plain member — so `effectivePlan` makes the reconciling effect run after every render on that path, and `writeRung`'s rollback override is deleted by the next render's effect. Harmless today only because that path falls back to `answeredRungs` anyway, so the rollback is a coincidence rather than a guard; a module-level `const EMPTY = []` restores it. (2) `contacted`'s `if (locked || pendingId) return;` is blunt on purpose — it blocks any in-flight write, not just the tapped member's, so a deliberate tap on a different row inside the same round trip records nothing. `pendingId` is a single slot by construction, so per-member precision needs the ref-counted `Set` shape the route already uses for `pendingWritesRef`.
  **Priority:** P4

- Naming and structure follow-ups in `attendance-panel.ts` / `meeting-attendance-panel.tsx`, deferred from v1.19.0.0 as churn on already-verified code. `storedStatus` is the one real defect — its own docstring spends sixteen lines explaining that the production caller passes an optimistically overridden array, so the name is wrong exactly when someone reaches for it wanting the committed value; `suppliedStatus` or `inputStatus` is a name the value can always satisfy. Softer: `assumed` is a bare adjective that can only ever mean "coming"; `PanelRole` / `PanelRowRole` differ by one infix and by the single field that is the whole reason the second exists; `buildPanelRoleMap` omits the "keyed by member, not by slot" invariant that its docstring, its parameter type and its first unit test each defend separately. Also `AttendanceRow` holds three pure label derivations the lib's own 12-cell precedence table could be asserting instead of re-covering through the DOM.
  **Priority:** P4

- `loadMyCommitments`'s select+where now has THREE production copies, and v1.23.0.0 added the reason to unify them. The NOTE above `listMemberCommitments` (`meetings.ts`) already said the hand-copy was "worth unifying if a third caller ever lands" — the evaluation-resource work then had to add the same four aliases, two coalesced columns and two gate columns to both copies, and a fourth hand-copy in `public-reads.integration.test.ts` (its ONLY test) has already drifted by omitting `lengthMinutes`, so that test cannot see a defect present in both production copies. `commitment-eval-resource.guard.test.ts` now covers all three CARDS, which catches a route that stops rendering the link, but nothing catches a READER that stops selecting the columns the card needs. Extracting the shared select into `my-activity-logic.ts` is the fix; it was deliberately not done at ship time because `listMemberCommitments` is a public session-less reader and the change wanted its own review.
  **Priority:** P3

- Role keys are still spelled as bare literals across the render modules, and #660 added one more reader without consolidating them. `meeting-roles.ts` now exports the three CAPABILITY keys and `role-duties.ts` imports two of them, so the duty registry cannot drift on those — but nothing else imports them. Counted at #660 (grep `roleKey: "` / `key: "` for the canonical spellings, and re-count rather than trusting this list): `speaker` appears as a role-key literal in `agenda-runsheet.ts:760`, `meeting-agenda-print.tsx:268`, `timing-window.ts:104` and `agenda-slides.ts:321`, plus the canonical definition in `role-template.ts:54` and `role-duties.ts`'s own `SPEAKER_ROLE_KEY` — six readers, not the four an earlier draft of this note claimed. `toastmaster_of_the_day`, `grammarian` and `vote_counter` are likewise re-spelled in `agenda-slides.ts:313,326`, `meeting-packet.ts:102,103` and `agenda-runsheet.ts:608,702,728`. No present defect: every copy agrees today. `speaker` is the awkward one because it is not a capability role, so it has no home in `meeting-roles.ts`'s existing set. The tidy is one exported constant per key that all readers import; deliberately not done in #660, which was a SERIAL issue on `meeting-roles.ts` and would have widened into four more heavily-imported render modules for a rename. Fold it into whichever of them is next opened for real work.
  **Priority:** P4

- The duty registry's CONTRACT is thinner than its three consumers need, and #660 shipped the atoms only. Four decisions are unmade, and each will otherwise be made three times — #667 (nudges), #665 (personal confirm page) and #666 (theme/word subroutes) all ask the same composite question. (1) `dutiesForRole` returns every duty regardless of state, so each consumer writes its own `!d.done(ctx)` filter and its own `duties.length === 0 → ROLE_CONFIRM_PROMPT` fallback; the case with no stated answer at all is "owns duties and every one is DONE", where a nudge should go quiet, a checklist should show ticked rows and the confirm page wants an explicit all-set state. An `outstandingDuties(role, ctx)` plus a discriminated `dutyPrompt(role, ctx)` belongs in `role-duties.ts` before the first consumer picks. (2) `DutyContext` mixes MEETING-scoped fields (`theme`, `wordOfTheDay`) with a SLOT-scoped one (`speechTitle`) in one all-optional bag, and `DutyTarget` carries no `slotId` — so `dutiesForRole(role).filter(d => !d.done(meetingRow))` typechecks, is correct for the TMOD and Grammarian, and silently answers `undefined` for every Speaker. With Speaker `defaultCount` 3 a member can hold two speaker slots, and a per-member context marks both done off one title. Either split the contexts by scope or make the seam per-slot. (3) `RoleDuty` is structurally assignable TO `RoleConfirmPrompt` (extra properties pass through a variable), so a helper typed for the prompt silently accepts a real duty and renders it with no `done` check — the exact "unverifiable tick" the split exists to prevent. A literal `kind` discriminant on both closes it, and gives the prompt a stable id in `DutyId`'s namespace for anything that logs what it asked about. (4) `href` returns an app-relative path and the only guidance is "Prepend an origin for an email" — name both absolutisers (`window.location.origin` on the client, `appBaseUrl()` in `unsubscribe-token.ts` on the server, which is `node:crypto`-only and would need lifting for a shared composer), because the reminder-email producer has no `window`. All four surfaced in #660's review with zero consumers in the tree, which is the cheapest moment to settle them.
  **Priority:** P2

- Two narrower notes from the same review, both deliberately left. The name fallback in `role-duties.ts` may have no true positives available at all: `meeting-roles.ts` argues `role_definitions.key` is NULL for exactly two populations, club-invented roles (which must be denied) and pre-`0044` renamed standard roles (stated to be empty and unable to grow) — so every row the name pass can match is club-invented, and a club that invents a role named exactly "Toastmaster", "Grammarian", "Speaker" or "Contestant" is handed that duty. `applyRoleDefinitionCreate` validates the name only as `z.string().trim().min(1)`. Deleting the fallback and resolving by key alone would close it, but #660's spec requires the fallback, so it needs the issue reopened rather than a quiet removal. Separately, `isSpeakerRoleName`'s replacement folds case with `toLowerCase()`, which maps U+212A KELVIN SIGN to `k` — so `"SpeaKer"` matches "speaker". Bounded (admin-authored, and the failure direction is nagging a holder forever rather than suppressing a nudge) and no pre-existing canonical name contains a `k`, so this is the first such exposure in the app; NFKC-normalising before folding would close it.
  **Priority:** P4

## Contact links

- Run `scripts/backfill-phone-e164.ts` against prod. Deferred from v1.12.0.0 by design — it writes to the production database, and the plan marks all four steps human-run. Not urgent: read-time coalescing already makes every rendered link correct, so this buys the #397 guest-collision report and stored-data hygiene rather than working links. Dry run first and **confirm the printed `host=` line is the Railway host** — `set -a; . ./.env.prod.local` is a zsh parse error on the connection string's unquoted `&`, so `DATABASE_URL` never gets set and Bun silently falls back to `.env.local`, running the whole thing against dev. Pass it inline instead. Then review the guest-collision report (those rows need a human merge; the script only reports them), apply, and re-run expecting `Would change 0 of N rows`.
  **Priority:** P1

- `/activity` fetches every member's phone to populate a filter dropdown that reads only `id` and `name`. Same auth gate as before, so not an exposure, but it serializes the phone into the SSR payload of a page that never renders it and makes that route pay a country-code round-trip for a field it discards. A narrow `listClubMemberNames` loader would drop both.
  **Priority:** P4

- The `no-tel-links` guard forbids `href="tel:"`, but the decision it enforces is "every rendered phone opens WhatsApp". A future surface doing `<span>{member.phone}</span>` passes the guard, every render test, and review. No present defect — swept the tree at v1.12.0.0 and the only remaining `phone` references are form inputs and the nudge picker's null check — but the guard enforces the narrower half.
  **Priority:** P4

- The SSR mount-gate dance (`useState(false)` + `useEffect` + `detectPlatform(navigator)`) is duplicated between `whatsapp-phone-link.tsx` and `nudge-buttons.tsx`, including the `"mobile"` default that has to match the server render. A shared `usePlatform()` in `#/lib/platform` would give that reasoning one home. Deliberately not done at v1.12.0.0: measured at 5.4ms over 200 rows in jsdom, and hoisting `mounted` to the list re-renders the whole table instead of the leaves, so it is a readability change, not an optimization.
  **Priority:** P4

## Archive takedown

Surfaced by the `/review` passes on #560/#556 and deliberately left out of that branch.

- **The archive-gate enrollment sweep exempts the whole `require*Editor` family by regex.**
  v1.26.0.0 closed the hole itself — `resolveMeetingAgendaAuthz`, `resolveWordOfTheDayAuthz` and
  `resolveVoteCounterAuthz` now assert `archived_at` at the choke point (14 server fns gate through
  them; 11 had no other archive gate) —
  but the reason it went unnoticed is still live: `SESSION_GUARDS` in
  `public-readers-archive-gate.guard.test.ts` matches `require...MeetingAgendaEditor`/
  `WordOfTheDayEditor`/`VoteCounterCapability` and classifies anything calling them as
  session-guarded, so those endpoints are dropped from the anonymous sweep. Two of those three
  guards admit a SESSION-LESS caller (the honour-system TMOD, the Ballot Counter self-assert), so
  the classification is wrong in exactly the direction that hides a gap. The next endpoint added
  behind one of these guards is enrolled by nothing. Either drop them from `SESSION_GUARDS` and
  waive the members explicitly, or assert the gate behaviourally per guard.
  **Priority:** P2

- **`applyRemoveSpeakerSlot` can still destroy a slot claimed in the same instant.** v1.26.0.0 put
  the three speaker/evaluator pair mutations (`applyAddSpeakerSlot`,
  `applyRemoveSpeakerSlot`, `applyMoveSlot`) behind a `FOR UPDATE` lock on the MEETING row —
  `applyAddRoleSlot`, `applyRemoveRoleSlot`, the template sync and
  `syncSlotsForRoleEnabledChange` are NOT covered — which serializes add/remove/
  reorder against each other — but `claimSlot` locks the SLOT row instead, so it does not
  participate. Remove still decides "the top unclaimed speaker" from a read and then deletes by id
  with no unclaimed predicate on the `DELETE`, so a claim landing between the two is deleted.
  `removeOpenRoleSlots` in the same file already solves this by putting the predicate in the
  `WHERE` clause; this function was re-entered in v1.26.0.0 without inheriting it. Fix is a
  predicate on the delete, not a wider lock.
  **Priority:** P2

- The two slot writes still gate in their `createServerFn` HANDLER rather than in a seam
  (`releaseSlot`, `updateSpeakerDetails` in `slots.ts`). #555 moved six of the eight session-less
  writes into `-logic` seams, where `public-writers-archive-gate.integration.test.ts` actually
  executes them; these two could not follow because their logic is inline in the handler and lifting
  it out is a refactor that change was not. So their gate is covered by a source grep
  (`WRITE_GATES` in `public-readers-archive-gate.guard.test.ts`) and nothing else — the grep sees
  the call, not whether it runs on the right club id. Extracting `applyReleaseSlot` /
  `applyUpdateSpeakerDetails` would close it and is worth doing next time that file is open.
  **Priority:** P3

- #556's eviction rests on an assumption nothing gates: that a `notFound()` in a route loader keeps
  mapping to an HTTP **404**. Verified by hand against a dev server while writing the fix (meeting
  page and `/present` 404; `/print` 307s to `?layout=grid` which 404s; the logo endpoint 404s), and
  noted in `isGoneResponse` — but every sw test INJECTS the status, so they stay green either way.
  If a TanStack Start upgrade made that a 200, `response.ok` flips true, the not-found page is
  CACHED over the agenda, and the eviction silently never runs. A real gate needs an HTTP-level
  assertion against a booted server, which this repo has no harness for.
  **Priority:** P3

- Archiving now has three different wire contracts for one domain event: `resolveClubOrRedirect`
  throws `notFound()`, the public readers return `null`/`[]`, and the authed gates throw a raw
  `Error` that crosses the RPC boundary as a 500-class rejection. `router.tsx` sets
  `defaultNotFoundComponent` but no `defaultErrorComponent`, so a loader that reaches the throw
  renders TanStack's unstyled "Something went wrong!" outside the app chrome. Narrow today — the
  `/club/$clubId` shell 404s first for routes under it — so it bites routes that call a gated fn for
  a club id without going through that shell, and only for a club archived mid-session. Pre-existing
  in shape (`requireMembership` has thrown this since #186); #560 widened it from writes to reads.
  **Priority:** P4

## Tooling

- `bun run fix` writes the whole tree, and there is no scoped variant. Fine today (it is a verified no-op on a clean tree), but two things make a scoped one worth having before anyone wires it into a hook: `biome check --changed` hard-errors here because `biome.json`'s `vcs` block has no `defaultBranch`, and a `pre-commit` hook running the unscoped `fix` would sweep unrelated working-tree drift into the commit. `--staged` is verified working, so `"fix:staged": "biome check --write --staged"` plus `"defaultBranch": "main"` in the `vcs` block would close both.
  **Priority:** P4

- Biome's `files.includes` covers `src/**`, `.vscode/**`, `index.html` and `vite.config.ts` only, so `scripts/**`, `drizzle.config.ts`, `vitest.config.ts` and the whole `extension/` sub-package are outside the gate entirely. `extension/` has no Biome config and no Biome step in its CI job, yet some plans instruct running Biome from inside it, where it resolves the root config that excludes those paths. Decide whether those paths should be linted or explicitly declared out of scope.
  **Priority:** P4

- `batch:issues` cannot see a blocker that sits outside the label it is planning. `extractDependencies` reads `Blocked by #N` off every fetched issue, but the fetch is label-scoped, and `findViolations` deliberately says nothing about a blocker absent from the plan ("not in this plan; nothing to say about it"). So a `ready-for-agent` issue genuinely blocked by a still-`needs-triage` sibling is presented as freely dispatchable with an empty warnings list — the one case where the report is confidently wrong rather than silent. Closing it means fetching cited blocker numbers individually regardless of label to check their state, which is a real expansion of what the tool queries rather than a one-line fix. Raised by the pre-landing adversarial pass on the branch that added the tool.
  **Priority:** P3

- `batch:issues`' fan-in graph is blind to `await import(...)`. `buildFanIn`'s regex is `from\s+["']...["']`, and roughly 100 files here reach a module only through a dynamic import — mostly integration tests loading a `*-logic.ts` after mocking `#/db`. Those edges are missing, so a logic module's true fan-in is undercounted and it can land in a wave when it should have been serialised. Low impact today because most such modules also have static importers; the fix is a second regex, but it shifts every count and wants measuring before/after.
  **Priority:** P4

## Pinned columns

- The attendance rail's scrollbar sits inside the card's `px-6`, an inset gutter rather than
  hugging the column edge, because v1.22.8.0 moved the scroller from the `<aside>` into
  `CardContent`. Purely cosmetic — the alternative (negative margin on the body, padding back on
  the rows) trades one oddity for another, so it wants a designer's eye rather than a rule.
  **Priority:** P4

- Nothing pins the removal of `NavGroup`'s `first:pt-1`. It never matched while the labels were
  direct children of the sidebar column, and v1.22.8.0 dropped it so that giving the nav its own
  scrolling band would not silently tighten the gap under the club name by 10px. Re-adding it
  would reintroduce that shift with every gate green. Not worth a test on its own; worth knowing
  if the sidebar's structure is touched again.
  **Priority:** P4

## Agenda templates

- **`scripts/resync-template-roles.ts` is specified but not written, and #622 makes it the only
  recovery path from copy-once drift.** Materialization is copy-once, so editing
  `src/lib/contest-template.ts` never reaches a club that has already run a contest — the same
  contract `ROLE_TEMPLATE` has. The escape hatch should resolve a template by key, diff each
  materialized `role_definitions` row against the seed, print `club → role.field: current ⇒ seed`,
  and write nothing without `--apply`. Never touch a row whose key is absent from the seed: a club
  may have added its own.
  **Re-scoped P3 → P2 by plan-eng-review on 2026-08-25.** This entry was P3 while drift reached
  only clubs that had run a contest. #622 extends copy-once materialization to the WHOLE agenda of
  any club that edits an ordinary meeting, and the drift is no longer limited to role definitions —
  it covers every beat. Measured: `agenda-runsheet.ts` took 27 commits in six months and **15 of
  them changed beat content** (roughly one every 12 days), including "close on announcements →
  guest comments → adjourn" and "the deck and the run sheet book the same minutes". An adopted club
  receives none of them. #622's spec accepts that deliberately (R1) and makes the adopt action say
  so out loud, which is defensible only while a recovery path exists — and this script is it. It is
  writable today and would serve the existing contest case immediately, independently of #622.
  **Priority:** P2

- **`meeting_templates.meeting_id` is ON DELETE CASCADE, but the cascade cannot fire for any
  private copy a real conversion produced.** Every conversion materializes `role_definitions`
  against the copy, and `role_definitions.template_id` is ON DELETE RESTRICT — so deleting the
  meeting aborts with `violates foreign key constraint
  "role_definitions_template_id_meeting_templates_id_fk"`. Nothing breaks today only because the
  single production deleter (`recurrence-rule-logic.ts`, pruning pristine recurrence meetings)
  refuses any meeting with a non-null `template_id`. The open question is whether
  `role_definitions.template_id` should CASCADE from `meeting_templates` instead, which would make
  the declared cascade true and let a future deleter work without a bespoke retire step — deliberately
  NOT changed on the shipping branch (it is a third migration touching the same tables, and the FK
  also protects `role_slots` indirectly). Both behaviours are now pinned by
  `template-schema.integration.test.ts`, and `schema.ts`'s `meetingId` docblock states what really
  protects meeting deletion, so this is a design question rather than a live hazard.
  **Priority:** P3

- **A printed agenda between one page and ~1.3 pages is SQUEEZED, while a longer one FLOWS.**
  `FitPage` scales a sheet until it fits, unless the scale would fall below `MIN_FIT_SCALE`, at
  which point the surface flows across sheets at full size. So legibility is not monotonic in
  length: the seeded contest printed its body at ~8.6pt when it ran ~40 rows (past the
  threshold, flowing) and at ~6.7pt once it was rewritten to 21 rows (below it, scaled onto one
  sheet) — adding rows made the sheet MORE readable. Both clear
  `EDITORIAL_DENSE_MIN_PRINTED_PT`, so nothing fails; `print-density.test.tsx`'s
  "FLOWS at full size once long enough" case pins the asymmetry rather than hiding it. The fix
  is not simply raising `MIN_FIT_SCALE`: that would push ordinary club agendas onto a second
  sheet, which v1.21.0.0 explicitly promised it would not do. Likely answer is to let a
  TEMPLATED meeting opt into flowing regardless of scale, since a contest sheet has no
  one-page promise to keep.
  STILL OPEN, and the per-meeting agenda editor makes it easier to reach than it was: the seeded
  contest was the only way to land on this curve before, and now any officer's hand-authored
  agenda can produce a beat count and row shape anywhere along it, squeeze cliff included.
  **Priority:** P3

- **Colour print rows by `category` when a role key is unmapped.** `ROLE_KEY_COLOR` now
  enumerates the seven seeded contest keys beside the five standard ones. That works and does not
  scale — every future template needs its keys added or the sheet prints one grey spine, and
  `isHighlighted` still tests `roleKey === "speaker"` specifically. A category fallback serves
  every template for free but needs `category` on `AgendaRow`, which is wider than Phase 1 needed.
  **Priority:** P3

- **No randomizer, ever — a contest draw is recorded, not generated.** Speaking order in a
  speech contest is drawn by lot at the briefing, physically, with the room watching. The app's job
  is to RECORD that result, and `applyMoveSpeakerSlot` already does it (it swaps `slot_index`
  within one `role_definition_id`, so it is template-agnostic by construction). Keep this in mind
  for anything that touches contest order: order is DATA, so every consumer must derive from the
  current slots at render and cache nothing, and numbering must follow POSITION rather than
  identity — "Contestant 1" is whoever drew first, and a re-draw renumbers. `buildTemplateSlideDeck`
  and `buildTemplateRows` both satisfy this today and `agenda-template-slides.test.ts` pins it.
  The Phase 2 editor is where it would be easy to break: a stored display order, a
  "shuffle" affordance, or memoising a deck by meeting id would each undo it.
  **Priority:** P3 (standing constraint, not a task)

- **Next increment: save this shape as a template.** Per-meeting editing lets an officer land an
  agenda on a private, throwaway copy (`meeting_templates.meeting_id` set) — nothing yet promotes
  that copy back into a reusable, shared row other meetings can pick. `meeting_id` already models
  the distinction the promotion needs (set = private, null = shared), so "save as template" is
  copying the private row's own beats and roles into a NEW row with `meeting_id` null and
  `club_id` set to the caller's club, not a second mechanism or a new table.
  **Priority:** P3

- **The "Change meeting type" button's wiring has no guard.** PR 2 added
  `template-deck-wiring.guard.test.ts`, which covers the two DECK expressions on the meeting and
  `/present` routes. The third is still bare: `meeting-agenda.tsx` gates the button on
  `viewer.canManage` and passes `currentTemplateId={meeting.templateId ?? null}`, and a prop-fed
  component test cannot see a wrong prop (the #319 trap). Extend the existing guard rather than
  adding a file.
  **Priority:** P3

- **The template and agenda-editor server fns are gated in SOURCE but not in BEHAVIOUR.**
  `meeting-templates-authz.guard.test.ts` proves every `createServerFn` in `meeting-templates.ts`
  AND `meeting-agenda-edit.ts` names a `require*` guard and an archive check, which is what the
  archive-gate sweep needs. Nothing calls `previewTemplateForMeeting`, `applyTemplateToMeeting`
  or any of the eight agenda-editor fns with a plain member's session and asserts a refusal, so
  the guards are verified by grep rather than by behaviour. Same for the zod validators — no test
  passes a non-uuid, an over-long label or a fractional timing mark. Wider than it was: the
  editor's eight fns have no backstop under the handler at all, since the `-logic` layer has no
  session of its own.
  **Priority:** P3

- **`copyTemplateForMeeting`'s reads of the SOURCE template are uncapped**, and will stop being
  safe the moment "save this shape as a template" lands. It copies every
  `meeting_template_roles` and `meeting_template_beats` row the source has, with no
  `MAX_TEMPLATE_ROLES` / `MAX_TEMPLATE_BEATS` limit of its own. Unreachable today, and that is a
  property of the DATA rather than of the code: a private per-meeting copy cannot itself be a
  source (`listAvailableTemplates` excludes private copies from the picker), so every source is a
  seeded template whose size the seed fixes. Turning an officer-authored private copy into a
  source makes this an officer-sized read. Cap it in that change, not before, and cap it at the
  seam the way `loadTemplateBeats` already does rather than at the writer alone.
  **HALF DONE in v1.27.0.0 (622a).** The BEATS read is now bounded at `MAX_TEMPLATE_BEATS + 1` and
  REFUSES past the cap rather than truncating — a copy that silently drops rows hands a club a
  permanently shorter agenda it never authored, which is the one place truncation is worse than an
  error. `meeting_template_roles` is still uncapped. Note the trigger is 622b, not 622a: a private
  per-meeting copy still cannot be a source, so every source remains a seeded template until
  "save as club template" lands. The beats half was done early because 622a was already in that
  file; finish the roles half in 622b.
  **Priority:** P3

- **`defaultCount` is unenforced after a re-point, and `slotsAdded` over-reports.**
  `applyTemplateConversion`'s `existingDefIds` is "any target def some surviving slot maps to", so
  `toCreate` skips a matched role regardless of how many slots it actually has — if the target
  declares 3 contestants and the meeting has 2, the apply keeps 2 and creates 0 while `summarize`
  reports `slotsAdded = 1`. Reachable today: use the agenda's +/- slot controls, then re-pick the
  same template. Preview and apply still AGREE with each other (both derive from the same
  `planConversion`), which is why nothing fails — the number they agree on is just not what
  happens. A fix has to count slots per matched def rather than testing set membership, and has to
  decide whether a re-point should also DELETE surplus slots, which is a policy question, not a
  bug fix.
  **Priority:** P3

- **The re-point path skips evaluator↔speaker linking.** `linkEvaluatorsToSpeakers` only pairs
  rows within `inserted`, so a newly created evaluator slot sitting beside a KEPT speaker slot is
  left with `evaluatesSlotId` null. Unreachable with the shipped seeds — the contest declares no
  evaluator role and shares no keys with `ROLE_TEMPLATE`, so a conversion never produces the
  mixed kept/inserted shape — and reachable as soon as a club authors a template that does.
  **Priority:** P3

- **The stretchy-row cap is named for Table Topics and applied to everything.** `buildTemplateRows`
  carries a beat's `flex` through ungated, `applyFlex` clamps it to `TABLE_TOPICS_MIN/MAX`, and
  `flexBannerMessage` says "Table Topics is at its 25-min cap".
  **No longer latent, and this entry said it was.** The reasoning was that the contest seed sets no
  flex beat, which is true and irrelevant: the agenda editor's "Make stretchy" button sets `flex` on
  ANY row of ANY template, today, with no Phase 2 involved. Observed directly during /qa on
  2026-08-24 — making "Tallying" stretchy on a 5-contestant Speech Contest with a 49-minute
  shortfall produced a 25-minute row and a footer still reading "24 under". Nothing is wrong with
  the arithmetic and the footer is honest about the remainder, so this is not a bug; the trap is
  that "make stretchy" cannot absorb the slack on any agenda longer than Table Topics was sized
  for, and the button offers no hint of a ceiling before you click it. The banner sentence naming
  Table Topics on a contest sheet is the same defect one layer up.
  Decide whether the bound belongs to the ROW (a per-beat min/max) or stays a Table Topics
  constant with the button gated to rows that have one.
  **Priority:** P3

## Agenda

- Confirm the hand-off rows on a real MCF agenda after it deploys — that the four print layouts read right in the room and the projected deck's hand-off slides land where the cue is needed. v1.16.1.0 (#585) made those rows name the people too, so this now also covers whether the longer rows read well at the printed size.
  **Priority:** P3

- Neither `meeting-present.tsx` nor `deck-to-pptx.ts` renders a hand-off slide in any test, so the projected cue line — now the longest single line on those slides after #585 — is unasserted in both renderers. `slide-layout.test.ts` pins the descriptor the two of them consume, which is why this is P4 rather than a gap in the fix itself.
  **Priority:** P4

- `scripts/measure-word-poster.ts` has no tests because `main()` runs at import, so nothing is reachable. It is the harness that derives the Word of the Day poster's font-size tables, and a wrong result there ships mid-word breaks on a wall poster. `scripts/import-agendas-logic.ts` is the repo's precedent for extracting a testable `*-logic.ts` alongside an entry-point script.
  **Priority:** P4

- Three residual notes from the v1.26.0.0 evaluator-reorder review passes, all deliberately not
  done in that branch. (1) The two move server fns in `slots.ts` are near-verbatim copies of each
  other (~18 lines differing in one message and one apply fn), and `moveSpeakerSchema` now
  validates both — worth one shared handler and a rename to `moveSlotSchema` next time the file is
  open. (2) The arrow pair JSX is duplicated between the speaker and evaluator blocks in
  `meeting-agenda.tsx`; the visual parity the feature relies on is now maintained by hand in two
  places. (3) `applyMoveSlot` issues three sequential pre-transaction round-trips (target, then
  `clubRoles`) where the last two are independent — one `Promise.all` removes a round-trip from
  every arrow tap. All P4: measured cost is one extra query on an admin click.
  **Priority:** P4

- The move endpoints are a slot-id oracle: both answer "Speaker/Evaluator slot not found." before
  the authz gate runs, so a caller learns whether a uuid names a slot in a club they cannot edit.
  Mitigated only by uuid unguessability, and pre-existing on `moveSpeakerSlot`. Gate first, then
  look up, if this is ever worth closing.
  **Priority:** P4

- Two slot-ordering gaps, both theoretical, both cheap. (1) Four queries order by `asc(roleDefinitions.sortOrder), asc(roleSlots.slotIndex)` with no tiebreaker (`meetings.ts:211`, `meeting-authz-logic.ts:141`, `minutes-logic.ts:514`, `award-candidates-logic.ts:69`), and `role_definitions.sortOrder` has no unique constraint while `createRoleDefinition` assigns `max+1`, which two concurrent creates can tie. On a tie Postgres may return either row first, which moves row display order and `buildShortCodes`' `#2` collision suffix (assigned in input order) — it does NOT move SP1/SP2 numbering, since `slotLabel` numbers off `slotIndex + 1` and `buildShortCodes` keys off `${roleDefinitionId}:${slotIndex}`, both position-independent. One `asc(roleSlots.id)` closes it. (2) `role_slots` has no unique index on `(meeting_id, role_definition_id, slot_index)`; two rows sharing that pair give two different members the same badge, because `buildShortCodes` keys on it and the second write wins. Only a data anomaly reaches it.
  **Priority:** P4

## Club settings

- The Club logo file input announces neither its limits nor its rejections to a screen reader. The help text `<p>` carries no `id` and the `<Input id="logoFile">` no `aria-describedby`, so tabbing to the control says "Upload a logo, file upload button" and never the size or pixel caps — they are discoverable only by reading past it. A rejected pick sets no `aria-invalid` (shadcn's `Input` already styles that state, `input.tsx:13`) and renders no inline error, so once sonner's live region has spoken there is nothing on the page, in the accessibility tree, or beside the field recording that the pick failed or why. Placement makes it worse for everyone: the toast is `position="top-center"` (`app-shell.tsx:351`) while the logo section sits at the bottom of a five-section page. Both patterns already exist here — `aria-describedby` on a hint (`members.$id.tsx:739`, `vp-membership.tsx:862`) and a persistent `<p className="text-sm text-destructive" role="alert">` field error (`signin.tsx:95`, `club.$clubId.index.tsx:357`) — so the fix is wiring, not invention: hold the rejection in a `logoError` state alongside the toast and render it under the input. Pre-existing for the whole section; surfaced by the #504 design review and deliberately not folded into that change, which was about where the limits are declared. Worth doing next time this route is open.
  **Priority:** P3

- **Dev-server only: a club logo `<img>` 404s under `bunx vite dev`, so every logo looks broken during local browser QA.** Measured on Vite 8.1.0 during the #504 review: `GET /api/club/<id>/logo?v=<n>` answers 200 to curl, to `fetch()`, and with `Sec-Fetch-Dest: document` or `empty`, but 404s (`text/html`, 189 bytes) with `Sec-Fetch-Dest: image` — exactly what an `<img>` sends. The response carries `vary: sec-fetch-dest`, which nothing under `src/` sets, so the branch is in Vite's dev middleware ahead of the Nitro handler rather than in `api/club.$clubId.logo.ts`. **The production build is unaffected**, verified by running `.output/server/index.mjs` against the same seeded database: 200 with the correct bytes for `Sec-Fetch-Dest: image`, and the crest renders at `naturalWidth: 800` in a real browser on `/club/<slug>/roles`. Recorded because it reads exactly like a logo-serving regression — empty preview box, `naturalWidth` 0, endpoint fine by hand — and cost a review pass fifteen minutes to rule out. QA a logo surface against the production build, or with `fetch(url, {cache:"no-cache"})`, rather than trusting the rendered `<img>`.
  **Priority:** P4

- The `/admin/club-settings` loader re-ships the ~420-entry timezone list on every save of any form on the page. `loadClubTimezoneSettings` sits in the same `Promise.all` as the other four loaders, and all five forms call `await router.invalidate()` on success — which reruns the whole route loader. So saving the mission statement, the reminder lead time, the agenda variant or the logo each re-serialises and re-sends ~7.6KB of static zone names that only change when the Node runtime's ICU tables do. Not a correctness bug and the page is admin-only, which is why #547 shipped it as-is; the fix is a choice between splitting the loader into a cheap `{ timezone }` call plus a separately-cached `zones` list, and moving the list to its own server fn behind a long TanStack Query `staleTime`. Worth doing next time this route is open, since the list is the largest thing on the payload by an order of magnitude.
  **Priority:** P4

- `selectClass` has SIX definitions and #547 made three of them stale. Four are `Input`-derived — `/admin/roles` (`roles.tsx:54`), `/admin/schedule` (`schedule.tsx:38`), `/admin/meetings/batch` (`meetings.batch.tsx:42`) and club-settings — and the first three are still byte-identical copies of the pre-Tailwind-v4 string (`shadow-sm`, a 1px single-colour focus ring, no `dark:bg-input/30`, a bare `text-sm`). #547 updated only the club-settings copy, because that one sits directly among `Input`-styled text fields where the difference is visible on focus and in dark mode. The other three sit among peer selects, so nothing looks wrong — but the `text-sm` in them triggers iOS Safari's auto-zoom on focus exactly as it would have here. (The remaining two, `activity.tsx:70` and `roster.tsx:1346`, are a separate token-based variant on `--surface-strong`; they are not copies of the Input string and are not stale, but they are why "one shared constant" needs to decide whether there are one or two intents here.) The real fix is a `ui/select.tsx` wrapping the native element, not a seventh copy.
  **Priority:** P4

## Testing

- The declaration-slicing helper is copy-pasted between two guard tests, and one of them is a security gate. `club-settings-authz.guard.test.ts` (#547) carries a verbatim copy of `TOP_LEVEL_BOUNDARY` and the body-slicing walk from `public-readers-archive-gate.guard.test.ts`, including the #565 rationale in the comment. That logic exists because a naive slice let one endpoint borrow a neighbour's `require*` call and be filed as gated while it was open — measured at 40 of 162 slices over-capturing. With two independent copies, a future correction has to be remembered twice, and the copy that matters more is the archive sweep. Extract into `src/test/guard-source.ts` beside `readSource`. Deliberately not done inside #547: editing the #560/#565 guard as a drive-by in a timezone PR is the wrong blast radius for that change, and it wants its own review.
  **Priority:** P3

- Two integration suites hand-copy queries that #544 turned into reachable seams, so they now assert against copies that can never fail when production changes. `public-reads.integration.test.ts` has `listUpcomingMeetingsPublic` (a verbatim mirror of what is now `loadPublicUpcomingMeetings`) and `getMeetingPublic` (a mirror of `loadMeetingDetail`); `member-status.integration.test.ts` has `listActiveMembers` (a mirror of what is now `loadPublicClubRoster`). The first two are the repo's "a parity test cannot see a defect present on both sides" trap with the twist that only one side is production code — and the mirrors carry no archive gate, so they have already diverged. Both files already `vi.mock("#/db")`, so re-pointing them at the real seams is a small edit. `getMeetingPublic` cannot be re-pointed until `loadMeetingDetail` is exported from a `*-logic` module.
  **Priority:** P3

- `seedPhone` in `src/db/seed.ts` cannot be tested. `seed.ts` imports `#/db` at module load AND calls `main()` unconditionally at the bottom, so importing it from vitest throws before any assertion runs — the CLAUDE.md "a constant in a module that imports `#/db` at load is unassertable" corollary, applied to a formatting helper instead of a numeric cap. Nothing exercises the E.164 shape or the determinism the function promises, so a change that produced a duplicate or a malformed number would be invisible until someone noticed drafts failing. Fix is the pattern CLAUDE.md already prescribes: move `seedPhone` into `src/lib/` and let the seed import it. Surfaced by the v1.16.0.0 coverage audit.
  **Priority:** P4

- Two `#576` behaviours are reachable only from a real browser, and both are the kind a source guard pins as TEXT while never executing. (1) `tmodPanelUnavailable` — the guard proves the expression and the JSX ternary exist, but nothing observes that a pending or errored query actually suppresses the panel, which is the whole point of it (an empty roster otherwise renders a header and a counts line of zeros, indistinguishable from "no members"). (2) `resolveActor`'s arms — the write-side TMOD comparison, the `OFFICER_DENIALS` catch-and-fallthrough, and the self arm's throw are all private to a `createServerFn` module, so vitest cannot invoke any of them; the read-side twin (`loadTmodPanelData`) IS executed and covers the equivalent decision, but the write path's own resolution never runs. Both need an HTTP-level or browser test, which this repo has no seam for yet. Accepted for v1.16.0.0 rather than hidden: the guards pin the shape, and the /qa pass drove both paths by hand.
  **Priority:** P3

- **Roll call costs one full route-loader round trip per tap.** Every roll-mode write resolves
  online through `useOfflineMinutes.mutate` → `onMutated` → `router.invalidate()`
  (`src/routes/club.$clubId.meeting.$meetingId.tsx:303`), which re-runs the WHOLE meeting loader:
  `loadMeetingDetail` alone issues ~15 sequential DB round trips, plus `listPastMeetings`,
  `listUpcomingMeetings`, `getMinutes` and `getClubLogoMeta` — roughly two dozen sequential
  queries to persist one member's present/absent/excused. `mutate` awaits it INSIDE the `busy`
  window, and since the /review fix the panel correctly disables every chip for that whole
  window, so an officer tapping down a 20-40 name roster at conversational pace lands a large
  fraction of taps on a disabled control. Found independently by the performance specialist and
  the adversarial pass on the v1.16.0.0→PR3 review, at confidence 9.
  Plan mode does NOT have this problem: it applies a local `rungOverride` optimistic update, so
  its taps feel instant. Roll mode is inconsistent with its own sibling, which is why this reads
  as a gap rather than an inherent cost. The shape that works is per-row optimistic state plus a
  serialized single-flight writer (accept every tap, apply locally, drain in order) rather than a
  global refuse-and-disable. Deliberately NOT fixed in the review round: it is an optimisation of
  a path that works, and the right shape needs measuring against a real club payload first.
  **Measure `router.invalidate()` against a real club before choosing.**
  **Priority:** P1

- **The roll-mode suggestion chip may not be distinguishable from a recorded one.** D3's whole
  premise is that a member with a plan but no recorded row renders a dashed "Present?" that commits
  in one tap — but the only visual differentiator is `className="border-dashed"` on a
  `variant="outline"` Button (`meeting-attendance-panel.tsx:140`), and `outline`'s border is
  `--border: var(--line)` = `rgba(23,58,64,0.14)` light / `rgba(141,229,219,0.18)` dark
  (`src/styles.css:22,101`) — a 1px line at ~15% opacity. Dashed vs solid at that opacity will not
  read at arm's length, and nothing else differs: no fill, no background tint, no icon. The
  trailing `?` is the only other cue and it requires READING each label rather than
  pattern-matching the row, which is the failure mode the design exists to avoid. If an officer
  cannot tell guesses from records at a glance, the counts they read out to the club are wrong.
  Fix: give the suggestion state a fill or background tint (or a coloured left bar) on top of the
  dashed outline. Design specialist, confidence 8, on the PR-3 review.
  Nothing in this repo can gate it — jsdom performs no layout, so no test can see it.
  **Priority:** P1

- **A captive portal's 200 HTML login page makes a roll tap read as SUCCESS and vanish.** Found
  while investigating whether the offline queue can tell a transport failure from a server-chosen
  one (the /ship-halt round's F5). Three flavours, and the third is the bad one:
  1. A `fetch` rejection is rethrown unchanged, so it arrives as a bare `TypeError`.
  2. `instanceof TypeError` is NOT a usable discriminator: seroval reconstructs a *server-thrown*
     `TypeError` as a `TypeError` too (fixed constructor table), so classifying on it would
     queue-and-replay-forever on any server bug — the stuck queue the current comment exists to
     avoid. A naive class-based fix is WRONG, not merely partial.
  3. **Two of the three portal shapes never reach that catch at all.** A portal's 200
     `text/html` login page falls through to `return response`, so the write currently reads as
     success, the chip moves, nothing is queued, and the roll entry is silently lost — on the
     exact network this feature exists for.
  The reliable seam is TanStack Start's `CustomFetch` (`createStart({ serverFns: { fetch } })`),
  which this repo does not configure at all. That is where a transport-vs-server classification
  belongs, and it would fix all three flavours at once.
  **Priority:** P1

- **The panel's two modes disagree about who is "coming".** v1.19.0.0 (#594) taught
  `buildPlanPanel` to derive an **assumed** `coming` from a CONFIRMED `role_slots` row — an
  inference standing in for an answer, rendered muted with the word "assumed". Roll mode's
  suggestion derivation (`buildRollPanel` → `suggest()`) reads the RAW `plan` array, and `assumed`
  is computed inside `buildPlanPanel`, so it never reaches roll. Net: a confirmed role-holder who
  never replied reads "Coming" in the rail on Monday and gets **no dashed `Present?` suggestion**
  in roll mode on Wednesday.
  Surfaced by merging #594 into the roll-mode branch; neither side's tests could see it, because
  neither side had the other's code. Preserved both behaviours in that merge deliberately rather
  than smuggle a product decision into a conflict resolution — the divergence is documented at the
  derivation site in `meeting-attendance-panel.tsx`.
  The call to make: is a confirmed role-holder good enough evidence to pre-fill `Present?`. A
  reasonable argument says yes (they are MORE likely to attend than someone who merely typed
  "coming"), and one panel's two modes disagreeing about the same word is the exact class this
  PR exists to end. Against: a suggestion sourced from an inference is weaker evidence than one
  sourced from an answer, and roll mode commits it in ONE tap.
  **Priority:** P1

- **A recorded attendance row can never return to "unmarked".** `setAttendance`'s validator takes a
  required non-null `attendanceStatus` (`src/server/minutes.ts:115`), so there is no clear path:
  `ROLL_MENU` offers `present | absent | excused` and no fourth option, and no `clearAttendance`
  variant exists in `MinutesOp` or the drain's fn map. `unmarked` is a count the minutes PDF
  prints, so a row recorded in error can be changed but not undone.
  Pre-existing — main's rows have the same limitation and no roll-mode code made it worse — and
  deliberately left out of the roll-suggestion round: clearing needs a NEW server fn with its own
  `gateAdmin`, `assertAttendanceRecordable`, activity-log entry, queue op and drain dispatch. That
  is a server-authz surface, not a fix round. Noted here because the decision that authorised that
  round said "also add a clearAttendance op", and this is the half that was narrowed out rather
  than silently dropped.
  Lower urgency now that a suggestion row can be marked absent directly (no false `present` write
  is required to reach the other statuses), which was the actual bug.
  **Priority:** P2

- **Roll-mode a11y and copy residue** (final adversarial pass; all LOW, none data-affecting).
  1. The `arriving` nudge copy ("we've started our meeting — are you on your way?") fires from
     club-local **midnight**, because `phase` flips to `today` at day granularity
     (`src/lib/meeting-lifecycle.ts:41-44`) and the plan panel is gone by then — so meeting-day
     morning outreach necessarily goes through roll rows and drafts something false for ~19 hours
     before a 7pm meeting. Human-in-the-loop (the officer edits before sending). A gate on the
     meeting's wall-clock start closes it. Same defect class the `arriving` mode was added to fix.
  2. `SyncStatus` renders twice for an admin on meeting day (panel header + Minutes card) and is now
     `role="alert"` in both, so a sync error is announced **twice assertively** with two Retry
     buttons in the a11y tree. The duplicate render is deliberate; only the announcement is new.
  3. The pending count sits in a polite live region whose text is the count, so taking roll offline
     across 40 members queues 40 announcements. Debounce it, or announce the transition into
     "pending" rather than the number.
  4. Mid-drain, each landed op is removed from queue state before the authoritative refetch, so the
     Minutes card's Table Topics and awards visibly shed rows and get them back. The panel is
     disabled throughout so no re-tap is possible; pre-F2 the window was uniformly stale instead, so
     this is newly visible rather than newly wrong.
  **Priority:** P2

- Smaller residue from the same review, none blocking: plan mode's `DropdownMenuItem`s are
  ungated where roll mode's are now gated (`meeting-attendance-panel.tsx:100-106`; `writeRung` has
  no `writesLocked` precondition while its sibling `contacted` does); `RollAttendanceRow` and
  `AttendanceRow` duplicate the same row shell; ~~`projectMinutes` hand-copies the online/offline branch
  from `meeting-minutes.tsx`~~ — DONE, extracted to `src/lib/project-minutes.ts` and imported by
  both surfaces during the review rounds, so the drift this asked about is now compiler-visible; the roll chips' `aria-label` is `"<name> status"`, which REPLACES the visible
  text for assistive tech so a screen-reader user never hears "Present?" vs "Present"; the chips
  are `size="sm"` (32px) against a ~44px thumb target; and neither mode renders an empty-state
  fallback for a club with zero rows, while the Guests group and the read-only record both do.
  **Priority:** P2

## Print & artifacts

- The canonical meeting page (`club.$clubId.meeting.$meetingId.tsx`) is the one logo-supplying loader with no test on its `logoUrl` wiring. v1.5.0.0 covered the two standalone public print routes after a coverage audit forced all four loaders to null and the whole suite stayed green; this one was left because the route imports enough that isolating it needs more mocking than the other two. Its only logo consumer is still the `.pptx` export, so the blast radius is one surface — but the path moved in v1.11.0.0 (#541): `PptxDownloadButton`'s `logoUrl` prop is gone and `downloadDeckPptx` reads the logo off the deck's title slide, so the untested seam is now loader → `buildSlideDeck` → title slide. Same seam, still untested.
  **Priority:** P4

- The print page-count gate (v1.8.4.0, #502) has three known blind spots, each mutation-verified as surviving. (1) A PARTIAL loss of the guard's recursive route walk is undetected: the vacuity check only asserts more than 20 route files are found, so losing the whole `_authed/**` subtree — 12 files, including `vp-membership.tsx`, the one other `@media print` route and the stated reason recursion exists — still passes. (2) The walk only sees `.tsx`, skips symlinked directories (`Dirent.isDirectory()` is false for them), and the "no route hand-rolls its own page CSS" check keys on `.pgwrap` specifically, so a route wrapping its sheet in any other class is unenrolled. (3) `PRINT_PAGE_CSS`'s two `body { background }` rules are pinned by nothing at all — the count cannot see a background and no grep asserts them. Separately, the agenda fixtures build `rows` by hand and omit `roleKey`, which `expandRunSheet` always sets, so every fixture row takes a name-matching fallback branch the real route never takes.
  **Priority:** P4

## Voting

- A write-in cannot be removed once cast (#582). The ballot is public and unauthenticated, so anyone with the link can put an arbitrary string in front of the room: it appears as a tappable candidate for every later voter, in the Ballot Counter's tally, and — if crowned — on the projected awards slide and in the minutes PDF. Nothing today lets the Vote Counter delete one before results are read. Bounded in LENGTH (`WRITE_IN_LIMITS.name`, 80) and in ROWS (one per voter per category, and the per-meeting guest cap bounds voters), so this is a nuisance surface rather than a DoS one — but it is the obvious next ask the first time someone abuses it, and it is much cheaper to add beside the existing tally UI than to retrofit. Deliberately out of scope for the first cut; the decision is recorded on the issue.
  **Priority:** P2

## Guests & identity

- `members_club_idx` is now a strict prefix of `members_club_person_unique` and serves no query the composite cannot, so it is dead weight on every members write. Dropping it is a follow-up migration; `members_person_idx` must stay (person_id is the trailing column and `people-merge-logic.ts` looks up by person alone).
  **Priority:** P4

- `PHONE_CANDIDATE_LIMIT = 50` is untested on both dedup scans — shrinking it to 3 is invisible to the suite. Pinning it needs 51 same-phone rows with the only agreeing row sorting last, which is a slow fixture for a documented-and-safe overrun (the cap can only ever mean "no match", which creates a fresh Person).
  **Priority:** P4

- Two meetings on the same club-local day: `resolveCurrentMeeting` takes the FIRST row in `asc(scheduledAt)` order that is in progress, so a club running an 08:00 special session and its regular 19:00 meeting could file a 19:15 guest-book signature against the 08:00 one. Narrowed a lot by v1.9.0.0 — the window is now `[start − 90min, end + 60min]` rather than the whole calendar day, so the two meetings must be within ~2.5h to overlap at all — but not closed. Fix is to pick the CLOSEST in-progress meeting rather than the earliest. Silent when it happens: the row looks identical to a correct one afterwards.
  **Priority:** P3

- `submitGuestBook` writes a `meeting_attendance` row with `status: "present"` during a live meeting, and `minutes-logic.ts` reads that table with no date gate — so an unauthenticated caller can assert a fact into the club's official minutes, which are then emailed out. RATE LIMITING is done (v1.10.3.0, 30 new guests per club per hour, and the same TOCTOU fixed on #326's roster cap), so the volume is bounded. What is NOT done is the modelling: `meeting_attendance` stores "an officer marked you present" and "someone typed your name into a public form" identically, and the minutes present both as fact. The real fix is provenance — a `source` column (`officer` | `self_reported`) so the minutes can render a self-report distinctly or hold it for a tap — not more prevention. Gating the write behind officer confirmation as a first step would be worse: it silently drops guests when nobody is watching the console. Needs a migration plus minutes/PDF/email changes, so it wants a spec rather than a patch.
  **Priority:** P3

- #541 PR 1, deferred by /qa (2026-08-10) — the meeting "Print & export" dropdown sits flush against the RIGHT viewport edge at 375px (measured: menu `right` = 375 = viewport width), so it touches the screen edge and clips its own shadow while every card on the page keeps a ~16px gutter. Nothing overflows and no content is cut off, which is why it is here and not an issue. Fix is `collisionPadding` on `DropdownMenuContent`; do it in PR 2 with the rest of the mobile chrome pass.
  **Priority:** P4

- #541 PR 1, deferred by /qa (2026-08-10) — an ANONYMOUS visitor with a stored identity gets the filled phase primary popping in after hydration: identity lives in `localStorage`, so the SSR HTML contains zero occurrences of `toolbar-primary` (verified by curl) and the button appears on hydration, shifting the rest of the toolbar row right. Only on meeting day, only for anon-with-identity. Inherent to localStorage identity — a real fix is reserved space or cookie-backed identity, which is a design change, not a patch. Matches the final #541 review's Minor 4.
  **Priority:** P4

## Completed

- `attendance-plan-backfill.integration.test.ts` read the plan table with no filter, so its count
  assertions counted rows every other suite had written. Vitest runs files in parallel and eighteen
  of them write `meeting_attendance_plan`; `expect(rows.size).toBe(1)` was seen getting `2`, then
  passing alone and on re-run, which reads as a flake in whatever branch is open. Fixed by scoping
  `planRows()` to the fixture's own meeting, not by retrying — a cross-club read is wrong on its own
  terms, since it makes the assertion depend on what else the runner scheduled. Verified by planting
  a foreign plan row in `tm_test` and running the suite both ways: scoped passes 5/5, unscoped fails
  **three** tests. Three, not the two this entry originally claimed — the count missed the inline
  `(await planRows()).size).toBe(0)`.

  **The sweep that accompanied this fix was narrower than it claimed, and this entry originally
  overstated it.** It checked reads of `meeting_attendance_plan`, `activity_log`, `members` and
  `meetings` for a MISSING club/meeting filter, and on that basis said the class was closed. It is
  not: a read can carry a filter that does not isolate the fixture. `onboarding-logic.integration.test.ts:135-145`
  asserts `expect(secondClub.length).toBe(0)` scoped by the literal `clubs.name = "Second Club"`,
  and `expect(orphanPerson.length).toBe(0)` scoped by `people.email = "second@example.com"` — so
  any concurrent suite (or a row left by an earlier failed run) that creates either makes those
  assertions fail. It flaked exactly that way during the PR-3 review round, passing in isolation
  and on re-run. Same failure mode as the bug this entry is about, different shape, so the original
  sweep could not have seen it. Re-sweep for reads scoped by a HARDCODED literal, not only for
  reads missing a filter.
  **Completed:** v1.20.0.0 (2026-08-18) — rode along with the roll-mode release rather than
  shipping as its own version.

- An impersonation session outlived the superadmin's own access. `getActiveImpersonationForUser`
  selected on `superadminUserId` / `endedAt` / `expiresAt` and never re-read `user.is_superadmin`,
  while `reconcileSuperadminFlag` runs on the SIGN-IN hook and touches no session — so removing an
  address from `SUPERADMIN_EMAILS` left an open session granting club reads for the rest of its TTL
  (60 min read-only, 15 read-write). ADR-0016 §2 accepts that the FLAG lags until next sign-in, but
  that was written before impersonation existed and a session is a second, separate grant. One join
  plus `eq(user.isSuperadmin, true)` closes it; revocation now lands on the operator's next request.
  **Completed:** v1.13.2.0 (2026-08-15) — #567

- The archive check cost an avoidable round-trip on every gated read. `assertClubNotArchived` issued
  its own `SELECT archived_at FROM clubs` for a row `getMembership` was about to resolve anyway, so
  each gate ran 2 statements instead of 1 and `/admin/vpe-dashboard` spent 9 on pure authorization
  rather than 6. `getMembership` now carries `clubs.archived_at` on a join (with `clubs.archivedAt`
  added to the `groupBy` — Postgres does not infer functional dependency across a join), the member
  arms read the resolved row, and only the memberless impersonation arm still queries. Pinned by a
  driver-level statement count in `archive-club.integration.test.ts` rather than a spy on a named
  loader, so a later refactor that reintroduces the lookup by any means fails.
  **Completed:** v1.13.2.0 (2026-08-15) — #566

- The derived enrollment sweep in `public-readers-archive-gate.guard.test.ts` reported green while
  skipping a reader. `serverFnBody` ended a declaration at a literal `\n});`, but every
  `createServerFn` here closes at one tab because `.handler(` is chained one level in — so the slice
  ran past the declaration and swallowed whatever followed. `getMinutes` absorbed `gateAdmin`,
  matched THAT function's `requireUser`, and was filed as session-guarded and skipped, which is how
  the #560 minutes leak reached production behind 54/54 green. Measured before the fix: 40 of 162
  slices over-captured, one by 11,000 characters. The slice now ends at the next top-level
  declaration, `getMinutes` is enrolled with a WIRINGS row, and a new vacuity case fails on any
  slice that runs past its own declaration rather than letting the next recurrence be invisible.
  **Completed:** v1.13.1.1 (2026-08-15) — #565

- An impossible meeting date in a URL silently resolved to a REAL, different meeting. `parseMeetingKey` was shape-only, and `Date.UTC` overflow-rolls, so `2026-09-31` returned October 1st's meeting with a 200 — on the public ballot, a vote cast in a meeting nobody chose. The 500 originally recorded here (`9999-99-99`) was the loud minority case; the silent roll was the bug. Fixed by rejecting impossible dates (and times) at parse, which covers all four public meeting routes at once.
  **Completed:** v1.10.2.0 (2026-08-10)

<!-- Items move here with: **Completed:** vX.Y.Z.W (YYYY-MM-DD) -->

- The MCF handback beat ("Toastmaster of the Day · Introduces the speakers") has no counterpart slide in the projected deck, so a Toastmaster running the meeting off the projector alone does not see the cue.
  **Priority:** P4
  **Completed:** v1.1.0.0 (2026-07-29) — every hand-off now has a matching slide, labelled by target.

- **Phase 2: per-meeting agenda editing.** Landed per the configurable-agendas spec
  (`docs/superpowers/specs/2026-08-21-configurable-agendas-design.md`). Converting a meeting to a
  template deep-copies the source template's row, roles and beats into a private per-meeting row
  (`meeting_templates.meeting_id`, nullable, unique when set); reverting deletes the private copy,
  and re-converting makes a fresh one rather than reusing the retired row. `ensureAgendaDraft`
  upgrades a meeting still pointing at a pre-feature SHARED template into a private copy on its
  first edit, returning `{ templateId, forked }`. `listAvailableTemplates` excludes private
  per-meeting copies from the picker, in the query rather than a caller-side filter. No new
  tables, one read seam. The caps in `src/lib/meeting-template-limits.ts` were measured (not
  merely asserted) against an officer-authored, all-axes-hostile fixture: linear cost with no
  knee to 16x the beat cap, worst case ~33-35ms against a 250ms budget — so the ceilings were
  confirmed rather than lowered. See CONTEXT.md's **Meeting template** entry.
  **Completed:** v1.24.0.0 (2026-08-22) — #615.

- **`buildTemplateRows`' repeat-block binding is no longer unexercised.** The configurable-agendas
  spec's D4 resolved the two previously-unreachable shapes by CONSTRAINING rather than adding a
  stored setting: `repeats_role_key` IS the once/per-holder flag — null means "once", the row's
  own key means "per holder" — and a per-holder row must repeat over the exact role it names.
  The two shapes resolve DIFFERENTLY, and this entry said "both unauthorable" until the
  end-of-branch fix wave corrected it. A role row whose `roleKey` differs from its
  `repeatsRoleKey` is genuinely unauthorable, enforced in both halves: the editor's Role select
  patches both keys together, and `assertRepeatBinding` refuses the merged row at the writer. A
  block with two role-owning rows stays authorable and is simply DEFINED now — both rows name
  the block's role, so each iteration binds both to that iteration's slot. A non-role row inside
  a block (the contest's ballot minute) is untouched by the rule, which is why the check is keyed
  on `kind`. The workaround this constraint made unnecessary (routing the contest's tally and
  timers' report around multi-slot roles) was dropped in the same pass: both beats now bind back
  to `ballot_counter` / `contest_timer`.
  **Completed:** v1.24.0.0 (2026-08-22) — #615.
