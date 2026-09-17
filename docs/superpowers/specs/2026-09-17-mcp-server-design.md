# MCP server — design

**Issue:** #771
**Depends on:** ADR-0004 (magic-link auth), ADR-0005 (role_slots source of truth), ADR-0009 (speeches first-class), ADR-0012 (meeting lock), ADR-0014 (minutes record), ADR-0018 (guest pipeline), ADR-0020 (superadmin impersonation), ADR-0021 (read-triggered schedule top-up)
**Status:** brainstormed and grilled with the maintainer 2026-09-17, then reviewed by `/plan-eng-review` the same day (11 findings, all folded in below). Ready for `/spec`.
**Ships as three PRs** (D14), not one.

Code was read at `main` 78cba28. Line numbers cite that tree and may drift.

---

## Problem

The maintainer uses an LLM for the club's bulk data entry: create a season of meetings with themes, transcribe the paper guest book, fill role slots. Today the LLM does it by **driving the browser**. That is slow, breaks when the UI changes, and shows nothing of what will be written before it lands in minutes that are emailed to the club.

Nothing outside the browser can call the app. Server functions authenticate with the session cookie (magic link only, ADR-0004). The one bearer credential that exists, `sync_tokens`, identifies a **club, not a person**, and only `/api/pathways/ingest` accepts it.

The direction: an MCP endpoint inside the app, so an LLM makes these changes as typed, previewable calls. The only user for now is the maintainer. Nothing here may block other officers connecting their own LLMs later.

## What ships

- `/api/mcp`: MCP over Streamable HTTP, stateless.
- User-scoped personal access tokens, created and revoked on `/me`.
- Seven tools: four reads, three previewable writes.
- One shared guest matcher, which also fixes `addMinutesGuest` creating duplicate guests.
- One migration: the `api_tokens` table and the `guest_visits_record` activity action.

## What does not ship

- OAuth, and with it connecting from claude.ai or ChatGPT on the web. Added to this endpoint when a second user arrives.
- Access for non-admin members. Every tool requires admin or an open officer term.
- Superadmin reach into clubs the token owner is not a member of (D3).
- Per-token scopes or expiry. Revocation is the kill switch.
- Speech details on speaker assignment (D8).
- Editing agenda row text, notes or reminders (`meeting-agenda-edit`).
- Tracking whether minutes were emailed (D7).
- A general REST API.

## Already done — do not rebuild

| Capability | Where | Note |
|---|---|---|
| Server route with bearer auth and a body cap | `src/routes/api/pathways/ingest.ts` | the shape `/api/mcp` copies |
| Hashed, revocable, shown-once token | `sync_tokens`; `src/server/sync-tokens.ts`; `parseBearerToken` in `pathways-ingest-logic.ts` | `api_tokens` mirrors it, keyed to a user |
| Batch meeting insert, same-date skip, one transaction | `applyBatchCreateMeetings` (`batch-meetings-logic.ts`), `insertMeetingWithSlots` (`meeting-create-logic.ts`) | extended with per-meeting fields |
| Meeting field edits | `applyMeetingUpdate`, `applyWordOfTheDayUpdate` (`meetings-logic.ts`) | caps in `MEETING_FIELDS` (`src/lib/meeting-limits.ts`) |
| Schedule top-up | `ensureScheduleToppedUp` (`schedule-topup-logic.ts`) | idempotent |
| Guest dedupe | `findGuestByContact` (private, `guest-pipeline-logic.ts`), `namesAgree` (`src/lib/person-name.ts`), `toStoredPhone` (`src/lib/phone.ts`) | exported as `matchGuest` (D7) |
| Past-meeting guest attendance | `addGuestPresent`, `assertAttendanceRecordable` (`minutes-logic.ts`) | |
| Slot reassignment with speech disposition, row-locked | `reassignSlotCore`, `reassignSlotSpeech` (`slots-logic.ts`) | |
| Guest into a slot | `applyAssignGuestToSlot` (`guests-logic.ts`) | |
| Meeting lock | `assertMeetingNotLocked` (`meeting-authz-logic.ts`) | |
| Officer counts as admin | `getOpenOfficerPositions` (`officers-logic.ts`) | |
| Audit log | `logActivity` (`activity.ts`) | |

## Decisions

### D1 — The endpoint lives in the app

`src/routes/api/mcp.ts` uses `createFileRoute(...).server.handlers`, the same shape as ingest. Tools are thin handlers in `src/server/mcp/`: validate with zod, authorize (D3), call `*-logic.ts`.

Rejected:

- **A local stdio process against the production database.** It bypasses every guard, puts database credentials on a laptop, and cannot serve a second user.
- **A REST API with an MCP wrapper.** Two surfaces to maintain for one consumer.

The transport is stateless Streamable HTTP: no MCP session storage, and each POST stands alone.

**MEASURED 2026-09-17** (`npm pack @modelcontextprotocol/sdk@1.30.0`): the SDK ships
`server/webStandardStreamableHttp.js`, exporting `WebStandardStreamableHTTPServerTransport`
with `handleRequest(request) → Promise<Response>`, plus a Hono example that is three lines
of route code. Stateless mode is `sessionIdGenerator: undefined`.

**The route builds a fresh `McpServer` and transport on every request.** In stateless mode
the transport refuses a second use:

```js
// webStandardStreamableHttp.js:168-174
async handleRequest(req, options) {
    // In stateless mode (no sessionIdGenerator), each request must use a fresh transport.
    if (!this.sessionIdGenerator && this._hasHandledRequest) {
```

Hoisting the transport (or the server) to module scope for reuse is the tempting
optimization and it breaks on the second tool call. D12 tests two sequential calls against
one running process.

### D2 — Personal access tokens, keyed to a user

New table `api_tokens`:

| column | |
|---|---|
| `id` | uuid |
| `user_id` | → `user.id`, cascade |
| `token_hash` | SHA-256, unique |
| `name` | text |
| `created_at`, `last_used_at`, `revoked_at` | timestamps |

The raw token is `tmk_` plus 32 random bytes in base64url, shown once. The prefix differs from `gup_`, so a pasted token says which kind it is.

Tokens are created, listed and revoked on `/me`. That page is user-level, which matches a token that belongs to a person rather than a club. The section appears only for a user who is an admin in at least one club.

The endpoint accepts a bearer token only and never reads the session cookie (D3).

On the client, `claude mcp add --header` writes the token in plain text to `~/.claude.json`. That is acceptable for one user, and one reason OAuth comes before other users.

### D3 — Token authorization: a real admin membership, no impersonation

There are **two** entry points in `src/server/mcp/authz-logic.ts`, and every tool calls
exactly one of them:

- **`authenticateToken(rawToken)`** — the token resolves to an `api_tokens` row that is not
  revoked, and returns the user with the clubs where they hold an active admin membership
  or an open officer term. **Only `whoami` uses it**, because `whoami` is what tells the
  LLM which clubs exist and so has no `clubId` to check against.
- **`authorizeToken(rawToken, clubId)`** — calls `authenticateToken`, then:
  1. `getMembership(userId, clubId)` returns a membership with status `active`;
  2. that membership has `clubRole === "admin"`, or an open officer term;
  3. `assertNotArchived` passes.

The guard (D12) derives the tool set and fails any tool that calls neither, with `whoami`
waived by name and reason. Splitting the two keeps "no unauthenticated tool" machine-checkable
without an exemption list.

The club comes from the tool's `clubId`. When a tool names a meeting (`meetingId`, `meetingDate`), the club is derived from that meeting on the server. **A club ID from the input is never trusted when a meeting is named.**

`authorizeToken` does **not** call `requireClubRole`. That function falls back through `requireMembership` to `requireReadWriteImpersonation(userId, clubId)`, which reads impersonation sessions from the database. Without this rule, a superadmin with a browser "act as admin" session open on a club would pass that authority to every token call on the same club. Found in grilling: `guards.ts:257-285`.

The actor credited in `activity_log` is that membership's `id`. `resolveWriteActor` is not called and no tool input carries `actorMemberId`, so `actor-provenance.guard.test.ts` passes unchanged.

**CSRF:** bearer-only means a cross-site POST carries no ambient credential. A guard (D12) enforces it: nothing under `src/server/mcp/`, and not `src/routes/api/mcp.ts`, imports any of these:

- `getSessionUser`
- `requireUser`
- `requestWriteActor`
- `requireClubRole`
- `requireMembership`

### D4 — Seven tools

| tool | kind | input | returns |
|---|---|---|---|
| `whoami` | read | none | The user, and the clubs where they are admin: `id`, `name`, `timezone`, plus the recurrence rule's weekday and time if the club has one |
| `list_meetings` | read | `clubId`, `from?`, `to?` (club-local dates) | `id`, local date, weekday, time, number (provisional or frozen), theme, status, open-slot count. Runs `ensureScheduleToppedUp` first |
| `get_agenda` | read | `meetingId` | Theme, Word of the Day, locked flag. Slots: `slotId`, role, `slotIndex`, assignee `{kind, id, name}` or open, `evaluatesSlotId`, and the speech title when one is linked |
| `find_people` | read | `clubId`, `query?` | Members and guests together: `id`, `kind`, `name`, `preferredName`. Guests add `stage`, visit count and masked contact (D9) |
| `upsert_agendas` | write | see D6 | plan, or result |
| `record_guest_book` | write | see D7 | plan, or result |
| `assign_roles` | write | see D8 | plan, or result |

The server `instructions`, sent at MCP initialize, state the protocol:

1. Call a write tool without `planHash`.
2. Show the preview to the user and get an explicit yes.
3. Call again with the same input plus `planHash`.
4. Never resolve an `ambiguous` entry without asking the user.

### D5 — Preview, then apply, by plan hash

Each write tool has a planner, `planX(input, conn)`, that returns a plain plan object. **One
pure module, `src/lib/mcp-plan.ts`, holds `canonicalize()` and `planHash()`; no tool hashes
for itself.** Canonical form is:

- keys sorted and entries in input order;
- no timestamps;
- existing rows referenced by id, new rows by input index.

Property tests live with that module: the same state hashes the same, key order does not
matter, and any value change changes the hash. Three tools sharing one canonicalizer is the
only way PR2 and PR3 inherit a mechanism that is already proven rather than re-deriving a
subtly different one (an unstable field would make every apply fail as `PLAN_STALE`, which
reads like a database race).

A plan contains **only the rows it would touch**, so a write elsewhere in the club does not make it stale.

`planHash = sha256(canonical({tool, clubId, userId, plan}))`. It detects drift and is not a credential; every call is authorized on its own.

**Without `planHash`,** the tool plans and returns `{plan, planHash, blocking: [...]}`. Nothing is written.

**With `planHash`,** the tool works in one transaction:

1. Take the club lock through one helper, `lockClub(tx, clubId)`, which runs
   `pg_advisory_xact_lock(hashtext($1))` on the club's uuid. Every apply path calls it, so
   two applies on one club always exclude each other. A hash collision between two clubs
   costs a brief wait and nothing else.
2. Re-plan against `tx`.
3. If the hash differs, roll back and return `PLAN_STALE` with the fresh plan and hash.
4. If `blocking` is non-empty, return `BLOCKED`.
5. Execute **the plan**, not the input.
6. Call `logActivity` in the same `tx`.
7. Return the ids of rows created or updated.

A call applies entirely or not at all. Problems with single entries are `blocking` items in the preview, and apply refuses while any remain. Examples: a bad phone number, an unresolved `ambiguous`, a locked meeting, no meeting on a date.

The advisory lock exists because `guests` has no unique constraint. It serializes MCP applies with each other. `submitGuestBook` does not take it, so a public guest-book submission can still land inside the apply transaction. The re-plan inside the transaction narrows that window to the transaction itself (open question 3).

### D6 — `upsert_agendas` replaces create-only batch

**Input:** `clubId`, and `meetings: [{date, time?, theme?, wordOfTheDay?, wodDefinition?, wodExample?, location?}]`, at most 52 (`MAX_BATCH`).

The main use is creating a season months ahead. It also fills in meetings that already exist. A club's recurrence rule creates `keep_ahead` future meetings on authenticated reads (ADR-0021), which token calls never reach, so the planner runs `ensureScheduleToppedUp` first.

**Where the top-up runs:** once, before planning, and before the apply transaction opens.
Never inside it. `ensureScheduleToppedUp` imports `db` directly (`schedule-topup-logic.ts:11`)
and takes no connection, so a call inside the transaction would write on a second connection
while the club lock is held. `list_meetings` runs it on the same terms, so the tools see the
calendar the browser sees.

Each entry is matched to meetings by its club-local date:

- **No meeting on that date: `create`.**
  - `time` and `location` default from `club_meeting_recurrence` (`time_of_day`, `location`). `time` is required when the club has no rule.
  - The meeting is inserted through `insertMeetingWithSlots` with the club's standard role definitions, as `applyBatchCreateMeetings` does.
  - Logged as `meeting_create`.
- **One meeting on that date: `update`.**
  - The plan shows a field diff, e.g. `theme: — → "Harvest"`. Only fields present in the input change.
  - **`applyMeetingUpdate` is a full REPLACE** (`meetings-logic.ts:205-221`: `theme:
    input.theme?.trim() || null`, and the same line for `location`, `joinUrl`,
    `wordOfTheDay`, `wodDefinition`, `wodExample`, `notes`, `reminders`; `scheduledAt` is
    required). Sending only a theme would therefore CLEAR a meeting's Word of the Day, join
    link and notes. The planner already reads each meeting to build its diff, so it echoes
    every field it is not changing, using `MeetingMetaEcho` in `src/lib/meeting-meta-update.ts`
    — the same echo the `/me/theme` editor uses. A test asserts that an update which sets
    only a theme leaves the other meta fields intact. The root-cause fix (a patch writer
    where `undefined` means unchanged) is issue #772, deliberately not in these PRs.
  - A locked meeting is blocking.
  - Logged as `meeting_edit`.
- **More than one meeting on that date:** blocking, `AMBIGUOUS_DATE`. The unique index covers the exact instant, not the date.

**Weekday check:** each plan line carries its weekday. When the club has a rule and a date's weekday differs from the rule's, the line gets a `weekday_mismatch` warning. It is not blocking, because a special meeting on another day is legitimate.

**Meeting numbers are not set.** The plan shows the derived number, labelled provisional; numbers freeze when a meeting is completed (#358).

**Field lengths** over `MEETING_FIELDS` are rejected, not truncated.

### D7 — `record_guest_book`

**Input:** `clubId`, `meetingDate`, `entries: [{name, preferredName?, email?, phone?}]` (at most 100), and `resolve?: {[entryIndex]: guestId | "new"}`.

**One meeting per call.** The paper book records no dates; the maintainer says which meeting a page belongs to.

- The server resolves `meetingDate` to the meeting. The plan header reads "Meeting #56 · Wed Sep 10 · <theme>", so a wrong date is visible.
- No meeting on that date, or more than one, is blocking.
- `assertAttendanceRecordable` applies: a future meeting returns `NOT_RECORDABLE`.

**Matching** is one exported function in `guest-pipeline-logic.ts`, `matchGuest(candidates, {name, email, phone})`, extracted from `findGuestByContact`. The rule is unchanged: email first, then phone only when `namesAgree`.

**The candidate set is loaded once per call.** `findGuestByContact` queries per lookup, which
suits the public path's single guest at the door; a 100-entry page would be ~200 round trips
in the preview and again inside the locked transaction. The batch path loads the club's guests
once and runs the same comparison rules over that set, so matching logic stays shared and the
locked section stays short. `captureGuestVisit` keeps its single-entry shape by loading its own
one-guest candidate set.

| outcome | when | apply does |
|---|---|---|
| `matched` | email matches, or phone matches and names agree | records attendance for the existing guest |
| `new` | no match | inserts the guest (stage `prospect`, E.164 phone) and records attendance |
| `ambiguous` | phone matches but names disagree; or the entry has no email or phone and an existing guest's name `namesAgree` with it | blocks until `resolve` gives a `guestId` or `"new"` |
| `already_present` | the matched guest already has attendance at this meeting | nothing |

**Both existing guest paths use `matchGuest`:**

- **`resolveGuestId` in `minutes-logic.ts`** calls it instead of inserting without checking. This fixes `addMinutesGuest` creating a duplicate guest for a returning visitor.
- **`captureGuestVisit`** calls it too, so the public path shares one rule by construction, and its existing tests must stay green.

The name-only `ambiguous` arm applies to MCP planning only. The public path keeps treating an entry with no contact details as new.

**The plan also reports:**

- **Minutes recipients.** How many entries will be default recipients of this meeting's minutes email, meaning guests present with an email. Nothing tracks whether minutes were already sent; the maintainer transcribes before sending them.
- **Possible repeat.** When every entry is `already_present`, the plan says the page was probably already transcribed.

**Not affected:** this tool never changes a guest's stage. The public guest book's 30-new-guests-per-hour throttle does not apply, since this is an authenticated admin path.

**Audit:** each apply logs one `guest_visits_record` row, `detail: {meetingId, newGuestIds, matchedGuestIds, via: "mcp"}`. The detail carries no names or contact details, because the club can read the activity feed.

### D8 — `assign_roles`

**Input:** `meetingId`, and `assignments: [{slotId, memberId} | {slotId, guestId} | {slotId, clear: true}]`, at most 100.

**Validation:**

- The club is derived from the meeting, and every `slotId` must belong to that meeting.
- `memberId` must be an active member of the club.
- `guestId` must be a guest of the club.

**Execution, by assignment kind:**

- **Member:** `reassignSlotCore`, which takes the row lock and handles the speech through `reassignSlotSpeech`. Logged as `claim` when the slot was open, otherwise `reassign`.
- **Guest:** `applyAssignGuestToSlot`, which already logs `reassign`.
- **Clear:** the `releaseSlot` path. Its database work is inline in the `slots.ts` handler today and is extracted to `releaseSlotCore` in `slots-logic.ts`. Logged as `release`.

**Locked meeting:** blocking.

**The plan names every change:** open → Sam, Alex → Sam, Alex → open. For a speaker slot with a linked speech it also says where the speech goes, e.g. "Alex's speech 'Ice Breaker' returns to Alex's unscheduled speeches".

**No speech details are accepted.** A speaker slot without a speech is the normal state after a claim, and speakers fill in their own.

### D9 — Guest contact is masked in every tool result

- Email: `jane.doe@gmail.com` → `j•••@gmail.com`.
- Phone: `+15551234567` → `•••-4567`.

That is enough to confirm a match. Full values stay in the app, and matching runs on them server-side. Tool results end up in the LLM provider's transcript, which is why they are masked. Member contact info is not returned at all.

**Masking lives in one serializer, not in each tool.** Every guest leaving the MCP layer
passes through `toMcpGuest()`, which masks the contact fields; tools call the existing
readers (`listClubGuests`, `guests-logic.ts:22`, and the member reader behind `listMembers`,
`members.ts:26`) rather than writing their own queries. A test asserts that no tool result
anywhere contains a raw email address. A rule that each tool must remember is one forgetful
diff away from leaking contact details, and this repo has shipped that shape before.

### D10 — Attribution

Every write logs through `logActivity` inside the apply transaction:

- `actorMemberId` is the token owner's membership in that club;
- `detail.via` is `"mcp"`.

`api_tokens.last_used_at` updates on each authorized call, outside the apply transaction.

### D11 — Errors and limits

A missing, unknown or revoked token gets HTTP 401 before any tool runs.

**Codes come from an `McpError` the tool layer throws**, following `IngestError`
(`pathways-ingest-logic.ts:28-36`), which carries a status beside its message. The shared
`*-logic.ts` functions throw plain `Error`s with prose (`guests-logic.ts:68` "Role not
found.", `meetings-logic.ts:198`, `:202`, `:295`), so the tool makes its own checks and
throws `McpError` with the code. **Nothing maps by message text** — a reworded message would
silently become an unhandled error. Anything else that escapes becomes `INTERNAL` with a
generic message, logged server-side and never echoed, so internal detail and any names in it
stay out of the transcript.

Every other failure is an MCP tool result with `isError: true` and one of these codes:

| code | meaning |
|---|---|
| `FORBIDDEN` | no admin membership in that club |
| `NOT_FOUND` | |
| `VALIDATION` | zod issues, with the entry index |
| `ARCHIVED` | |
| `LOCKED` | |
| `NOT_RECORDABLE` | |
| `BLOCKED` | apply called while blocking items remain |
| `PLAN_STALE` | returned with the fresh plan |
| `INTERNAL` | anything unexpected; generic message, details logged server-side only |

**Blocking-item codes.** These are not errors. They appear in a preview's `blocking` list, and apply returns `BLOCKED` while any remain:

- `NO_MEETING_ON_DATE`
- `AMBIGUOUS_DATE`
- `AMBIGUOUS_GUEST`
- `MEETING_LOCKED`
- `INVALID_PHONE`
- `FIELD_TOO_LONG`

Each item carries its entry index.

**Limits:**

- Request bodies are capped at 1 MB, checked before parsing, as in ingest.
- Entry caps are the ones given above.
- No CORS headers, because the clients are not browsers.

### D12 — Testing

- **`matchGuest`:**
  - Table tests for each outcome row in D7.
  - **CRITICAL regression**, written to fail first: `addGuestPresent` with a returning guest's email does not insert a second guest.
  - **CRITICAL regression:** `captureGuestVisit`'s public behaviour is unchanged after the extraction, including that an entry with no email or phone still creates a new guest (the name-only `ambiguous` arm is MCP-only). The existing guest-pipeline tests stay green as the other half of this.
- **`src/lib/mcp-plan.ts`** (pure, no database): the same state hashes the same; key order does not change the hash; any value change does.
- **Transport:** two sequential `tools/call` requests against one running server both succeed — the check that nobody hoisted the server or transport to module scope.
- **`upsert_agendas` echo:** an update that sets only a theme leaves `wordOfTheDay`, `wodDefinition`, `wodExample`, `joinUrl`, `location`, `notes` and `reminders` intact.
- **Planners** (integration tests, in the existing `*.integration.test.ts` style):
  - Identical input and state give an identical hash.
  - A meeting inserted on a planned date between preview and apply gives `PLAN_STALE`, and nothing is written.
  - An unresolved `ambiguous` gives `BLOCKED`, and nothing is written.
  - A write elsewhere in the club leaves the hash unchanged.
- **`authorizeToken`:**
  - A revoked token gets 401.
  - A member who is not an admin gets `FORBIDDEN`.
  - An admin of club A naming club B's meeting gets `FORBIDDEN`.
  - A superadmin with an active `read_write` impersonation session on club B and no membership there gets `FORBIDDEN`.
- **Guard `mcp-authz.guard.test.ts` — it DERIVES the tool set, it does not list it.** It walks
  `src/server/mcp/tools/`, treats every exported tool definition as a candidate, and fails any
  that calls neither `authorizeToken` nor `authenticateToken`. `whoami` sits in an explicit
  waiver map with its reason. Mutation-verify by adding a NEW non-compliant tool, not by
  breaking an enrolled one. Same shape as `actor-provenance.guard.test.ts` and
  `server-modules.guard.test.ts`, which already walk `src/server/` with `readdirSync`.
  A hand-written list cannot fail for the case it exists to catch: the tool that forgot its
  check is missing from the list too. On #544 nine readers were enrolled by hand, `getMeeting`
  sat ungated in the same file, and the guard stayed green.
- **The same guard** also asserts that `src/server/mcp/` and `src/routes/api/mcp.ts` import none
  of the cookie-reading functions listed in D3.
- **Bearer-only, tested behaviourally, not only by grep:** a request carrying a valid session
  cookie and no `Authorization` header gets 401 and writes nothing. The import grep is blind to
  a cookie that arrives through a helper or a re-export, and this is the one claim in the design
  where being wrong is a security hole.
- **End to end:** an MCP SDK client against the local dev server runs `upsert_agendas` preview → apply → `get_agenda`. The test passes on the rows read back and the agenda returned, not on a tool result that says ok.

### D13 — Connecting

```bash
claude mcp add --transport http gavelup https://<host>/api/mcp --header "Authorization: Bearer tmk_..."
```

## Open questions for `/spec`

1. ~~**Transport spike.**~~ **RESOLVED 2026-09-17, measured** — see D1. `@modelcontextprotocol/sdk@1.30.0` ships `WebStandardStreamableHTTPServerTransport` with `handleRequest(request) → Response`. What remains is ordinary implementation: confirm it behaves under the Nitro `node-server` preset, which the two-sequential-calls test in D12 covers.
2. **Future OAuth.** Better-Auth is believed to have an MCP OAuth plugin (ASSUMED, not checked). It only matters when a second user arrives; recorded here so D2's table does not rule that path out.
3. **Public guest-book race.** D5's advisory lock does not cover `submitGuestBook`. Decide between two options:
   - `captureGuestVisit` takes the same lock. That is one line, but it touches the public path.
   - The transaction-scoped re-plan is enough for a tool only the maintainer uses.
4. **ADR.** Decide whether a bearer-authenticated write surface warrants an ADR next to ADR-0004 (magic link). Probably yes, once a second user connects.

## D14 — Three PRs, not one

The endpoint, the token, the plan mechanism and a refactor of the public guest-book path are
four new concepts. They ship in this order so the risky half lands in a diff small enough to
read line by line, and is exercised on real data before three write tools depend on it.

| PR | Contents | Why here |
|---|---|---|
| **PR1** | `api_tokens` + migration, `/me` token UI, `/api/mcp`, `authenticateToken` / `authorizeToken`, `McpError`, `src/lib/mcp-plan.ts`, the four read tools, `toMcpGuest`, `matchGuest` (+ the two CRITICAL regressions), `record_guest_book`, `mcp-authz.guard.test.ts` | All the risk (auth, CSRF posture, plan hash) plus the one tool that proves the preview→apply loop on real data |
| **PR2** | `upsert_agendas`, the `MeetingMetaEcho` echo, the top-up rule, `meeting_create` logging | The workflow you most want, on a proven base |
| **PR3** | `assign_roles`, `releaseSlotCore` extraction | Touches `slots-logic.ts`, which nothing else in this plan does |

## NOT in scope

Deferred deliberately; each has its reason.

| Item | Why not |
|---|---|
| OAuth on `/api/mcp` | Only needed when a second person connects. The token table and the two authz entry points leave room for it. |
| `applyMeetingMetaPatch` (the root-cause fix for full-replace) | Issue #772. Touches a writer every caller shares, needs its own test pass, and the echo makes PR2 safe without it. |
| Non-admin member tools ("claim Timer for me") | Every tool requires admin or an officer term; a member surface is a different permission model. |
| Superadmin reach into clubs the token owner is not a member of | D3. Onboarding stays in the browser. |
| Per-token scopes and expiry | Revocation is the kill switch for one user. |
| Speech details on assignment, and scheduling an existing draft | D8. `rescheduleSpeech` is a different operation and would be a fourth write tool. |
| Agenda row text, notes, reminders (`meeting-agenda-edit`) | A separate editing surface with its own rules. |
| Tracking whether minutes were sent | D7. The maintainer transcribes before sending. |
| A general REST API | Two surfaces for one consumer. |
| Rate limiting beyond the entry caps | One authenticated admin caller; the public throttles stay where they are. |

## What already exists (and is reused, not rebuilt)

See the "Already done — do not rebuild" table above for the full list. The review confirmed
each item is reused rather than reimplemented:

- The bearer-token route shape, hashed-token table, batch insert, meeting writer, schedule
  top-up, guest dedupe, past-meeting attendance, slot reassignment with speech disposition,
  meeting lock, officer-as-admin, and the audit log are all existing code the tools call.
- **Rebuilt on purpose:** nothing. The two new mechanisms — the plan hash and the token —
  have no existing equivalent (`sync_tokens` is club-scoped and accepted only by the ingest
  route).
- **Extracted, not duplicated:** `matchGuest` out of `findGuestByContact`, and
  `releaseSlotCore` out of the `slots.ts` handler.

## Failure modes

| Codepath | A realistic production failure | Test | Error handling | What you would see |
|---|---|---|---|---|
| `/api/mcp` route | Transport hoisted to module scope; second call throws | D12 two-call test | SDK throws; mapped to `INTERNAL` | A tool call failing with a transport error, after the first worked |
| `authorizeToken` | Token inherits a browser impersonation session | D12 impersonation case | `FORBIDDEN` | Nothing: the reach never existed |
| Bearer-only posture | A refactor reintroduces a cookie read | D12 cookie-no-token test + import grep | 401 | Nothing |
| `upsert_agendas` update | Echo forgotten; a meeting's Word of the Day is cleared | D12 echo test | None at runtime — a cleared field looks like an empty field | **Silent.** The test is the only defence, which is why it is required |
| `mcp-plan` hash | An unstable field in the plan | property tests | `PLAN_STALE` on every apply | Applies that never succeed, looking like a race |
| `record_guest_book` apply | Public guest-book write lands mid-transaction | advisory lock + re-plan | `PLAN_STALE` | A refused apply and a fresh preview |
| `matchGuest` | A returning guest duplicated | CRITICAL regression test | None at runtime | **Silent** without the test: two guest rows, visit counts split |
| `assign_roles` | A replaced speaker's speech is orphaned | `reassignSlotCore` tests | Handled by `reassignSlotSpeech` | The speech back in the speaker's unscheduled pool |
| Top-up | Called inside the apply transaction | — (rule, stated in D6) | None | A second connection writing under the lock |

**Critical gaps (no test AND no runtime error AND silent):** zero, once the D12 list is
implemented. Two would exist without it: the meta-field wipe and the duplicate guest.

## Parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| PR1 endpoint + auth + plan module | `src/routes/api/`, `src/server/mcp/`, `src/lib/`, `src/db/`, `drizzle/` | — |
| PR1 token UI | `src/routes/_authed/me.tsx`, `src/server/` | the `api_tokens` migration |
| PR1 `matchGuest` + `record_guest_book` | `src/server/guest-pipeline-logic.ts`, `minutes-logic.ts`, `src/server/mcp/tools/` | the plan module |
| PR2 `upsert_agendas` | `src/server/batch-meetings-logic.ts`, `meetings-logic.ts`, `src/server/mcp/tools/` | PR1 |
| PR3 `assign_roles` | `src/server/slots-logic.ts`, `slots.ts`, `src/server/mcp/tools/` | PR1 |

- **Lane A:** PR1 endpoint + auth + plan module → PR1 token UI (sequential; shared migration).
- **Lane B:** `matchGuest` + its two regressions (independent of the endpoint; pure matching
  plus two existing callers).
- Then PR2 and PR3 **in parallel** — they touch disjoint modules (`meetings-logic` versus
  `slots-logic`).
- **Conflict flag:** all three PRs add files under `src/server/mcp/tools/` and register them
  in one place. Keep the registry a directory walk rather than a hand-edited list, and the
  merge conflicts disappear along with the guard-test problem.

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific finding above.

- [ ] **T1 (P1, human: ~1h / CC: ~10min)** — `upsert_agendas` — echo meta fields instead of clearing them
  - Surfaced by: Architecture issue 1 — `meetings-logic.ts:205-221` full REPLACE
  - Files: `src/server/mcp/tools/upsert-agendas.ts`, `src/lib/meeting-meta-update.ts`
  - Verify: test that setting only a theme leaves WOD, join link, notes intact
- [ ] **T2 (P1, human: ~30min / CC: ~5min)** — `/api/mcp` — fresh server + transport per request
  - Surfaced by: Architecture issue 2 — `webStandardStreamableHttp.js:168-174`
  - Files: `src/routes/api/mcp.ts`
  - Verify: two sequential `tools/call` requests against one process both succeed
- [ ] **T3 (P2, human: ~1h / CC: ~10min)** — auth — split `authenticateToken` / `authorizeToken`
  - Surfaced by: Architecture issue 3 — `whoami` has no `clubId`
  - Files: `src/server/mcp/authz-logic.ts`, `src/server/mcp/tools/whoami.ts`
  - Verify: guard test passes with `whoami` waived by name, no other waivers
- [ ] **T4 (P2, human: ~30min / CC: ~5min)** — top-up — call before planning, never inside the transaction
  - Surfaced by: Architecture issue 4 — `schedule-topup-logic.ts:11` imports `db` directly
  - Files: `src/server/mcp/tools/upsert-agendas.ts`, `src/server/mcp/tools/list-meetings.ts`
  - Verify: apply path contains no `ensureScheduleToppedUp` call (guard grep)
- [ ] **T5 (P2, human: ~2h / CC: ~15min)** — errors — `McpError` at the tool boundary
  - Surfaced by: Code quality issue 5 — shared modules throw prose
  - Files: `src/server/mcp/errors.ts`, all tool handlers
  - Verify: unknown error becomes `INTERNAL` with no internal message in the result
- [ ] **T6 (P2, human: ~2h / CC: ~15min)** — reads — one guest serializer, reuse existing readers
  - Surfaced by: Code quality issue 6 — no reader named, masking unplaced
  - Files: `src/server/mcp/serialize.ts`, `src/server/mcp/tools/find-people.ts`
  - Verify: test asserting no raw email appears in any tool result
- [ ] **T7 (P2, human: ~2h / CC: ~15min)** — plan — one pure `src/lib/mcp-plan.ts`
  - Surfaced by: Code quality issue 7 — three tools, one prose rule
  - Files: `src/lib/mcp-plan.ts`, `src/lib/mcp-plan.test.ts`
  - Verify: property tests for stability, key order, value change
- [ ] **T8 (P1, human: ~3h / CC: ~20min)** — guard — derive the tool set
  - Surfaced by: Test issue 8 — prior learning `an-allowlist-guard-reproduces-the-bug-it-guards`
  - Files: `src/server/mcp/mcp-authz.guard.test.ts`
  - Verify: adding a new non-compliant tool fails the guard
- [ ] **T9 (P1, human: ~2h / CC: ~15min)** — route — behavioural bearer-only test
  - Surfaced by: Test issue 9 — grep stands in for behaviour
  - Files: `src/routes/api/mcp.bearer-only.test.ts`
  - Verify: session cookie, no token → 401, no writes
- [ ] **T10 (P1, human: ~2h / CC: ~15min)** — `matchGuest` — two CRITICAL regressions
  - Surfaced by: Test review, regression rule
  - Files: `src/server/guest-pipeline-logic.ts`, `src/server/minutes-logic.ts`, their tests
  - Verify: red first — returning guest via `addGuestPresent` creates no duplicate
- [ ] **T11 (P2, human: ~3h / CC: ~20min)** — `record_guest_book` — load candidates once
  - Surfaced by: Performance issue 10 — ~200 round trips per page
  - Files: `src/server/guest-pipeline-logic.ts`, `src/server/mcp/tools/record-guest-book.ts`
  - Verify: one guest query per preview and per apply
- [ ] **T12 (P3, human: ~30min / CC: ~5min)** — lock — `lockClub()` with `hashtext(club_id)`
  - Surfaced by: Performance issue 11 — lock key underivable from a uuid
  - Files: `src/server/mcp/lock.ts`
  - Verify: two concurrent applies on one club serialize

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | codex, `/plan-eng-review` | Independent 2nd opinion | 1 | disabled | none — `codex_reviews` disabled |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 11 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** codex, plan-review phase, `outside_status: disabled` (the user's
  `codex_reviews` setting). No outside model read this plan; the native review is the only pass.
- **VERDICT:** ENG CLEARED — ready to implement. Scope reduced to three PRs (D14). CEO and
  design reviews not run and not required for a backend-only change.

NO UNRESOLVED DECISIONS
