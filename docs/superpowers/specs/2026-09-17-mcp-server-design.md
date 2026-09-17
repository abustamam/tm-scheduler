# MCP server — design

**Issue:** #771
**Depends on:** ADR-0004 (magic-link auth), ADR-0005 (role_slots source of truth), ADR-0009 (speeches first-class), ADR-0012 (meeting lock), ADR-0014 (minutes record), ADR-0018 (guest pipeline), ADR-0020 (superadmin impersonation), ADR-0021 (read-triggered schedule top-up)
**Status:** brainstormed and grilled with the maintainer 2026-09-17. Pending maintainer review of this document, then `/spec`.

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

**ASSUMED:** the current `@modelcontextprotocol/sdk` ships a web-standard (`Request`/`Response`) Streamable HTTP server transport that runs inside a TanStack Start server handler. A spike confirms it before `/spec` (open question 1).

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

Every tool call runs `authorizeToken(rawToken, clubId)` in `src/server/mcp/authz-logic.ts`:

1. The token resolves to an `api_tokens` row that is not revoked.
2. `getMembership(userId, clubId)` returns a membership with status `active`.
3. That membership has `clubRole === "admin"`, or an open officer term.
4. `assertNotArchived` passes.

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

Each write tool has a planner, `planX(input, conn)`, that returns canonical JSON:

- keys sorted and entries in input order;
- no timestamps;
- existing rows referenced by id, new rows by input index.

A plan contains **only the rows it would touch**, so a write elsewhere in the club does not make it stale.

`planHash = sha256(canonical({tool, clubId, userId, plan}))`. It detects drift and is not a credential; every call is authorized on its own.

**Without `planHash`,** the tool plans and returns `{plan, planHash, blocking: [...]}`. Nothing is written.

**With `planHash`,** the tool works in one transaction:

1. Take `pg_advisory_xact_lock` keyed on the club.
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

Each entry is matched to meetings by its club-local date:

- **No meeting on that date: `create`.**
  - `time` and `location` default from `club_meeting_recurrence` (`time_of_day`, `location`). `time` is required when the club has no rule.
  - The meeting is inserted through `insertMeetingWithSlots` with the club's standard role definitions, as `applyBatchCreateMeetings` does.
  - Logged as `meeting_create`.
- **One meeting on that date: `update`.**
  - The plan shows a field diff, e.g. `theme: — → "Harvest"`. Only fields present in the input change.
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

**Matching** is one exported function in `guest-pipeline-logic.ts`, `matchGuest(conn, clubId, {name, email, phone})`, extracted from `findGuestByContact`. The rule is unchanged: email first, then phone only when `namesAgree`.

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

### D10 — Attribution

Every write logs through `logActivity` inside the apply transaction:

- `actorMemberId` is the token owner's membership in that club;
- `detail.via` is `"mcp"`.

`api_tokens.last_used_at` updates on each authorized call, outside the apply transaction.

### D11 — Errors and limits

A missing, unknown or revoked token gets HTTP 401 before any tool runs. Every other failure is an MCP tool result with `isError: true` and one of these codes:

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
  - A regression test, written to fail first: `addGuestPresent` with a returning guest's email does not insert a second guest.
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
- **Guard `mcp-authz.guard.test.ts`:**
  - Every registered tool handler calls `authorizeToken`.
  - `src/server/mcp/` and `src/routes/api/mcp.ts` import none of the cookie-reading functions listed in D3.
- **End to end:** an MCP SDK client against the local dev server runs `upsert_agendas` preview → apply → `get_agenda`. The test passes on the rows read back and the agenda returned, not on a tool result that says ok.

### D13 — Connecting

```bash
claude mcp add --transport http gavelup https://<host>/api/mcp --header "Authorization: Bearer tmk_..."
```

## Open questions for `/spec`

1. **Transport spike.** Confirm that the SDK's web-standard Streamable HTTP transport (ASSUMED in D1) runs statelessly inside a TanStack Start server handler under the Nitro `node-server` preset. If it does not, implement JSON-RPC handling directly for the three methods used: `initialize`, `tools/list`, `tools/call`.
2. **Future OAuth.** Better-Auth is believed to have an MCP OAuth plugin (ASSUMED, not checked). It only matters when a second user arrives; recorded here so D2's table does not rule that path out.
3. **Public guest-book race.** D5's advisory lock does not cover `submitGuestBook`. Decide between two options:
   - `captureGuestVisit` takes the same lock. That is one line, but it touches the public path.
   - The transaction-scoped re-plan is enough for a tool only the maintainer uses.
4. **ADR.** Decide whether a bearer-authenticated write surface warrants an ADR next to ADR-0004 (magic link). Probably yes, once a second user connects.
