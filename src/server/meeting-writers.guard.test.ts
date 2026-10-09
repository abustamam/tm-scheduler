/**
 * Every writer of a meeting-scoped table refuses a frozen meeting by its write
 * class, and a new writer that forgets to fails here (#1139, #1129).
 *
 * `MEETING_WRITE_POLICY` (`src/lib/meeting-lifecycle.ts`) says which statuses
 * each class refuses, and #1135-#1138 moved every writer onto it. Nothing yet
 * failed when the NEXT writer did not. A hand-kept list cannot: it misses the
 * writer nobody remembered, which is how #1087, #1092 and #1104 followed #1084.
 * So the set of writers is DERIVED, from the schema and from the source, and
 * has to equal the keys of `MEETING_WRITERS` below, each classified.
 *
 * ## What is derived
 *
 * - **Swept tables:** `meetings`, every `pgTable` in `src/db/schema.ts` and
 *   `src/db/auth-schema.ts` with a `meetingId` column, and every table whose
 *   `references(() => X.id)` or `foreignColumns: [X.id]` reaches one of those,
 *   to a fixpoint. The list is pinned: a new meeting-scoped table fails with
 *   "a new meeting-scoped table: its writers are now swept; classify them".
 * - **Units:** the top-level `function` / `async function` declarations and
 *   `const X = …` bindings of every non-test `.ts` under `src/server`, exported
 *   or not, keyed `<path>#<name>`. A closure or callback belongs to its
 *   enclosing unit.
 * - **Writers:** every unit whose body runs `.insert(T)`, `.update(T)` or
 *   `.delete(T)` on a swept table `T`, whatever the receiver or the whitespace.
 * - **Fails closed, because it cannot be read:** a swept table imported under
 *   an alias or through `import * as`, and `sql` imported under an alias; a
 *   write outside any unit, or inside a class body; a write whose argument
 *   names a swept table in any shape but a bare identifier; raw SQL with
 *   `insert into`, `update … set` or `delete from` (an `sql` template, or the
 *   argument of `.execute()` / `sql.raw()`), which makes the unit a writer
 *   because its table cannot be read, so it is classified by hand; a namespace
 *   import, a dynamic `import()` or a re-export of a module that defines a
 *   writer, and `export { w as v }` of one.
 * - **Call sites:** any reference to a writer's name in another unit: a call, a
 *   callback, `.call` / `.apply`. The writer's own definition and a same-named
 *   local in a module that does not import it do not count.
 *
 * ## What it proves, and what it does not
 *
 * **Structural presence, not control flow.** The guard checks that a refusal
 * call is PRESENT in the writer (or on every path into it). It does not prove
 * the refusal runs BEFORE the write, on every branch, or against the meeting
 * the write targets. Those belong to each family's integration tests
 * (`meeting-write-policy-*.integration.test.ts`) and to review. A green guard is
 * a writer that mentions the policy, not a writer proven to obey it.
 *
 * Not handled, stated so nobody assumes it is: a local that shadows a writer's
 * name; a write through a variable holding a table (`const t = roleSlots;
 * db.insert(t)`); a write built dynamically; seeds, test helpers and
 * `scripts/`, which write these tables too and are not swept; a table
 * referenced with the typed `(): AnyPgColumn =>` form (see
 * `typedPointersIntoSwept`); and any status other than the meeting's.
 *
 * ## Two readers, chosen by what an erased character would do
 *
 * **Deriving writers** uses a string-aware comment stripper written here
 * (`lexSource`). `readSource`'s lexer does not track string literals, so a `//`
 * inside a string blanks the rest of the line and a real write after it
 * disappears: a false PASS. A fixture pins `"a//b"` followed by a write.
 *
 * **Checking refusal evidence** uses `readSource`. Erased text there can only
 * hide evidence, which fails a good writer, never passes a bad one. A helper
 * call counts only when BOTH readers see it, at the same offset.
 *
 * Call sites, entry points and module shapes are enumerations, so they read
 * through `lexSource` too. The one raw read is `hiddenWrites`, which compares
 * the file as written against what the lexer blanked, to measure the lexer's
 * one soft spot (a regex it takes for a division) on the real tree.
 *
 * ## The map
 *
 * Every writer has one entry:
 *
 * - `plan` / `record`: refuses by that class. Either its own body calls a class
 *   helper (`assertMeetingAccepts`, `meetingAcceptsWrite`, `meetingRowAccepts`
 *   with the class as a literal) or a registered wrapper of that class
 *   (`MEETING_WRITE_GATES` in `meeting-write-gate.ts`, each pinned to the helper
 *   and never passing `accept`), or it has `refusedBy` (below).
 * - `overrides`: a writer that accepts a frozen status its class refuses says
 *   so, with a reason. The statuses declared must be EXACTLY the statuses an
 *   `accept` option in its refusal can pass, read statically (a literal list, or
 *   a top-level const such as `PLAN_ACCEPTING_CANCELLED`). An `accept` in code
 *   with no override fails, and so does an override with no `accept`.
 * - `lifecycle`: cancel, complete, reopen, restore, `closeAllVotesTx` and
 *   `freezeMeetingNumber` own their transitions. A fixed list, with a reason.
 * - `exempt`: a write that is not about the meeting's plan or record (creation,
 *   club-level rows, a merge), with a reason.
 *
 * **`refusedBy` follows the chain.** The families recorded writers whose
 * refusal lives in a caller, and the callers are not always one hop away:
 * `attachSpeechToSlot` is reached through `editSlotSpeech`, which refuses
 * nothing, from `updateSpeakerDetails`, which does. So `refusedBy` names the
 * units that refuse, and the guard walks the reference graph BACKWARDS from the
 * writer, stopping at a named unit. Every path must meet one: a unit that
 * reaches the writer, has no caller of its own and is not named fails, so a new
 * caller has to refuse or be classified. Each named unit must refuse by the
 * writer's class in its own body, and must be reached; the statuses it accepts
 * count toward the writer's overrides. `exemptCallers` names the
 * callers that reach a shared writer with no refusal on purpose (a meeting
 * being created, a club-level template), each with a reason; it exists because
 * `copyTemplateForMeeting` and `copyTemplateContent` have refusing and
 * exempt callers at once, and a rule of "every caller refuses" cannot hold them.
 *
 * Every unit the walk passes through (the writer, and an intermediary that
 * refuses nothing) is held to being reachable only from its callers. A server fn
 * is an entry point whoever else calls it, so it has to refuse itself; so is a
 * unit that a module outside `src/server` (a route, a component, `src/lib`)
 * imports and mentions. A top-level statement outside any unit that mentions it,
 * and a barrel, namespace import, dynamic `import()` or alias of its module, are
 * callers no list can name, and fail, outside `src/server` as well.
 *
 * **An override can name the callers that keep its status refused.** A writer
 * that accepts a status itself (`setPlanStatus` accepts a completed meeting,
 * which its callers refuse) puts `refusedBy` and `exemptCallers` inside that
 * override. The writer must still refuse in its own body for the statuses it
 * does not accept, so deleting that call fails; each named refuser must refuse
 * THAT status by the writer's class, with options that leave it out; and the
 * same walk applies, so a new caller that refuses nothing fails.
 *
 * Wrappers are chains too (`ensureAgendaDraft` calls `resolveAgendaDraft`), so
 * every hop is registered, and a wrapper counts only if it ends in a helper.
 *
 * ## Mutation record — MEASURED, not assumed
 *
 * Each of these was injected with `bun run mutate` against this file and
 * observed red, then restored. Counts are the number of tests that failed.
 *
 *  - **A plan writer loses its refusal:** `applyAddRoleSlot` drops its
 *    `assertMeetingAccepts` (2); asks `"record"` in code (2); the map says
 *    `record` (2).
 *  - **A new caller of a `refusedBy` writer:** `clearAward` gains a caller that
 *    refuses nothing (2).
 *  - **A registered wrapper is renamed:** `assertMinutesMeetingRecordable` (3),
 *    and the first hop of the `ensureAgendaDraft` chain (3).
 *  - **A new meeting-scoped table:** `districts` gains a `meetingId` (3).
 *  - **A new writer with no entry** (2); **a raw SQL delete in a plain string**
 *    in a new unit (2).
 *  - **An override and its `accept` drift apart:** a registered wrapper starts
 *    passing `accept` (2); `PLAN_ACCEPTING_CANCELLED` also accepts completed
 *    (2); `claimSlotCore` stops passing it, so its override goes stale (2).
 *  - **The plan seam** (`setPlanStatus`, `clearPlanStatus`, which accept a
 *    completed meeting and leave it to their callers): `setPlanStatus` loses its
 *    refusal of a cancelled meeting (2); a new caller of either that refuses
 *    nothing (2 each); a named caller starts accepting completed (2); the seam's
 *    options also accept cancelled (2).
 *  - **A way past the chain's intermediaries:** a server barrel re-exporting
 *    `editSlotSpeech` (2); a module outside `src/server` importing it (1); one
 *    dynamically importing `slots-logic` (3).
 *  - **The checks themselves, switched off one at a time:** module shapes of an
 *    intermediary (3); a server fn as an entry point (3); callers outside
 *    `src/server` (2); module shapes outside `src/server` (1); a caller that
 *    accepts the overridden status counting as a refuser (1); top-level
 *    statements that mention an intermediary (1).
 */
import { readdirSync, readFileSync } from "node:fs";
import { posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { meetingStatusEnum } from "#/db/schema";
import {
	type FrozenMeetingStatus,
	MEETING_WRITE_POLICY,
	type MeetingWriteClass,
} from "#/lib/meeting-lifecycle";
import { MEETING_WRITE_GATES } from "#/server/meeting-write-gate";
import { readSource, stripComments } from "#/test/guard-source";

// ===========================================================================
// The class map
// ===========================================================================

type Override = {
	accept: true;
	reason: string;
	/**
	 * Only for a writer that refuses in its OWN body: the units that refuse this
	 * status before any path reaches it. The writer accepts the status, so who
	 * calls it is what keeps it refused, and a new caller must refuse too.
	 */
	refusedBy?: readonly string[];
	/** Callers that reach the writer on this status with no refusal on purpose, each with its reason. */
	exemptCallers?: Readonly<Record<string, string>>;
};

/** A writer that refuses by a write class. */
type ClassEntry = {
	class: MeetingWriteClass;
	/** Units that refuse before any path reaches the writer. */
	refusedBy?: readonly string[];
	/** Callers that reach the writer with no refusal on purpose, each with its reason. */
	exemptCallers?: Readonly<Record<string, string>>;
	overrides?: Partial<Record<FrozenMeetingStatus, Override>>;
};

type Entry =
	| ClassEntry
	| { class: "lifecycle"; reason: string }
	| { class: "exempt"; reason: string };

/** The reason, once, for the writers that are not about a meeting's plan or record. */
const CLUB_LEVEL_TEMPLATE =
	"Writes a club-level template row (`meeting_id is null`): the club's own agenda, not a meeting's plan. A frozen meeting has no say in it.";
const MEETING_CREATION =
	"Runs while a meeting is being created, or builds the slots of one that was just created: a meeting that does not exist yet has no status to refuse.";
const GUEST_REPOINT =
	"Moves a slot's holder between a guest and the member that guest became (or stopped being), on past meetings as well, so role history follows the person. It changes who holds the slot, not what is planned, so the meeting's status does not decide it.";
const PLAN_SEAM_COMPLETED =
	"The seam refuses a cancelled meeting itself (`PLAN_SEAM_WRITE_OPTIONS` in attendance-plan-logic.ts) and leaves a completed one to its callers, each of which refuses it ahead of its own checks so a locked meeting is refused before a subject or a session is looked at. The callers named here are the ones the guard verifies refuse it by the plan class; the exempt ones refuse it another way or are meant to reach it.";
const OUTREACH_LOCKS =
	"Refuses a completed meeting with assertMeetingNotLocked ahead of its role check, a per-status helper older than the class policy. It is not a class helper, so the guard cannot read it; a new caller that does the same has to be named here too.";

/**
 * Every writer of a swept table, classified. Keyed `<path>#<name>`; built from
 * the four families' tables (#1135 slots, #1136 agenda and templates, #1137
 * record writes, #1138 voting and lifecycle). The derivation says which keys
 * exist; this says what each is.
 */
const MEETING_WRITERS: Record<string, Entry> = {
	// -- attendance plan seam (#1137)
	"src/server/attendance-plan-logic.ts#clearPlanStatus": {
		class: "plan",
		overrides: {
			completed: {
				accept: true,
				reason: PLAN_SEAM_COMPLETED,
				refusedBy: [
					"src/server/attendance-plan.ts#clearPlannedAttendance",
					"src/server/availability.ts#clearAvailability",
				],
				exemptCallers: {
					"src/server/outreach.ts#clearContacted": OUTREACH_LOCKS,
				},
			},
		},
	},
	"src/server/attendance-plan-logic.ts#setPlanStatus": {
		class: "plan",
		overrides: {
			completed: {
				accept: true,
				reason: PLAN_SEAM_COMPLETED,
				refusedBy: [
					"src/server/attendance-plan.ts#setPlannedAttendance",
					"src/server/availability-logic.ts#releaseSlotsAndMarkUnavailable",
					"src/server/availability.ts#setAvailability",
					"src/server/slots-logic.ts#claimSlotCore",
					"src/server/slots-logic.ts#confirmSlotCore",
					"src/server/slots-logic.ts#reassignSlotCore",
				],
				exemptCallers: {
					"src/server/outreach.ts#setContacted": OUTREACH_LOCKS,
					"src/server/speeches-logic.ts#attachSpeechToOpenSlot":
						'A record write, and a completed meeting is when it is accepted: when its actor owns the speech it records them as coming through markComingOnSelfClaim. Refusing completed in the seam would answer "This meeting is locked." to a member scheduling their own speech into an open slot of a meeting main accepts it on, while an officer still can.',
				},
			},
		},
	},

	// -- availability (#1135)
	"src/server/availability-logic.ts#releaseSlotsAndMarkUnavailable": {
		class: "plan",
	},

	// -- club-level agendas: no meeting involved
	"src/server/club-agendas-logic.ts#adoptStandardAgenda": {
		class: "exempt",
		reason: CLUB_LEVEL_TEMPLATE,
	},
	"src/server/club-agendas-logic.ts#deleteClubTemplate": {
		class: "exempt",
		reason: CLUB_LEVEL_TEMPLATE,
	},
	"src/server/club-agendas-logic.ts#duplicateClubTemplate": {
		class: "exempt",
		reason: CLUB_LEVEL_TEMPLATE,
	},
	"src/server/club-agendas-logic.ts#renameClubTemplate": {
		class: "exempt",
		reason: CLUB_LEVEL_TEMPLATE,
	},
	"src/server/club-agendas-logic.ts#setClubTemplateEnabled": {
		class: "exempt",
		reason: CLUB_LEVEL_TEMPLATE,
	},

	// -- guest book and guests (#1137, #1135)
	"src/server/guest-book-apply.ts#applyGuestBookPlan": { class: "record" },
	"src/server/guest-pipeline-logic.ts#applyConvertGuestToMember": {
		class: "exempt",
		reason: GUEST_REPOINT,
	},
	"src/server/guest-pipeline-logic.ts#applyDeleteGuest": {
		class: "exempt",
		reason:
			"Deleting a guest opens the slots they held, conditionally on the guest still holding them (the race guard that keeps a slot taken for a member), on past meetings as well. A person-level change, not a plan write.",
	},
	"src/server/guest-pipeline-logic.ts#applyLinkGuestToMember": {
		class: "exempt",
		reason: GUEST_REPOINT,
	},
	"src/server/guest-pipeline-logic.ts#applyRecordGuestInvite": {
		class: "record",
	},
	"src/server/guest-pipeline-logic.ts#applyUndoGuestConversion": {
		class: "exempt",
		reason: GUEST_REPOINT,
	},
	"src/server/guest-pipeline-logic.ts#applyUnlinkGuestFromMember": {
		class: "exempt",
		reason: GUEST_REPOINT,
	},
	"src/server/guest-pipeline-logic.ts#captureInTransaction": {
		class: "record",
	},
	"src/server/guests-logic.ts#applyAssignGuestToSlot": {
		class: "plan",
		overrides: {
			cancelled: {
				accept: true,
				reason:
					'The early check passes PLAN_ACCEPTING_CANCELLED for ORDER: a blank guest name on a cancelled meeting still hears "A guest name is required.". The UPDATE\'s own meetingAcceptsWrite refuses cancelled and completed.',
			},
		},
	},

	// -- agenda and templates (#1136)
	"src/server/meeting-agenda-edit-logic.ts#addAgendaRole": { class: "plan" },
	"src/server/meeting-agenda-edit-logic.ts#addAgendaRow": { class: "plan" },
	"src/server/meeting-agenda-edit-logic.ts#bulkSetSortOrder": {
		class: "plan",
		refusedBy: [
			"src/server/meeting-agenda-edit-logic.ts#addAgendaRow",
			"src/server/meeting-agenda-edit-logic.ts#removeAgendaRole",
			"src/server/meeting-agenda-edit-logic.ts#removeAgendaRow",
			"src/server/meeting-agenda-edit-logic.ts#repositionRow",
		],
	},
	"src/server/meeting-agenda-edit-logic.ts#materialiseForMeeting": {
		class: "plan",
		overrides: {
			cancelled: {
				accept: true,
				reason:
					"First-open snapshot of the standard agenda: the editor opens a never-opened cancelled meeting read-only, so it has to materialise. MCP edit_agenda refuses first, under the meeting row lock. A status added to the policy later is in neither accept entry, so this call refuses it until someone decides.",
			},
			completed: {
				accept: true,
				reason:
					"The editor opens a never-opened past meeting read-only, and saving a completed meeting as a club template reads its agenda through here on purpose (saveInTransaction). MCP edit_agenda refuses first, under the meeting row lock.",
			},
		},
	},
	"src/server/meeting-agenda-edit-logic.ts#removeAgendaRole": {
		class: "plan",
	},
	"src/server/meeting-agenda-edit-logic.ts#removeAgendaRow": { class: "plan" },
	"src/server/meeting-agenda-edit-logic.ts#resolveAgendaDraft": {
		class: "plan",
	},
	"src/server/meeting-agenda-edit-logic.ts#updateAgendaRow": { class: "plan" },
	"src/server/meeting-templates-logic.ts#applyTemplateConversion": {
		class: "plan",
	},
	"src/server/meeting-templates-logic.ts#copyTemplateContent": {
		class: "plan",
		refusedBy: [
			"src/server/meeting-agenda-edit-logic.ts#resolveAgendaDraft",
			"src/server/meeting-templates-logic.ts#applyTemplateConversion",
		],
		exemptCallers: {
			"src/server/club-agendas-logic.ts#duplicateClubTemplate":
				"Copies one club-level template to another: no meeting.",
			"src/server/meeting-templates-logic.ts#forkLegacyPointers":
				"Forks a shared club template for the meetings that follow it when the template changes: a template edit.",
			"src/server/meeting-templates-logic.ts#saveInTransaction":
				"Saves a meeting's agenda as a NEW club-level template. It reads the meeting and writes the club's row, and a completed meeting is a legitimate source (saveInTransaction refuses cancelled by the record class).",
			"src/server/meeting-templates-logic.ts#startMeetingOnClubDefault":
				"Runs as a meeting is created.",
		},
	},
	"src/server/meeting-templates-logic.ts#copyTemplateForMeeting": {
		class: "plan",
		refusedBy: [
			"src/server/meeting-agenda-edit-logic.ts#resolveAgendaDraft",
			"src/server/meeting-templates-logic.ts#applyTemplateConversion",
		],
		exemptCallers: {
			"src/server/meeting-templates-logic.ts#forkLegacyPointers":
				"Forks a shared club template for the meetings that follow it when the template changes: a template edit.",
			"src/server/meeting-templates-logic.ts#startMeetingOnClubDefault":
				"Runs as a meeting is created.",
		},
	},
	"src/server/meeting-templates-logic.ts#forkLegacyPointers": {
		class: "exempt",
		reason:
			"Re-points the meetings that follow a club template when that template changes (callers saveInTransaction and deleteClubTemplate): a template edit, not a write to a meeting's plan.",
	},
	"src/server/meeting-templates-logic.ts#saveInTransaction": {
		class: "record",
	},
	"src/server/meeting-templates-logic.ts#startMeetingOnClubDefault": {
		class: "exempt",
		reason: MEETING_CREATION,
	},

	// -- meeting creation, numbering, lifecycle (#1138)
	"src/server/meeting-create-logic.ts#generateMeetingSlots": {
		class: "exempt",
		reason: MEETING_CREATION,
	},
	"src/server/meeting-create-logic.ts#insertMeetingWithSlots": {
		class: "exempt",
		reason: MEETING_CREATION,
	},
	"src/server/meeting-create-logic.ts#linkEvaluatorsToSpeakers": {
		class: "exempt",
		reason: MEETING_CREATION,
	},
	"src/server/meeting-number-logic.ts#freezeMeetingNumber": {
		class: "lifecycle",
		reason:
			"Stamps the meeting's number as part of completing it (applyCompleteMeeting), the one status transition that fixes it.",
	},
	"src/server/meetings-logic.ts#applyCancelMeeting": {
		class: "lifecycle",
		reason:
			"Cancel owns its own transition, and refuses by predicate in the UPDATE.",
	},
	"src/server/meetings-logic.ts#applyCompleteMeeting": {
		class: "lifecycle",
		reason:
			"Complete owns its own transition: it refuses a cancelled meeting itself, and closes the open votes (closeAllVotesTx).",
	},
	"src/server/meetings-logic.ts#applyCreateMeeting": {
		class: "exempt",
		reason: MEETING_CREATION,
	},
	"src/server/meetings-logic.ts#applyMeetingDigitalVoting": {
		class: "plan",
		overrides: {
			completed: {
				accept: true,
				reason:
					"The switch on a completed meeting only changes what is shown: it opens nothing, since completing closed every vote. VoteCounterPanel (the tally and the confirm-winner control) renders only while the switch is on, so refusing would strand a tally whose switch was turned off before the meeting completed. A cancelled meeting still refuses.",
			},
		},
	},
	"src/server/meetings-logic.ts#applyReopenMeeting": {
		class: "lifecycle",
		reason:
			"Reopen owns its own transition: it is the one write that needs a completed meeting.",
	},
	"src/server/meetings-logic.ts#applyRestoreMeeting": {
		class: "lifecycle",
		reason:
			"Restore owns its own transition: it is the one write that needs a cancelled meeting.",
	},
	"src/server/meetings-logic.ts#updateMeetingUnlessCancelled": {
		class: "plan",
		overrides: {
			completed: {
				accept: true,
				reason:
					"The meta writers (title, theme, word of the day, notes) have never refused a completed meeting: their resolvers and the planner do, and agenda-cancelled-meeting.integration.test.ts pins that applyMeetingMetaPatch itself still writes one (AC4, #1088). The cancelled refusal is in the UPDATE's WHERE, so it holds against a concurrent cancel.",
			},
		},
	},

	// -- member removal, merge, recurrence
	"src/server/members-logic.ts#applyMemberRemove": {
		class: "exempt",
		reason:
			"Releases a removed member's slots on future meetings, a cancelled one included on purpose (#1057): a slot held by someone who left has to open up. It filters by date, not by status. A follow-up for the completed-earlier-today case is #1154.",
	},
	"src/server/members-logic.ts#applySetMemberStatus": {
		class: "exempt",
		reason:
			"Releases an inactivated member's slots on future meetings, a cancelled one included on purpose (#1057). It filters by date, not by status.",
	},
	"src/server/membership-collapse-logic.ts#collapseMemberships": {
		class: "exempt",
		reason:
			"A person merge re-points or deletes the absorbed membership's rows (attendance, plan, awards, votes, slots, timings, feedback, in raw SQL as well) across every meeting, completed and cancelled ones too. The merge follows the person, not the meeting.",
	},
	"src/server/recurrence-rule-logic.ts#reconcileEmptyShells": {
		class: "exempt",
		reason:
			"Deletes only pristine empty `scheduled` shells when the recurrence rule changes: it filters on status and refuses any meeting with content, so a frozen meeting is never a candidate.",
	},

	// -- minutes, attendance and the record (#1137): refused in minutes.ts by assertMinutesMeetingRecordable
	"src/server/minutes-logic.ts#addGuestPresent": {
		class: "record",
		refusedBy: ["src/server/minutes.ts#addMinutesGuest"],
	},
	"src/server/minutes-logic.ts#addTableTopicsSpeaker": {
		class: "record",
		refusedBy: ["src/server/minutes.ts#addTableTopics"],
	},
	"src/server/minutes-logic.ts#clearAward": {
		class: "record",
		refusedBy: ["src/server/minutes.ts#clearMinutesAward"],
	},
	"src/server/minutes-logic.ts#moveTableTopicsSpeaker": {
		class: "record",
		refusedBy: ["src/server/minutes.ts#moveTableTopics"],
	},
	"src/server/minutes-logic.ts#removeGuestPresent": {
		class: "record",
		refusedBy: ["src/server/minutes.ts#removeMinutesGuest"],
	},
	"src/server/minutes-logic.ts#removeTableTopicsSpeaker": {
		class: "record",
		refusedBy: ["src/server/minutes.ts#removeTableTopics"],
	},
	"src/server/minutes-logic.ts#setAward": {
		class: "record",
		refusedBy: ["src/server/minutes.ts#setMinutesAward"],
	},
	"src/server/minutes-logic.ts#setMemberPresence": {
		class: "record",
		refusedBy: ["src/server/minutes.ts#setAttendance"],
	},

	// -- role feedback (#1137)
	"src/server/role-feedback-logic.ts#deleteMyFeedbackNote": {
		class: "exempt",
		reason:
			"A recipient throws away a note they were given, on any meeting that has ended, archived clubs included: a takedown stops new notes, not a person discarding one.",
	},
	"src/server/role-feedback-logic.ts#leaveFeedbackUnmapped": {
		class: "record",
	},
	"src/server/role-feedback-logic.ts#markMyFeedbackSeen": {
		class: "exempt",
		reason:
			"A recipient marks a note they were given as seen: their own state, not a write about the meeting.",
	},

	// -- slots (#1135)
	"src/server/slots-logic.ts#applyAddRoleSlot": { class: "plan" },
	"src/server/slots-logic.ts#applyAddSpeakerSlot": { class: "plan" },
	"src/server/slots-logic.ts#applyMoveSlot": { class: "plan" },
	"src/server/slots-logic.ts#applyRemoveRoleSlot": { class: "plan" },
	"src/server/slots-logic.ts#applyRemoveSpeakerSlot": { class: "plan" },
	"src/server/slots-logic.ts#attachSpeechToSlot": {
		class: "plan",
		refusedBy: [
			"src/server/slots-logic.ts#claimSlotCore",
			"src/server/slots.ts#updateSpeakerDetails",
		],
		overrides: {
			cancelled: {
				accept: true,
				reason:
					"Only claimSlotCore's early check accepts cancelled (PLAN_ACCEPTING_CANCELLED, for order), and its UPDATE's meetingAcceptsWrite refuses it before the speech is attached.",
			},
		},
	},
	"src/server/slots-logic.ts#backfillMissingRoleSlots": {
		class: "plan",
		overrides: {
			cancelled: {
				accept: true,
				reason:
					"The `template_sync` label deliberately covers cancelled meetings (documented at applyTemplateSyncToUpcomingMeetings, pinned by slot-writers-lock). `role_enabled` skips one that was cancelled while it waited.",
			},
		},
	},
	"src/server/slots-logic.ts#claimSlotCore": {
		class: "plan",
		overrides: {
			cancelled: {
				accept: true,
				reason:
					'The early check passes PLAN_ACCEPTING_CANCELLED for ORDER: an asserted caller who is not the Toastmaster hears SIGN_IN_REQUIRED on a cancelled meeting, not "cancelled". The UPDATE\'s meetingAcceptsWrite refuses both statuses.',
			},
		},
	},
	"src/server/slots-logic.ts#confirmSlotCore": { class: "plan" },
	"src/server/slots-logic.ts#realignEvaluatorPairs": {
		class: "plan",
		refusedBy: [
			"src/server/slots-logic.ts#applyAddSpeakerSlot",
			"src/server/slots-logic.ts#applyMoveSlot",
			"src/server/slots-logic.ts#applyRemoveSpeakerSlot",
		],
	},
	"src/server/slots-logic.ts#reassignSlotCore": { class: "plan" },
	"src/server/slots-logic.ts#releaseSlotCore": { class: "plan" },
	"src/server/slots-logic.ts#removeOpenRoleSlots": { class: "plan" },
	"src/server/slots-logic.ts#unlinkSlotSpeech": {
		class: "plan",
		refusedBy: [
			"src/server/slots-logic.ts#reassignSlotCore",
			"src/server/slots.ts#updateSpeakerDetails",
		],
	},
	"src/server/slots.ts#unconfirmSlot": {
		class: "plan",
		overrides: {
			cancelled: {
				accept: true,
				reason:
					"The first call hands cancelled to the second, after the role gate, so an outsider is told they lack the role (cancelled-meeting-officer-writes). The second call refuses it.",
			},
		},
	},
	"src/server/speeches-logic.ts#attachSpeechToOpenSlot": {
		class: "record",
		overrides: {
			cancelled: {
				accept: true,
				reason:
					"Its unlink of the speech's SOURCE slot accepts a cancelled meeting: moving a speech out of one is the documented move. The slot being written is refused by the record call.",
			},
		},
	},

	// -- timings (#1137)
	"src/server/timings-logic.ts#recordMeetingTiming": { class: "record" },

	// -- voting (#1138)
	"src/server/voting-logic.ts#castAnonymousVote": {
		class: "plan",
		refusedBy: ["src/server/voting-logic.ts#castVote"],
	},
	"src/server/voting-logic.ts#castVote": { class: "plan" },
	"src/server/voting-logic.ts#closeAllVotesTx": {
		class: "lifecycle",
		reason:
			"Called by applyCompleteMeeting and applyMeetingDigitalVoting: completing a meeting closes every open vote, so it has to write to a meeting that is being frozen.",
	},
	"src/server/voting-logic.ts#closeClubVotesTx": {
		class: "exempt",
		reason:
			"A club-wide setting change closes every open vote session of the club in the same transaction; the meetings' statuses do not decide it.",
	},
	"src/server/voting-logic.ts#closeVote": { class: "plan" },
	"src/server/voting-logic.ts#disqualifyCandidate": { class: "plan" },
	"src/server/voting-logic.ts#joinInTransaction": { class: "plan" },
	"src/server/voting-logic.ts#openVote": { class: "plan" },
	"src/server/voting-logic.ts#undoDisqualification": { class: "plan" },
};
// ===========================================================================
// 1. Reading source: two readers, chosen by what an erased character would do
// ===========================================================================

/** A `sql`-tagged template literal's static text, each `${…}` shown as `?`. */
interface SqlTemplate {
	start: number;
	end: number;
	text: string;
}

interface Lexed {
	/** Comments blanked; strings, templates and regex literals intact. */
	code: string;
	/** `code` with string, regex and template-static text blanked too: structure only. */
	skeleton: string;
	sqlTemplates: SqlTemplate[];
}

/**
 * The STRING-AWARE reader that derivation uses. One left-to-right pass that
 * knows `'…'`, `"…"`, template literals (with their `${…}` code, recursively)
 * and regex literals, so a `//` inside a string is text, not a comment.
 *
 * Both outputs are the same length as the input and keep every newline, so an
 * offset found in one is the offset in the other and in `readSource`'s text.
 *
 * Why this is not `readSource`: its lexer does not track strings, so a `//`
 * inside one blanks the rest of the line, and a real write after
 * `"a//b"` would vanish. Deriving writers is an offender sweep, where erased
 * text is a false PASS. The regex-vs-division call is a heuristic (the previous
 * significant token); a wrong call is line-local, because a regex literal and
 * an unterminated string both stop at the newline, and
 * `the lexer hides no write` below measures the real tree for it.
 */
function lexSource(src: string): Lexed {
	const n = src.length;
	const code = src.split("");
	const skel = src.split("");
	const sqlTemplates: SqlTemplate[] = [];
	let i = 0;

	const blank = (arr: string[], from: number, to: number) => {
		for (let k = from; k < to; k++) if (arr[k] !== "\n") arr[k] = " ";
	};
	const blankComment = (from: number, to: number) => {
		blank(code, from, to);
		blank(skel, from, to);
	};
	const regexAllowed = (): boolean => {
		let k = i - 1;
		while (k >= 0 && /\s/.test(code[k] as string)) k--;
		if (k < 0) return true;
		const ch = code[k] as string;
		if (/[\w$]/.test(ch)) {
			let s = k;
			while (s >= 0 && /[\w$]/.test(code[s] as string)) s--;
			const word = code.slice(s + 1, k + 1).join("");
			return /^(?:return|typeof|case|throw|in|of|delete|void|new|else|do|yield|await)$/.test(
				word,
			);
		}
		return !/[)\]}"'`]/.test(ch);
	};
	const scanString = (quote: string) => {
		const start = i;
		i++;
		while (i < n && src[i] !== quote && src[i] !== "\n") {
			if (src[i] === "\\") i++;
			i++;
		}
		const closed = src[i] === quote;
		if (closed) i++;
		blank(skel, start + 1, closed ? i - 1 : i);
	};
	const scanRegex = () => {
		const start = i;
		i++;
		let inClass = false;
		while (i < n && src[i] !== "\n") {
			const c = src[i] as string;
			if (c === "\\") {
				i += 2;
				continue;
			}
			if (c === "[") inClass = true;
			else if (c === "]") inClass = false;
			else if (c === "/" && !inClass) break;
			i++;
		}
		if (src[i] === "/") {
			i++;
			while (/[a-z]/.test(src[i] ?? "")) i++;
		}
		blank(skel, start + 1, i);
	};
	const scanTemplate = () => {
		const start = i;
		const tag = code.slice(Math.max(0, start - 40), start).join("");
		const isSql = /\bsql\s*(?:<[^`\n]*>)?\s*$/.test(tag);
		i++;
		let segStart = i;
		let text = "";
		while (i < n) {
			const c = src[i] as string;
			if (c === "\\") {
				i += 2;
				continue;
			}
			if (c === "`") {
				blank(skel, segStart, i);
				text += src.slice(segStart, i);
				i++;
				break;
			}
			if (c === "$" && src[i + 1] === "{") {
				blank(skel, segStart, i);
				text += `${src.slice(segStart, i)}?`;
				i += 2;
				scanCode(true);
				segStart = i;
				continue;
			}
			i++;
		}
		if (isSql) sqlTemplates.push({ start, end: i, text });
	};
	const scanCode = (untilCloseBrace: boolean) => {
		let depth = 0;
		while (i < n) {
			const c = src[i] as string;
			const d = src[i + 1];
			if (c === "/" && d === "/") {
				const s = i;
				while (i < n && src[i] !== "\n") i++;
				blankComment(s, i);
				continue;
			}
			if (c === "/" && d === "*") {
				const s = i;
				const e = src.indexOf("*/", i + 2);
				i = e === -1 ? n : e + 2;
				blankComment(s, i);
				continue;
			}
			if (c === '"' || c === "'") {
				scanString(c);
				continue;
			}
			if (c === "`") {
				scanTemplate();
				continue;
			}
			if (c === "/") {
				if (regexAllowed()) scanRegex();
				else i++;
				continue;
			}
			if (c === "{") depth++;
			else if (c === "}") {
				if (untilCloseBrace && depth === 0) {
					i++;
					return;
				}
				depth--;
			}
			i++;
		}
	};
	scanCode(false);
	return { code: code.join(""), skeleton: skel.join(""), sqlTemplates };
}

// ===========================================================================
// 2. Statements, units, imports
// ===========================================================================

interface Statement {
	start: number;
	end: number;
	kind: "function" | "const" | "other";
	name?: string;
}

const FN_RE =
	/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b\s*\*?\s*([A-Za-z_$][\w$]*)/;
const CONST_RE = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/;

/**
 * Top-level statements: a line at brace depth 0 whose first column holds
 * something that is not a closer (`}`, `)`, `]`, or the `>` that ends a
 * multi-line type-parameter list). Depth is counted on the SKELETON, so a brace
 * in a string, a regex or a template's text never moves it. A statement runs to
 * the next such line, which is the repo's own slicer's rule
 * (`TOP_LEVEL_BOUNDARY`) made depth-aware.
 */
function splitStatements(skel: string): Statement[] {
	const starts: number[] = [];
	let depth = 0;
	let lineStart = 0;
	for (;;) {
		const ch = skel[lineStart];
		if (depth === 0 && ch !== undefined && /[^\s})\]>]/.test(ch)) {
			starts.push(lineStart);
		}
		const nl = skel.indexOf("\n", lineStart);
		const lineEnd = nl === -1 ? skel.length : nl;
		for (let k = lineStart; k < lineEnd; k++) {
			const c = skel[k];
			if (c === "{" || c === "(" || c === "[") depth++;
			else if (c === "}" || c === ")" || c === "]") depth--;
		}
		if (nl === -1) break;
		lineStart = nl + 1;
	}
	return starts.map((start, idx): Statement => {
		const end = starts[idx + 1] ?? skel.length;
		const head = skel.slice(start, Math.min(end, start + 300));
		const fn = FN_RE.exec(head);
		if (fn) return { start, end, kind: "function", name: fn[1] as string };
		const cn = CONST_RE.exec(head);
		if (cn) return { start, end, kind: "const", name: cn[1] as string };
		return { start, end, kind: "other" };
	});
}

/** Open minus close brackets over the whole skeleton: nonzero means the lexer lost its place. */
function bracketBalance(skel: string): number {
	let d = 0;
	for (const c of skel) {
		if (c === "{" || c === "(" || c === "[") d++;
		else if (c === "}" || c === ")" || c === "]") d--;
	}
	return d;
}

/** How every unit is keyed, in the map, the registry and the walk: `<path>#<name>`. */
const unitKey = (path: string, name: string): string => `${path}#${name}`;

/** The inverse of {@link unitKey}. */
function splitKey(key: string): [path: string, name: string] {
	const at = key.indexOf("#");
	return [key.slice(0, at), key.slice(at + 1)];
}

/** A top-level `function` or `const`/`let`/`var`, keyed by {@link unitKey}. */
interface Unit {
	key: string;
	file: string;
	name: string;
	kind: "function" | "const";
	/** More than one range when a name is declared twice (overloads). */
	ranges: [number, number][];
}

interface Binding {
	imported: string;
	local: string;
}
interface ImportDecl {
	spec: string;
	named: Binding[];
	namespace?: string;
}
interface ExportFrom {
	spec: string;
	names: Binding[];
	star: boolean;
}

interface Model {
	path: string;
	lexed: Lexed;
	/** The `readSource` text: comments blanked, strings as written. */
	evidence: string;
	statements: Statement[];
	units: Map<string, Unit>;
	imports: ImportDecl[];
	exportsFrom: ExportFrom[];
	/** `export { a as b }` with no `from`. */
	aliasExports: Binding[];
	dynamicImports: string[];
}

function parseBindings(list: string): Binding[] {
	const out: Binding[] = [];
	for (const part of list.split(",")) {
		const m =
			/^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(
				part,
			);
		if (m)
			out.push({ imported: m[1] as string, local: m[2] ?? (m[1] as string) });
	}
	return out;
}

/** `evidence` is `readSource(path)`'s text for a real file; fixtures take the default. */
function buildModel(
	path: string,
	raw: string,
	evidence: string = stripComments(raw),
): Model {
	if (evidence.length !== raw.length) {
		throw new Error(
			`${path}: readSource changed the length; offsets no longer line up`,
		);
	}
	const lexed = lexSource(raw);
	const statements = splitStatements(lexed.skeleton);
	const units = new Map<string, Unit>();
	for (const st of statements) {
		if (st.kind === "other") continue;
		const key = unitKey(path, st.name as string);
		const unit = units.get(key);
		if (unit) unit.ranges.push([st.start, st.end]);
		else {
			units.set(key, {
				key,
				file: path,
				name: st.name as string,
				kind: st.kind,
				ranges: [[st.start, st.end]],
			});
		}
	}
	const imports: ImportDecl[] = [];
	const exportsFrom: ExportFrom[] = [];
	const aliasExports: Binding[] = [];
	for (const st of statements) {
		if (st.kind !== "other") continue;
		const text = lexed.code.slice(st.start, st.end);
		if (/^import\s/.test(text)) {
			const m =
				/^import\s+(?:type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']/.exec(text);
			if (!m) continue;
			const clause = m[1] as string;
			const decl: ImportDecl = { spec: m[2] as string, named: [] };
			const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
			if (ns) decl.namespace = ns[1];
			const braces = /\{([\s\S]*)\}/.exec(clause);
			if (braces) decl.named = parseBindings(braces[1] as string);
			const def = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
			if (def)
				decl.named.push({ imported: "default", local: def[1] as string });
			imports.push(decl);
		} else if (/^export\s/.test(text)) {
			const named =
				/^export\s+(?:type\s+)?\{([\s\S]*?)\}\s*(?:from\s*["']([^"']+)["'])?/.exec(
					text,
				);
			if (named) {
				const names = parseBindings(named[1] as string);
				if (named[2]) exportsFrom.push({ spec: named[2], names, star: false });
				else
					for (const b of names)
						if (b.imported !== b.local) aliasExports.push(b);
				continue;
			}
			const star =
				/^export\s+\*(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*from\s*["']([^"']+)["']/.exec(
					text,
				);
			if (star)
				exportsFrom.push({ spec: star[1] as string, names: [], star: true });
		}
	}
	const dynamicImports: string[] = [];
	for (const m of lexed.code.matchAll(
		/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
	)) {
		if (lexed.skeleton.startsWith("import", m.index)) {
			dynamicImports.push(m[1] as string);
		}
	}
	return {
		path,
		lexed,
		evidence,
		statements,
		units,
		imports,
		exportsFrom,
		aliasExports,
		dynamicImports,
	};
}

const skelOf = (m: Model, u: Unit): string =>
	u.ranges.map(([a, b]) => m.lexed.skeleton.slice(a, b)).join("\n");
const evidOf = (m: Model, u: Unit): string =>
	u.ranges.map(([a, b]) => m.evidence.slice(a, b)).join("\n");

/** `#/x`, `@/x` and relative specifiers, to a repo-relative path in `known`; else null. */
function resolveSpecifier(
	fromPath: string,
	spec: string,
	known: ReadonlySet<string>,
): string | null {
	let base: string;
	if (spec.startsWith("#/") || spec.startsWith("@/")) {
		base = `src/${spec.slice(2)}`;
	} else if (spec.startsWith(".")) {
		base = posix.normalize(posix.join(posix.dirname(fromPath), spec));
	} else return null;
	for (const c of [`${base}.ts`, `${base}/index.ts`, base]) {
		if (known.has(c)) return c;
	}
	return null;
}

// ===========================================================================
// 3. The swept tables, derived from the schema
// ===========================================================================

interface TableDecl {
	name: string;
	hasMeetingId: boolean;
	/** Tables referenced with `references(() => X.id)` or `foreignColumns: [X.id]`. */
	refs: string[];
	/** Tables referenced with the typed `references((): AnyPgColumn => X.id)`. */
	typedRefs: string[];
}

function parseTables(src: string): TableDecl[] {
	const lexed = lexSource(src);
	const out: TableDecl[] = [];
	for (const st of splitStatements(lexed.skeleton)) {
		if (st.kind !== "const") continue;
		const skel = lexed.skeleton.slice(st.start, st.end);
		if (!/^(?:export\s+)?const\s+[\w$]+\s*=\s*pgTable\s*\(/.test(skel))
			continue;
		const code = lexed.code.slice(st.start, st.end);
		const refs = new Set<string>();
		for (const m of skel.matchAll(
			/\.references\(\s*\(\)\s*=>\s*([A-Za-z_$][\w$]*)\.id\b/g,
		)) {
			refs.add(m[1] as string);
		}
		for (const m of skel.matchAll(
			/foreignColumns\s*:\s*\[\s*([A-Za-z_$][\w$]*)\.id\s*\]/g,
		)) {
			refs.add(m[1] as string);
		}
		const typed = new Set<string>();
		for (const m of skel.matchAll(
			/\.references\(\s*\(\)\s*:\s*AnyPgColumn\s*=>\s*([A-Za-z_$][\w$]*)\.id\b/g,
		)) {
			typed.add(m[1] as string);
		}
		out.push({
			name: st.name as string,
			hasMeetingId:
				/\bmeetingId\s*:/.test(skel) || /["']meeting_id["']/.test(code),
			refs: [...refs],
			typedRefs: [...typed],
		});
	}
	return out;
}

/** `meetings`, every table with a `meetingId`, and every table that reaches one, to a fixpoint. */
function sweptTables(tables: TableDecl[]): string[] {
	const swept = new Set<string>(["meetings"]);
	for (const t of tables) if (t.hasMeetingId) swept.add(t.name);
	for (let changed = true; changed; ) {
		changed = false;
		for (const t of tables) {
			if (!swept.has(t.name) && t.refs.some((r) => swept.has(r))) {
				swept.add(t.name);
				changed = true;
			}
		}
	}
	return [...swept].sort();
}

/**
 * Tables NOT swept that point at a swept table with the typed form. That form
 * is how a cycle is written (`clubs.defaultTemplateId`), and counting it would
 * sweep `clubs` and with it every table in the database, so it is not followed;
 * the list is pinned instead, so a NEW one (a child table written with the
 * typed form to dodge a circular type) is a decision and not a silent miss.
 */
function typedPointersIntoSwept(
	tables: TableDecl[],
	swept: ReadonlySet<string>,
): string[] {
	return tables
		.filter((t) => !swept.has(t.name))
		.flatMap((t) =>
			t.typedRefs.filter((r) => swept.has(r)).map((r) => `${t.name} -> ${r}`),
		)
		.sort();
}

// ===========================================================================
// 4. Writers
// ===========================================================================

interface WriteSite {
	op: "insert" | "update" | "delete" | "sql";
	table: string;
}

const WRITE_CALL = /\.\s*(insert|update|delete)\s*\(/g;
const RAW_SQL_WRITE =
	/\binsert\s+into\b|\bdelete\s+from\b|\bupdate\s+(?:only\s+)?[\w"?.]+(?:\s+(?:as\s+)?\w+)?\s+set\b/i;

/** The text inside the bracket at `open`, and where it closes; null when unbalanced. */
function balanced(
	skel: string,
	open: number,
): { inner: string; close: number } | null {
	let depth = 0;
	for (let k = open; k < skel.length; k++) {
		const c = skel[k];
		if (c === "(" || c === "{" || c === "[") depth++;
		else if (c === ")" || c === "}" || c === "]") {
			depth--;
			if (depth === 0) return { inner: skel.slice(open + 1, k), close: k };
		}
	}
	return null;
}

/** `.insert(T)`, `.update(T)`, `.delete(T)` on a swept `T`; and the shapes that name one but cannot be read. */
function writesIn(
	skel: string,
	swept: ReadonlySet<string>,
): { sites: WriteSite[]; unreadable: string[] } {
	const sites: WriteSite[] = [];
	const unreadable: string[] = [];
	for (const m of skel.matchAll(WRITE_CALL)) {
		const open = (m.index as number) + m[0].length - 1;
		const bal = balanced(skel, open);
		if (!bal) continue;
		const arg = bal.inner.trim();
		const bare = /^(?:[A-Za-z_$][\w$]*\s*\.\s*)*([A-Za-z_$][\w$]*)$/.exec(arg);
		if (bare) {
			if (swept.has(bare[1] as string)) {
				sites.push({ op: m[1] as WriteSite["op"], table: bare[1] as string });
			}
			continue;
		}
		const named = [...swept].filter((t) =>
			new RegExp(`(?<![.\\w$])${t}(?![\\w$])`).test(arg),
		);
		if (named.length > 0) {
			unreadable.push(
				`.${m[1]}(${arg.replace(/\s+/g, " ").slice(0, 60)}) names ${named.join(", ")} in a shape the guard cannot read`,
			);
		}
	}
	return { sites, unreadable };
}

/**
 * A raw SQL write in `[from, to)`: an `sql`-tagged template with one in it, or
 * an argument to `.execute(…)` / `sql.raw(…)` (a template or a plain string)
 * that reads as one. The table is not knowable from text, so a unit with one is
 * a writer to be classified by hand.
 */
function hasRawSqlWrite(m: Model, from: number, to: number): boolean {
	if (
		m.lexed.sqlTemplates.some(
			(t) => t.start >= from && t.end <= to && RAW_SQL_WRITE.test(t.text),
		)
	) {
		return true;
	}
	const skel = m.lexed.skeleton.slice(from, to);
	for (const call of skel.matchAll(/(?:\.\s*execute|\bsql\s*\.\s*raw)\s*\(/g)) {
		const open = (call.index as number) + call[0].length - 1;
		const bal = balanced(skel, open);
		if (!bal) continue;
		const text = m.lexed.code.slice(
			from + open + 1,
			from + open + 1 + bal.inner.length,
		);
		if (RAW_SQL_WRITE.test(text)) return true;
	}
	return false;
}

/** The two modules that declare tables. */
const SCHEMA_FILES: ReadonlySet<string> = new Set([
	"src/db/schema.ts",
	"src/db/auth-schema.ts",
]);

/**
 * Every unit whose body writes a swept table, and every shape that has to fail
 * closed instead of being read: an aliased table import, a namespace import of
 * the schema, a write outside any top-level unit (a class body included), a
 * write whose argument names a swept table in a shape the guard cannot read.
 * A unit with a raw `sql` write is a writer too: the table is not knowable, so
 * it must be classified by hand.
 */
function deriveWriters(
	models: Model[],
	swept: ReadonlySet<string>,
): { writers: Map<string, WriteSite[]>; failures: string[] } {
	const writers = new Map<string, WriteSite[]>();
	const failures: string[] = [];
	for (const m of models) {
		for (const imp of m.imports) {
			if (
				imp.namespace &&
				resolveSpecifier(m.path, imp.spec, SCHEMA_FILES) !== null
			) {
				failures.push(
					`${m.path}: namespace import of ${imp.spec}, which hides which table a write names`,
				);
			}
			for (const b of imp.named) {
				if (swept.has(b.imported) && b.local !== b.imported) {
					failures.push(
						`${m.path}: imports the meeting-scoped table ${b.imported} under the alias ${b.local}`,
					);
				}
			}
			for (const b of imp.named) {
				if (b.imported === "sql" && b.local !== "sql") {
					failures.push(
						`${m.path}: imports sql under the alias ${b.local}, so its templates cannot be told from any other tag`,
					);
				}
			}
		}
		for (const st of m.statements) {
			const skel = m.lexed.skeleton.slice(st.start, st.end);
			const { sites, unreadable } = writesIn(skel, swept);
			const rawSql = hasRawSqlWrite(m, st.start, st.end);
			if (st.kind !== "other") {
				const key = unitKey(m.path, st.name as string);
				for (const u of unreadable) failures.push(`${key}: ${u}`);
				if (sites.length > 0 || rawSql) {
					const all = writers.get(key) ?? [];
					all.push(...sites);
					if (rawSql) all.push({ op: "sql", table: "?" });
					writers.set(key, all);
				}
			} else if (sites.length > 0 || unreadable.length > 0 || rawSql) {
				const where =
					/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\b/.test(skel)
						? "inside a class body"
						: "outside any top-level function or const";
				failures.push(
					`${m.path}: a write ${where}: ${[
						...sites.map((s) => `${s.op}(${s.table})`),
						...unreadable,
						...(rawSql ? ["raw sql"] : []),
					].join(", ")}`,
				);
			}
		}
	}
	return { writers, failures };
}

// ===========================================================================
// 5. The world: units across files, and who references whom
// ===========================================================================

interface World {
	/** Every non-test module under `src/server`. */
	models: Model[];
	/**
	 * Modules outside `src/server` (routes, components, `src/lib`). They hold no
	 * unit the walk follows, but they reach units: a route that imports a
	 * function has a way in that no refuser in `src/server` stands in front of.
	 */
	outside: Model[];
	known: ReadonlySet<string>;
	units: Map<string, { model: Model; unit: Unit }>;
	/** Top-level consts by bare name (for options constants and class constants). */
	consts: Map<string, { model: Model; unit: Unit }[]>;
	callers: Map<string, string[]>;
	helperCache: Map<string, HelperCall[]>;
}

function buildWorld(models: Model[], outside: Model[] = []): World {
	const units = new Map<string, { model: Model; unit: Unit }>();
	const consts = new Map<string, { model: Model; unit: Unit }[]>();
	for (const model of models) {
		for (const unit of model.units.values()) {
			units.set(unit.key, { model, unit });
			if (unit.kind === "const") {
				const list = consts.get(unit.name) ?? [];
				list.push({ model, unit });
				consts.set(unit.name, list);
			}
		}
	}
	return {
		models,
		outside,
		known: new Set(models.map((m) => m.path)),
		units,
		consts,
		callers: new Map(),
		helperCache: new Map(),
	};
}

const wordRe = (name: string, flags = "g") =>
	new RegExp(`(?<![.\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`, flags);

/** The names `model` can refer to `target` by: its own name in its file, or its import bindings. */
function localNames(world: World, model: Model, target: Unit): string[] {
	if (model.path === target.file) return [target.name];
	const names: string[] = [];
	for (const imp of model.imports) {
		if (resolveSpecifier(model.path, imp.spec, world.known) !== target.file)
			continue;
		for (const b of imp.named)
			if (b.imported === target.name) names.push(b.local);
	}
	return names;
}

/**
 * Does `unit` (in `model`) reference `target`: any mention of its name, which
 * is a call, a value passed as a callback, or `.call` / `.apply`. With
 * `callOnly` it must be `name(` AND `readSource` must show the name there too,
 * which is the stricter reading evidence of a refusal takes.
 */
function references(
	world: World,
	model: Model,
	unit: Unit,
	target: Unit,
	callOnly = false,
): boolean {
	if (unit.key === target.key) return false;
	const names = localNames(world, model, target);
	if (names.length === 0) return false;
	const skel = skelOf(model, unit);
	const evid = callOnly ? evidOf(model, unit) : "";
	for (const name of names) {
		for (const hit of skel.matchAll(wordRe(name))) {
			if (!callOnly) return true;
			const at = hit.index as number;
			if (
				/^\s*\(/.test(skel.slice(at + name.length)) &&
				evid.startsWith(name, at)
			) {
				return true;
			}
		}
	}
	return false;
}

/** Units, in any file, that reference `key`, other than `key` itself. */
function callersOf(world: World, key: string): string[] {
	const cached = world.callers.get(key);
	if (cached) return cached;
	const target = world.units.get(key);
	const out: string[] = [];
	if (target) {
		for (const model of world.models) {
			for (const unit of model.units.values()) {
				if (references(world, model, unit, target.unit)) out.push(unit.key);
			}
		}
	}
	world.callers.set(key, out);
	return out;
}

const IMPORT_STATEMENT = /^import\s[\s\S]*?\bfrom\s*["'][^"']*["']\s*;?/gm;

/**
 * Files outside `src/server` that import `key` and mention it. Read from the
 * comment-stripped code with the import statements removed, strings kept, so
 * this over-approximates: a mention in a string counts. A wrong answer here
 * demands a decision about an entry point, it never waives one.
 */
function outsideCallersOf(world: World, key: string): string[] {
	const target = world.units.get(key);
	if (!target) return [];
	const out: string[] = [];
	for (const model of world.outside) {
		const names = localNames(world, model, target.unit);
		if (names.length === 0) continue;
		const code = model.lexed.code.replace(IMPORT_STATEMENT, "");
		if (names.some((name) => wordRe(name).test(code))) out.push(model.path);
	}
	return out;
}

/** `export const x = createServerFn(…)`: callable over the wire with no caller in front of it. */
function isServerFn(world: World, key: string): boolean {
	const found = world.units.get(key);
	return (
		found !== undefined &&
		found.unit.kind === "const" &&
		/^(?:export\s+)?const\s+[\w$]+\s*(?::[^=]+)?=\s*createServerFn\b/.test(
			skelOf(found.model, found.unit),
		)
	);
}

const NON_CALLING_STATEMENT =
	/^(?:import\b|export\s+(?:type\s+)?\{|export\s+\*|(?:export\s+)?(?:type|interface)\b)/;

/**
 * A reference to a writer from a top-level statement that is not a unit (an
 * expression statement, a class): it has no key, so no caller list can name it.
 */
function strayReferences(world: World, writerKeys: Iterable<string>): string[] {
	const failures: string[] = [];
	for (const key of writerKeys) {
		const target = world.units.get(key);
		if (!target) continue;
		for (const model of world.models) {
			const names = localNames(world, model, target.unit);
			if (names.length === 0) continue;
			for (const st of model.statements) {
				if (st.kind !== "other") continue;
				const skel = model.lexed.skeleton.slice(st.start, st.end);
				if (NON_CALLING_STATEMENT.test(skel)) continue;
				if (names.some((name) => wordRe(name).test(skel))) {
					failures.push(
						`${model.path}: a top-level statement outside any function or const references ${key}, a meeting writer or a unit on the way to one`,
					);
				}
			}
		}
	}
	return failures;
}

/**
 * Ways a unit the guard follows (a writer, or an intermediary on the way to
 * one) can be reached that a name search in a unit would not see: `import * as
 * x` of its module, a dynamic `import()` of it, a re-export of it (`export { w }
 * from`, `export * from`), and an `export { w as v }`. Checked in every module,
 * outside `src/server` as well: a barrel there is a way in.
 */
function moduleShapeFailures(world: World, keys: Iterable<string>): string[] {
	const followedFiles = new Map<string, Set<string>>();
	for (const key of keys) {
		const [file, name] = splitKey(key);
		const set = followedFiles.get(file) ?? new Set<string>();
		set.add(name);
		followedFiles.set(file, set);
	}
	const failures: string[] = [];
	for (const m of [...world.models, ...world.outside]) {
		for (const imp of m.imports) {
			const target = resolveSpecifier(m.path, imp.spec, world.known);
			const names = target ? followedFiles.get(target) : undefined;
			if (imp.namespace && names) {
				failures.push(
					`${m.path}: namespace import of ${imp.spec}, which defines ${[...names].join(", ")}, a meeting writer or a unit on the way to one; a call through it is not seen. Import the names.`,
				);
			}
		}
		for (const spec of m.dynamicImports) {
			const target = resolveSpecifier(m.path, spec, world.known);
			const names = target ? followedFiles.get(target) : undefined;
			if (names) {
				failures.push(
					`${m.path}: dynamic import() of ${spec}, which defines ${[...names].join(", ")}, a meeting writer or a unit on the way to one; a call through it is not seen.`,
				);
			}
		}
		for (const ex of m.exportsFrom) {
			const target = resolveSpecifier(m.path, ex.spec, world.known);
			const names = target ? followedFiles.get(target) : undefined;
			if (!names) continue;
			const hit = ex.star
				? [...names]
				: ex.names.filter((b) => names.has(b.imported)).map((b) => b.imported);
			if (hit.length > 0) {
				failures.push(
					`${m.path}: re-exports ${hit.join(", ")} from ${ex.spec}, a meeting writer or a unit on the way to one; a caller of the re-export is not seen.`,
				);
			}
		}
		const own = followedFiles.get(m.path);
		for (const b of m.aliasExports) {
			if (own?.has(b.imported)) {
				failures.push(
					`${m.path}: exports ${b.imported} as ${b.local}, a meeting writer or a unit on the way to one; a caller of the alias is not seen.`,
				);
			}
		}
	}
	return failures;
}

// ===========================================================================
// 6. Refusal evidence: the class helpers, their options, and registered wrappers
// ===========================================================================

const HELPERS = {
	assertMeetingAccepts: { classArg: 1, optionsArg: 2 },
	meetingAcceptsWrite: { classArg: 1, optionsArg: 3 },
	meetingRowAccepts: { classArg: 0, optionsArg: 1 },
} as const;
type HelperName = keyof typeof HELPERS;

interface HelperCall {
	helper: HelperName;
	/** `"plan"`, `"record"`, or null when the argument is neither a literal nor a same-file constant of one. */
	cls: string | null;
	/** The options argument's source, or null when the call has none. */
	options: string | null;
}

/** Split the arguments of the call whose `(` is at `open` in `skel`, reading each from `text`. */
function splitArgs(skel: string, text: string, open: number): string[] | null {
	const bal = balanced(skel, open);
	if (!bal) return null;
	const out: string[] = [];
	let depth = 0;
	let from = open + 1;
	for (let k = open + 1; k < bal.close; k++) {
		const c = skel[k];
		if (c === "(" || c === "{" || c === "[") depth++;
		else if (c === ")" || c === "}" || c === "]") depth--;
		else if (c === "," && depth === 0) {
			out.push(text.slice(from, k).trim());
			from = k + 1;
		}
	}
	const last = text.slice(from, bal.close).trim();
	if (last !== "") out.push(last);
	return out;
}

/**
 * The class a helper call asks for: a `"plan"` / `"record"` literal, or a bare
 * identifier naming a same-file top-level const initialised with one (as
 * `guest-book-recordable.ts` does, so its two calls cannot disagree).
 */
function resolveClass(model: Model, text: string): string | null {
	const lit = /^["'`](plan|record)["'`]$/.exec(text);
	if (lit) return lit[1] as string;
	if (!/^[A-Za-z_$][\w$]*$/.test(text)) return null;
	const unit = model.units.get(unitKey(model.path, text));
	if (!unit || unit.kind !== "const") return null;
	const init = /=\s*["'`](plan|record)["'`]\s*;/.exec(evidOf(model, unit));
	return init ? (init[1] as string) : null;
}

/**
 * Class-helper calls in a unit. FOUND in the skeleton (no comment, no string
 * contents, so a call in either never counts) and READ from `readSource`'s text
 * at the same offsets, so a name that `readSource` erased is no evidence. Both
 * readers have to agree before a call counts: an error in either can hide
 * evidence, which fails a good writer, and cannot invent it.
 */
function helperCallsOf(world: World, model: Model, unit: Unit): HelperCall[] {
	const cached = world.helperCache.get(unit.key);
	if (cached) return cached;
	const skel = skelOf(model, unit);
	const evid = evidOf(model, unit);
	const out: HelperCall[] = [];
	const re = new RegExp(
		`(?<![.\\w$])(${Object.keys(HELPERS).join("|")})\\s*\\(`,
		"g",
	);
	for (const m of skel.matchAll(re)) {
		const idx = m.index as number;
		const name = m[1] as HelperName;
		if (!evid.startsWith(name, idx)) continue;
		if (/\bfunction\s*\*?\s*$/.test(skel.slice(Math.max(0, idx - 12), idx)))
			continue;
		const args = splitArgs(skel, evid, idx + m[0].length - 1);
		if (!args) continue;
		const { classArg, optionsArg } = HELPERS[name];
		out.push({
			helper: name,
			cls: resolveClass(model, args[classArg] ?? ""),
			options: args[optionsArg] ?? null,
		});
	}
	world.helperCache.set(unit.key, out);
	return out;
}

/** The statuses a write class can refuse: every status but the one a meeting starts in. */
const FROZEN: readonly FrozenMeetingStatus[] =
	meetingStatusEnum.enumValues.filter(
		(s): s is FrozenMeetingStatus => s !== "scheduled",
	);

/**
 * The statuses a helper call's options can accept, read statically, with
 * whatever could not be read. An `accept: [...]` list of string literals is
 * read where it stands; a top-level const in the options expression (the call
 * passes `PLAN_ACCEPTING_CANCELLED`, spreads it, or picks it in a conditional)
 * is read where it is defined. The union is the over-approximation on purpose:
 * an override has to be declared for every status ANY branch could accept.
 */
function acceptedBy(
	world: World,
	options: string | null,
	seen: Set<string> = new Set(),
): { statuses: Set<string>; problems: string[] } {
	const statuses = new Set<string>();
	const problems: string[] = [];
	if (options === null) return { statuses, problems };
	// `accept` is looked for in the skeleton, so one inside a string (a message,
	// a type argument) is not an option, and its list is read from the real text
	// at the same offsets.
	const skel = lexSource(options).skeleton;
	for (const m of skel.matchAll(/\baccept\b(\s*:\s*\[([^\]]*)\])?/g)) {
		if (m[1] === undefined) {
			problems.push("`accept` that is not a literal list of statuses");
			continue;
		}
		const from = (m.index as number) + m[0].indexOf("[") + 1;
		const list = options.slice(from, from + (m[2] as string).length);
		for (const el of list
			.split(",")
			.map((e) => e.trim())
			.filter(Boolean)) {
			const lit = new RegExp(`^["'](${FROZEN.join("|")})["']$`).exec(el);
			if (lit) statuses.add(lit[1] as string);
			else problems.push(`accept element ${el}`);
		}
	}
	const bare = /^[A-Za-z_$][\w$]*$/.test(options.trim());
	// Identifiers in CODE position: not inside a string, not a property access,
	// and not an object key (`{ messages: … }`), which only looks like a name.
	const ids = new Set<string>();
	for (const m of skel.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*/g)) {
		const at = m.index as number;
		const before = skel.slice(0, at);
		const isProperty = /\.$/.test(before) && !/\.\.\.$/.test(before);
		const isKey =
			/[{,]\s*$/.test(before) && /^\s*:/.test(skel.slice(at + m[0].length));
		if (!isProperty && !isKey) ids.add(m[0]);
	}
	for (const id of ids) {
		const defs = world.consts.get(id);
		if (!defs) {
			if (bare)
				problems.push(
					`options \`${id}\` is not a top-level const the guard can read`,
				);
			continue;
		}
		for (const d of defs) {
			if (seen.has(d.unit.key)) continue;
			seen.add(d.unit.key);
			const inner = acceptedBy(world, evidOf(d.model, d.unit), seen);
			for (const s of inner.statuses) statuses.add(s);
			problems.push(...inner.problems);
		}
	}
	for (const m of skel.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)) {
		if (!world.consts.has(m[1] as string)) {
			problems.push(`a spread of \`${m[1]}\`, which is not a top-level const`);
		}
	}
	return { statuses, problems };
}

/**
 * Every status any class-helper call in `unit` accepts, whatever its class,
 * and what could not be read.
 */
function acceptsIn(
	world: World,
	unitKey: string,
): { statuses: Set<string>; problems: string[] } {
	const statuses = new Set<string>();
	const problems: string[] = [];
	const found = world.units.get(unitKey);
	if (!found) return { statuses, problems };
	for (const call of helperCallsOf(world, found.model, found.unit)) {
		const one = acceptedBy(world, call.options);
		for (const s of one.statuses) statuses.add(s);
		problems.push(...one.problems);
	}
	return { statuses, problems };
}

type Gates = Readonly<Record<string, MeetingWriteClass>>;

/**
 * The registered wrappers that END in a class helper of their class: either a
 * body that calls the helper with its class, or one that calls an already
 * grounded wrapper of the same class. A fixpoint, so two wrappers that only
 * call each other ground nothing.
 */
function groundedGates(world: World, gates: Gates): Set<string> {
	const grounded = new Set<string>();
	for (let changed = true; changed; ) {
		changed = false;
		for (const [key, cls] of Object.entries(gates)) {
			if (grounded.has(key)) continue;
			const found = world.units.get(key);
			if (!found) continue;
			if (refusesIn(world, grounded, gates, found.model, found.unit, cls)) {
				grounded.add(key);
				changed = true;
			}
		}
	}
	return grounded;
}

/** Does `unit` call a class helper of `cls`, or a grounded registered wrapper of `cls`? */
function refusesIn(
	world: World,
	grounded: ReadonlySet<string>,
	gates: Gates,
	model: Model,
	unit: Unit,
	cls: string,
): boolean {
	if (helperCallsOf(world, model, unit).some((c) => c.cls === cls)) return true;
	for (const [gkey, gcls] of Object.entries(gates)) {
		if (gcls !== cls || !grounded.has(gkey)) continue;
		const gate = world.units.get(gkey);
		if (gate && references(world, model, unit, gate.unit, true)) return true;
	}
	return false;
}

// ===========================================================================
// 7. The rules
// ===========================================================================

const LIFECYCLE_UNITS: readonly string[] = [
	"src/server/meetings-logic.ts#applyCancelMeeting",
	"src/server/meetings-logic.ts#applyCompleteMeeting",
	"src/server/meetings-logic.ts#applyReopenMeeting",
	"src/server/meetings-logic.ts#applyRestoreMeeting",
	"src/server/voting-logic.ts#closeAllVotesTx",
	"src/server/meeting-number-logic.ts#freezeMeetingNumber",
];

/** Registered wrappers: pinned to the helper, and never carrying an `accept`. */
function gateFailures(world: World, gates: Gates): string[] {
	const failures: string[] = [];
	const grounded = groundedGates(world, gates);
	for (const key of Object.keys(gates)) {
		if (!world.units.has(key)) {
			failures.push(
				`MEETING_WRITE_GATES: ${key} names no top-level function or const. Renamed or removed? Re-point the registry.`,
			);
			continue;
		}
		if (!grounded.has(key)) {
			failures.push(
				`MEETING_WRITE_GATES: ${key} does not end in assertMeetingAccepts / meetingAcceptsWrite / meetingRowAccepts for class "${gates[key]}", directly or through another registered wrapper of that class.`,
			);
		}
		const { statuses, problems } = acceptsIn(world, key);
		if (statuses.size > 0 || problems.length > 0) {
			failures.push(
				`MEETING_WRITE_GATES: ${key} passes accept (${[...statuses, ...problems].join("; ")}). A wrapper may not: an override belongs to the writer that declares it, so none can hide in a shared wrapper.`,
			);
		}
	}
	return failures;
}

function nonEmpty(s: unknown): boolean {
	return typeof s === "string" && s.trim().length > 0;
}

/**
 * Ways into `at` that nothing in `src/server` stands in front of: it is a
 * server fn (callable over the wire), or a module outside `src/server` (a
 * route, a component) imports it.
 */
function entryPointFailures(world: World, key: string, at: string): string[] {
	const failures: string[] = [];
	if (isServerFn(world, at)) {
		failures.push(
			`${key}: ${at}${at === key ? "" : " is on the way to it and"} is a server fn, callable directly with no caller in front of it, so it has to refuse itself`,
		);
	}
	for (const file of outsideCallersOf(world, at)) {
		failures.push(
			`${key}: ${file}, outside src/server, reaches ${at}${at === key ? "" : " on the way to it"}, and nothing in src/server is in front of it`,
		);
	}
	return failures;
}

/**
 * Every call path to `key` must meet a unit named in `listed` before it runs
 * out. The guard walks the reference graph BACKWARDS from the writer and stops
 * at a named unit. Every unit it walks THROUGH (the writer, and an intermediary
 * that refuses nothing) is held to being reachable only from its callers:
 *
 * - a unit with no caller of its own that is not named has an unguarded way in;
 * - a server fn, or a unit a module outside `src/server` imports, has one too,
 *   whoever else calls it;
 * - a top-level statement outside any unit that mentions it, and a barrel,
 *   namespace import, dynamic `import()` or alias of its module, are callers no
 *   caller list can name.
 */
function coverageFailures(
	world: World,
	key: string,
	listed: ReadonlySet<string>,
): string[] {
	const failures: string[] = [];
	const reached = new Set<string>();
	const stack = [key];
	while (stack.length > 0) {
		const at = stack.pop() as string;
		failures.push(...entryPointFailures(world, key, at));
		// The writer's own module shapes are checked once, for every writer.
		if (at !== key) {
			failures.push(
				...strayReferences(world, [at]),
				...moduleShapeFailures(world, [at]),
			);
		}
		for (const caller of callersOf(world, at)) {
			if (reached.has(caller) || caller === key) continue;
			reached.add(caller);
			if (listed.has(caller)) continue;
			if (callersOf(world, caller).length === 0) {
				failures.push(
					`${key}: ${caller} reaches it${at === key ? "" : ` through ${at}`} and is neither a refuser nor an exempt caller named in the entry. A new caller has to refuse, or be classified here.`,
				);
			} else stack.push(caller);
		}
	}
	for (const l of listed) {
		if (!reached.has(l)) {
			failures.push(
				`${key}: ${l} is listed as a refuser or an exempt caller but nothing reaches the writer through it. Stale, or reached only behind another listed unit.`,
			);
		}
	}
	return failures;
}

/**
 * Does `unit` refuse `status` by `cls`: a class-helper call of that class whose
 * options do not accept the status, or a grounded registered wrapper of it
 * (a wrapper never passes accept). A helper with options the guard cannot read
 * is no evidence.
 */
function refusesStatusIn(
	world: World,
	grounded: ReadonlySet<string>,
	gates: Gates,
	model: Model,
	unit: Unit,
	cls: string,
	status: string,
): boolean {
	for (const call of helperCallsOf(world, model, unit)) {
		if (call.cls !== cls) continue;
		const { statuses, problems } = acceptedBy(world, call.options);
		if (problems.length === 0 && !statuses.has(status)) return true;
	}
	for (const [gkey, gcls] of Object.entries(gates)) {
		if (gcls !== cls || !grounded.has(gkey)) continue;
		const gate = world.units.get(gkey);
		if (gate && references(world, model, unit, gate.unit, true)) return true;
	}
	return false;
}

/**
 * An override that names the callers keeping its status refused (`refusedBy`,
 * `exemptCallers`): the writer accepts the status itself, so every path to it
 * must meet a unit that refuses that status, or an exempt caller with a reason.
 * It needs a refusal of the writer's own for the statuses it does not accept,
 * and so cannot be combined with an entry that has none.
 */
function delegatedOverrideFailures(
	world: World,
	gates: Gates,
	grounded: ReadonlySet<string>,
	key: string,
	cls: string,
	status: string,
	ov: Override | undefined,
	direct: boolean,
): string[] {
	const refusedBy = ov?.refusedBy ?? [];
	const exemptCallers = ov?.exemptCallers ?? {};
	if (refusedBy.length === 0 && Object.keys(exemptCallers).length === 0) {
		return [];
	}
	const failures: string[] = [];
	const at = `${key}: overrides.${status}`;
	if (!direct) {
		failures.push(
			`${at} names callers, but the writer has no "${cls}" refusal in its own body for the statuses it does not accept`,
		);
	}
	for (const [caller, reason] of Object.entries(exemptCallers)) {
		if (!nonEmpty(reason))
			failures.push(`${at}: exemptCallers ${caller} needs a reason`);
	}
	for (const r of refusedBy) {
		const caller = world.units.get(r);
		if (!caller) {
			failures.push(
				`${at}: refusedBy ${r} names no top-level function or const`,
			);
		} else if (
			!refusesStatusIn(
				world,
				grounded,
				gates,
				caller.model,
				caller.unit,
				cls,
				status,
			)
		) {
			failures.push(
				`${at}: refusedBy ${r}, which does not refuse ${status} by "${cls}" (no helper call of that class whose options leave it out, and no registered wrapper)`,
			);
		}
	}
	failures.push(
		...coverageFailures(
			world,
			key,
			new Set([...refusedBy, ...Object.keys(exemptCallers)]),
		).map((f) => `${f} (for overrides.${status})`),
	);
	return failures;
}

function entryFailures(
	world: World,
	gates: Gates,
	grounded: ReadonlySet<string>,
	key: string,
	entry: Entry,
): string[] {
	if (entry.class === "lifecycle") {
		return [
			...(nonEmpty(entry.reason)
				? []
				: [`${key}: a lifecycle entry needs a reason`]),
			...(LIFECYCLE_UNITS.includes(key)
				? []
				: [
						`${key}: lifecycle is a fixed list (the four transitions in meetings-logic.ts, closeAllVotesTx, freezeMeetingNumber); this writer is not on it`,
					]),
		];
	}
	if (entry.class === "exempt") {
		return nonEmpty(entry.reason)
			? []
			: [`${key}: an exempt entry needs a reason`];
	}
	const failures: string[] = [];
	const found = world.units.get(key);
	if (!found) return [`${key}: no such unit`];
	const cls = entry.class;
	const refusedBy = entry.refusedBy ?? [];
	const exemptCallers = entry.exemptCallers ?? {};
	for (const [caller, reason] of Object.entries(exemptCallers)) {
		if (!nonEmpty(reason))
			failures.push(`${key}: exemptCallers ${caller} needs a reason`);
	}
	const direct = refusesIn(
		world,
		grounded,
		gates,
		found.model,
		found.unit,
		cls,
	);
	let evidenceUnits: string[];
	if (direct) {
		if (refusedBy.length > 0 || Object.keys(exemptCallers).length > 0) {
			failures.push(
				`${key}: refuses by "${cls}" in its own body, so refusedBy / exemptCallers are stale. Drop them.`,
			);
		}
		evidenceUnits = [key];
	} else {
		if (refusedBy.length === 0) {
			failures.push(
				`${key}: no "${cls}" refusal (assertMeetingAccepts / meetingAcceptsWrite / meetingRowAccepts, or a registered wrapper of that class) in its body and no refusedBy`,
			);
		}
		for (const r of refusedBy) {
			const caller = world.units.get(r);
			if (!caller) {
				failures.push(
					`${key}: refusedBy ${r} names no top-level function or const`,
				);
			} else if (
				!refusesIn(world, grounded, gates, caller.model, caller.unit, cls)
			) {
				failures.push(
					`${key}: refusedBy ${r}, whose body has no "${cls}" refusal (assertMeetingAccepts / meetingAcceptsWrite / meetingRowAccepts, or a registered wrapper of that class)`,
				);
			}
		}
		failures.push(
			...coverageFailures(
				world,
				key,
				new Set([...refusedBy, ...Object.keys(exemptCallers)]),
			),
		);
		evidenceUnits = [...refusedBy];
	}
	// Overrides: declared statuses must be exactly the statuses the code accepts.
	const declared = new Set<string>();
	for (const [status, ov] of Object.entries(entry.overrides ?? {})) {
		declared.add(status);
		if (!(FROZEN as readonly string[]).includes(status)) {
			failures.push(
				`${key}: override for ${status}, which is not a frozen meeting status`,
			);
		}
		if (!nonEmpty(ov?.reason))
			failures.push(`${key}: the ${status} override needs a reason`);
		failures.push(
			...delegatedOverrideFailures(
				world,
				gates,
				grounded,
				key,
				cls,
				status,
				ov,
				direct,
			),
		);
	}
	const accepted = new Set<string>();
	for (const unitKey of evidenceUnits) {
		const { statuses, problems } = acceptsIn(world, unitKey);
		for (const s of statuses) accepted.add(s);
		failures.push(...problems.map((p) => `${key}: ${p}`));
	}
	for (const s of accepted) {
		if (!declared.has(s)) {
			failures.push(
				`${key}: its refusal accepts ${s} (an accept option) with no override declared. Add overrides.${s} with its reason.`,
			);
		}
	}
	for (const s of declared) {
		if (!accepted.has(s)) {
			failures.push(
				`${key}: overrides.${s} is declared but no class-helper call in ${evidenceUnits.join(", ")} passes accept for it`,
			);
		}
	}
	return failures;
}

/** The derived writers against the map's keys: no missing entry, no stale one. */
function mapFailures(
	writers: ReadonlyMap<string, unknown>,
	map: Readonly<Record<string, Entry>>,
): string[] {
	const failures: string[] = [];
	for (const key of [...writers.keys()].sort()) {
		if (!(key in map)) {
			failures.push(
				`${key} writes a meeting-scoped table and has no entry in MEETING_WRITERS. Classify it: plan, record, lifecycle or exempt.`,
			);
		}
	}
	for (const key of Object.keys(map).sort()) {
		if (!writers.has(key)) {
			failures.push(
				`MEETING_WRITERS has ${key}, which no longer writes a meeting-scoped table. Stale: remove it.`,
			);
		}
	}
	return failures;
}

/**
 * Write-shaped text in `raw` that the lexer blanked and that does not sit in a
 * comment: a write inside a string or regex it swallowed, or inside code it
 * mistook for one, which the derivation would never see. Measures the lexer's
 * one soft spot (regex versus division) against the real tree.
 */
function hiddenWrites(
	m: Model,
	raw: string,
	swept: readonly string[],
): string[] {
	const re = new RegExp(
		`\\.\\s*(?:insert|update|delete)\\s*\\(\\s*(?:${swept.join("|")})\\b`,
		"g",
	);
	const hidden: string[] = [];
	for (const hit of raw.matchAll(re)) {
		const at = hit.index as number;
		if (m.lexed.skeleton.slice(at, at + hit[0].length) === hit[0]) continue;
		const before = raw.slice(raw.lastIndexOf("\n", at) + 1, at);
		if (/\/\/|\/\*|^\s*\*/.test(before)) continue;
		hidden.push(`${m.path}:${raw.slice(0, at).split("\n").length}`);
	}
	return hidden;
}

interface Inputs {
	models: Model[];
	/** Modules outside `src/server`, which reach units without being one. */
	outside?: Model[];
	swept: ReadonlySet<string>;
	map: Readonly<Record<string, Entry>>;
	gates: Gates;
}

/** Everything the guard asserts about writers, in one pass; each failure is one line. */
function allFailures(input: Inputs): string[] {
	const world = buildWorld(input.models, input.outside);
	const grounded = groundedGates(world, input.gates);
	const { writers, failures } = deriveWriters(input.models, input.swept);
	// A shared intermediary is walked once per writer behind it: say it once.
	return [
		...new Set([
			...failures,
			...moduleShapeFailures(world, writers.keys()),
			...strayReferences(world, writers.keys()),
			...mapFailures(writers, input.map),
			...gateFailures(world, input.gates),
			...Object.entries(input.map).flatMap(([key, entry]) =>
				writers.has(key)
					? entryFailures(world, input.gates, grounded, key, entry)
					: [],
			),
		]),
	];
}

// ===========================================================================
// 8. The real tree
// ===========================================================================

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(SELF, "../../..");

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = resolve(dir, e.name);
		return e.isDirectory() ? walk(p) : [p];
	});
}

/** Every non-test `.ts` under `src/server`, recursively (the MCP tools live in a subdirectory). */
function realModels(): Model[] {
	return walk(resolve(ROOT, "src/server"))
		.filter((p) => p.endsWith(".ts") && !/\.test\.tsx?$/.test(p))
		.sort()
		.map((p) => {
			const raw = readFileSync(p, "utf8");
			return buildModel(
				relative(ROOT, p).split("\\").join("/"),
				raw,
				readSource(p),
			);
		});
}

/**
 * Every non-test module under `src/` outside `src/server`. Lexed best-effort:
 * these are mostly `.tsx`, where JSX text can open a "string" the lexer ends at
 * the newline. That is harmless here, because only their imports and whether
 * they mention a name are read.
 */
function realOutsideModels(): Model[] {
	return walk(resolve(ROOT, "src"))
		.filter(
			(p) =>
				/\.tsx?$/.test(p) &&
				!/\.test\.tsx?$/.test(p) &&
				!p.startsWith(resolve(ROOT, "src/server/")),
		)
		.sort()
		.map((p) =>
			buildModel(
				relative(ROOT, p).split("\\").join("/"),
				readFileSync(p, "utf8"),
			),
		);
}

function realTables(): TableDecl[] {
	return [...SCHEMA_FILES].flatMap((f) =>
		parseTables(readFileSync(resolve(ROOT, f), "utf8")),
	);
}

// ===========================================================================
// The real tree
// ===========================================================================

/** The meeting-scoped tables today. A change means a new table's writers are swept. */
const PINNED_SWEPT_TABLES = [
	"guestInvites",
	"meetingAttendance",
	"meetingAttendancePlan",
	"meetingAwards",
	"meetingBallotGuests",
	"meetingCandidateDisqualifications",
	"meetingTemplateBeats",
	"meetingTemplateRoles",
	"meetingTemplates",
	"meetingTimings",
	"meetingVoteSessions",
	"meetingVotes",
	"meetings",
	"roleFeedbackNotes",
	"roleSlots",
	"tableTopicsSpeakers",
];

/** Back-pointers from a club or a role to a template. Neither makes the club or the role meeting-scoped. */
const PINNED_TYPED_POINTERS = [
	"clubs -> meetingTemplates",
	"roleDefinitions -> meetingTemplates",
];

describe("the meeting writers of the real tree", () => {
	const tables = realTables();
	const swept = sweptTables(tables);
	const models = realModels();
	const outside = realOutsideModels();
	const inputs: Inputs = {
		models,
		outside,
		swept: new Set(swept),
		map: MEETING_WRITERS,
		gates: MEETING_WRITE_GATES,
	};

	it("sweeps exactly the pinned meeting-scoped tables", () => {
		expect(
			swept,
			"a new meeting-scoped table: its writers are now swept; classify them in MEETING_WRITERS, then add the table to PINNED_SWEPT_TABLES",
		).toEqual(PINNED_SWEPT_TABLES);
	});

	it("follows no typed `(): AnyPgColumn =>` pointer into a swept table that is not pinned", () => {
		expect(
			typedPointersIntoSwept(tables, new Set(swept)),
			"a table points at a meeting-scoped one with the typed form, which the sweep does not follow. If it is a child of the meeting, write it with `() => X.id`; if it is a back-pointer like clubs.defaultTemplateId, pin it",
		).toEqual(PINNED_TYPED_POINTERS);
	});

	it("reads the modules outside src/server too, or the entry-point checks would pass on nothing", () => {
		expect(outside.length).toBeGreaterThan(100);
		expect(outside.every((m) => !m.path.startsWith("src/server/"))).toBe(true);
		// Routes and components are in it, and so is the lib a barrel would live in.
		expect(outside.some((m) => m.path.startsWith("src/routes/"))).toBe(true);
		expect(outside.some((m) => m.path.startsWith("src/lib/"))).toBe(true);
	});

	it("lexes every file to balanced brackets and hides no write in a string or regex", () => {
		const unbalanced = models
			.filter((m) => bracketBalance(m.lexed.skeleton) !== 0)
			.map((m) => m.path);
		expect(
			unbalanced,
			"the string-aware lexer lost its place in these files",
		).toEqual([]);
		const hidden = models.flatMap((m) =>
			hiddenWrites(m, readFileSync(resolve(ROOT, m.path), "utf8"), swept),
		);
		expect(
			hidden,
			"write-shaped text outside any comment that the lexer blanked",
		).toEqual([]);
	});

	it("derives the writers, and every one is classified with no entry stale", () => {
		const { writers } = deriveWriters(models, inputs.swept);
		// Vacuity: a derivation that found nothing would match an empty map.
		expect(writers.size).toBeGreaterThan(60);
		expect(mapFailures(writers, MEETING_WRITERS)).toEqual([]);
	});

	it("meets no shape that has to fail closed", () => {
		const world = buildWorld(models, outside);
		const { writers, failures } = deriveWriters(models, inputs.swept);
		expect([
			...failures,
			...moduleShapeFailures(world, writers.keys()),
			...strayReferences(world, writers.keys()),
		]).toEqual([]);
	});

	it("refuses by its class in every plan and record writer", () => {
		const world = buildWorld(models, outside);
		const grounded = groundedGates(world, MEETING_WRITE_GATES);
		const { writers } = deriveWriters(models, inputs.swept);
		const failures = Object.entries(MEETING_WRITERS).flatMap(([key, entry]) =>
			writers.has(key)
				? entryFailures(world, MEETING_WRITE_GATES, grounded, key, entry)
				: [],
		);
		expect(failures).toEqual([]);
	});

	it("registers only wrappers that end in the helper and pass no accept", () => {
		expect(gateFailures(buildWorld(models), MEETING_WRITE_GATES)).toEqual([]);
	});

	it("has a policy row for every meeting status, and no row for one that does not exist", () => {
		const statuses = [...meetingStatusEnum.enumValues].sort();
		for (const cls of ["plan", "record"] as const) {
			expect(
				Object.keys(MEETING_WRITE_POLICY[cls]).sort(),
				`class ${cls}`,
			).toEqual(statuses);
		}
	});

	it("passes as one: the whole rule set agrees with the parts", () => {
		expect(allFailures(inputs)).toEqual([]);
	});
});

// ===========================================================================
// The derivation, on fixture source
// ===========================================================================

const SW: ReadonlySet<string> = new Set(["meetings", "roleSlots"]);

const modelsOf = (files: Record<string, string>): Model[] =>
	Object.entries(files).map(([path, src]) => buildModel(path, src));

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

/**
 * Every guard failure for fixture files, a fixture map and a fixture registry.
 * `outside` are modules outside `src/server`: routes, components, `src/lib`.
 */
function run(
	files: Record<string, string>,
	map: Record<string, Entry> = {},
	gates: Gates = {},
	outside: Record<string, string> = {},
): string[] {
	return allFailures({
		models: modelsOf(files),
		outside: modelsOf(outside),
		swept: SW,
		map,
		gates,
	});
}

const writerKeys = (files: Record<string, string>): string[] =>
	[...deriveWriters(modelsOf(files), SW).writers.keys()].sort();

const A = "src/server/a-logic.ts";

describe("deriving the swept tables from the schema", () => {
	const schema = lines(
		'export const parent = pgTable("parent", {',
		'\tid: uuid("id").primaryKey(),',
		'\tmeetingId: uuid("meeting_id").notNull().references(() => meetings.id),',
		"});",
		'export const child = pgTable("child", {',
		'\tid: uuid("id").primaryKey(),',
		'\tparentId: uuid("parent_id").references(() => parent.id, { onDelete: "cascade" }),',
		"});",
		'export const grandchild = pgTable("grandchild", {',
		'\tid: uuid("id").primaryKey(),',
		'\tchildId: uuid("child_id").notNull(),',
		"}, (t) => [",
		'\tforeignKey({ name: "gc_fk", columns: [t.childId], foreignColumns: [child.id] }),',
		"]);",
		'export const renamed = pgTable("renamed", {',
		'\tid: uuid("id").primaryKey(),',
		'\tmeeting: uuid("meeting_id"),',
		"});",
		'export const unrelated = pgTable("unrelated", { id: uuid("id").primaryKey() });',
		'export const pointer = pgTable("pointer", {',
		'\ttemplate: uuid("t").references((): AnyPgColumn => parent.id),',
		"});",
	);

	it("sweeps a grandchild reached through a table with no meetingId of its own", () => {
		const tables = parseTables(schema);
		const swept = sweptTables(tables);
		expect(swept).toContain("grandchild");
		expect(swept).toContain("child");
		expect(swept).toContain("parent");
		// A `meeting_id` column under another TS key is still one.
		expect(swept).toContain("renamed");
		expect(swept).not.toContain("unrelated");
	});

	it("does not follow a typed `(): AnyPgColumn =>` pointer, and reports it", () => {
		const tables = parseTables(schema);
		const swept = sweptTables(tables);
		expect(swept).not.toContain("pointer");
		expect(typedPointersIntoSwept(tables, new Set(swept))).toEqual([
			"pointer -> parent",
		]);
	});

	it("sweeps an unswept table the moment it gains a meetingId", () => {
		const before = sweptTables(parseTables(schema));
		const after = sweptTables(
			parseTables(
				schema.replace(
					'export const unrelated = pgTable("unrelated", { id: uuid("id").primaryKey() });',
					'export const unrelated = pgTable("unrelated", { id: uuid("id").primaryKey(), meetingId: uuid("meeting_id") });',
				),
			),
		);
		expect(before).not.toContain("unrelated");
		expect(after).toContain("unrelated");
	});
});

describe("deriving the writers from source", () => {
	it("finds a write whose receiver and call are split across lines", () => {
		expect(
			writerKeys({
				[A]: lines(
					"export async function save(tx) {",
					"\tawait tx",
					"\t\t.insert(roleSlots)",
					"\t\t.values({});",
					"}",
				),
			}),
		).toEqual([`${A}#save`]);
	});

	it("attributes a write in a nested callback to its top-level unit", () => {
		expect(
			writerKeys({
				[A]: lines(
					"export async function outer(db, items) {",
					"\tawait Promise.all(",
					"\t\titems.map(async (i) => {",
					"\t\t\tawait db.update(meetings).set({ i });",
					"\t\t}),",
					"\t);",
					"}",
					"const helper = () => 1;",
				),
			}),
		).toEqual([`${A}#outer`]);
	});

	it('derives a write that follows `"a//b"` on the same line, which readSource would blank', () => {
		const src = lines(
			"export async function a(tx) {",
			'\tconst label = "a//b"; await tx.insert(roleSlots).values({});',
			"}",
		);
		// The reason for the string-aware reader: the repo's lexer erases it.
		expect(stripComments(src)).not.toContain(".insert(roleSlots)");
		expect(writerKeys({ [A]: src })).toEqual([`${A}#a`]);
	});

	it("keeps a template literal's embedded code and a regex literal from hiding the write after them", () => {
		const src = lines(
			"export async function a(tx, id) {",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source text, not a template
			"\tconst re = /['\"]\\//g; const t = `x // ${id + '//'} y`;",
			"\tawait tx.delete(roleSlots);",
			"}",
		);
		expect(writerKeys({ [A]: src })).toEqual([`${A}#a`]);
	});

	it("has a sweep for the lexer's one soft spot: a regex it reads as division hides the write on its line", () => {
		const src = lines(
			"export async function a(tx, x) {",
			"\tif (x) /re'/.test(x); await tx.insert(roleSlots).values({});",
			"\t// await tx.delete(roleSlots);",
			"}",
		);
		// The derivation is fooled, as it is allowed to be on a line like this...
		expect(writerKeys({ [A]: src })).toEqual([]);
		// ...and the real-tree sweep for exactly that notices, but not a comment.
		expect(hiddenWrites(buildModel(A, src), src, ["roleSlots"])).toEqual([
			`${A}:2`,
		]);
	});

	it("ignores a write that is only in a comment", () => {
		expect(
			writerKeys({
				[A]: lines(
					"export async function a(tx) {",
					"\t// await tx.insert(roleSlots).values({});",
					"\t/* tx.delete(meetings); */",
					"\treturn 1;",
					"}",
				),
			}),
		).toEqual([]);
	});

	it("ignores a write on a table that is not swept", () => {
		expect(
			writerKeys({
				[A]: "export async function a(tx) {\n\tawait tx.insert(people).values({});\n}\n",
			}),
		).toEqual([]);
	});

	it("treats a unit with a raw sql write as a writer, and a sql write outside a unit as a failure", () => {
		const inUnit = lines(
			"export async function a(tx) {",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source text, not a template
			"\tawait tx.execute(sql`delete from meeting_awards where id = ${1}`);",
			"}",
		);
		const keys = [
			...deriveWriters(modelsOf({ [A]: inUnit }), SW).writers.entries(),
		];
		expect(keys.map(([k]) => k)).toEqual([`${A}#a`]);
		expect(keys[0]?.[1]).toEqual([{ op: "sql", table: "?" }]);
		const outside = deriveWriters(
			modelsOf({ [A]: "await db.execute(sql`update x set y = 1`);\n" }),
			SW,
		);
		expect(outside.failures.join("\n")).toMatch(/outside any top-level/);
		// Not a write: `for update` is a lock, and `set_config` is not `set`.
		expect(
			writerKeys({
				[A]: "export async function a(tx) {\n\tawait tx.execute(sql`select set_config('x', '1', true) from t for update`);\n}\n",
			}),
		).toEqual([]);
	});

	it("reads a raw write passed to .execute() or sql.raw() as a string, and fails an aliased sql import", () => {
		for (const call of [
			'await tx.execute("DELETE FROM meeting_awards");',
			"await tx.execute('insert into meeting_awards values (1)');",
			'await tx.execute(sql.raw("update meeting_awards set x = 1"));',
		]) {
			expect(
				writerKeys({
					[A]: `export async function a(tx) {\n\t${call}\n}\n`,
				}),
				call,
			).toEqual([`${A}#a`]);
		}
		// A read is not a write.
		expect(
			writerKeys({
				[A]: 'export async function a(tx) {\n\tawait tx.execute("select * from meeting_awards");\n}\n',
			}),
		).toEqual([]);
		expect(
			deriveWriters(
				modelsOf({ [A]: 'import { sql as q } from "drizzle-orm";\n' }),
				SW,
			).failures.join("\n"),
		).toMatch(/imports sql under the alias q/);
	});

	it("fails closed on a write outside any unit, in a class body, or in a shape it cannot read", () => {
		const top = deriveWriters(
			modelsOf({ [A]: "await db.insert(roleSlots).values({});\n" }),
			SW,
		);
		expect(top.failures.join("\n")).toMatch(
			/outside any top-level function or const/,
		);
		const cls = deriveWriters(
			modelsOf({
				[A]: lines(
					"export class Repo {",
					"\tasync add(db) {",
					"\t\tawait db.insert(roleSlots).values({});",
					"\t}",
					"}",
				),
			}),
			SW,
		);
		expect(cls.failures.join("\n")).toMatch(/inside a class body/);
		const odd = deriveWriters(
			modelsOf({
				[A]: "export async function a(db, ok) {\n\tawait db.insert(ok ? roleSlots : other).values({});\n}\n",
			}),
			SW,
		);
		expect(odd.failures.join("\n")).toMatch(/shape the guard cannot read/);
	});

	it("fails on a swept table imported under an alias, and on a namespace import of the schema", () => {
		const aliased = deriveWriters(
			modelsOf({
				[A]: lines(
					'import { roleSlots as slots } from "#/db/schema";',
					"export async function a(tx) {",
					"\tawait tx.insert(slots).values({});",
					"}",
				),
			}),
			SW,
		);
		expect(aliased.failures.join("\n")).toMatch(/under the alias slots/);
		const ns = deriveWriters(
			modelsOf({
				[A]: lines(
					'import * as schema from "#/db/schema";',
					"export async function a(tx) {",
					"\tawait tx.insert(schema.roleSlots).values({});",
					"}",
				),
			}),
			SW,
		);
		expect(ns.failures.join("\n")).toMatch(/namespace import of #\/db\/schema/);
		// An alias for a table that is not swept is nobody's business.
		expect(
			deriveWriters(
				modelsOf({ [A]: 'import { people as p } from "#/db/schema";\n' }),
				SW,
			).failures,
		).toEqual([]);
	});
});

describe("call sites", () => {
	const writer = lines(
		"export async function writeIt(tx) {",
		"\tawait tx.update(meetings).set({});",
		"}",
		"export async function selfCall(tx) {",
		"\treturn 1;",
		"}",
	);
	const callersIn = (others: Record<string, string>): string[] => {
		const world = buildWorld(modelsOf({ [A]: writer, ...others }));
		return callersOf(world, `${A}#writeIt`).sort();
	};

	it("counts a call, a callback, and .call / .apply, but not the definition", () => {
		const b = lines(
			'import { writeIt } from "./a-logic";',
			"export async function viaCall(tx) {",
			"\tawait writeIt(tx);",
			"}",
			"export function viaCallback(tx, rows) {",
			"\treturn rows.map(writeIt);",
			"}",
			"export function viaCallMethod(tx) {",
			"\treturn writeIt.call(null, tx);",
			"}",
			"export function viaApply(tx) {",
			"\treturn writeIt.apply(null, [tx]);",
			"}",
			"export function unrelated() {",
			"\treturn 2;",
			"}",
		);
		expect(callersIn({ "src/server/b.ts": b })).toEqual([
			"src/server/b.ts#viaApply",
			"src/server/b.ts#viaCall",
			"src/server/b.ts#viaCallMethod",
			"src/server/b.ts#viaCallback",
		]);
	});

	it("counts a call under an import alias, and ignores a same-named local in a module that does not import it", () => {
		const aliased = lines(
			'import { writeIt as save } from "./a-logic";',
			"export async function go(tx) {",
			"\tawait save(tx);",
			"}",
		);
		const unrelated = lines(
			"function writeIt() {",
			"\treturn 0;",
			"}",
			"export function other() {",
			"\treturn writeIt();",
			"}",
		);
		expect(
			callersIn({ "src/server/b.ts": aliased, "src/server/c.ts": unrelated }),
		).toEqual(["src/server/b.ts#go"]);
	});

	it("does not count a name in a comment or a string", () => {
		const b = lines(
			'import { writeIt } from "./a-logic";',
			"export function a() {",
			"\t// writeIt(tx)",
			'\treturn "writeIt(tx)";',
			"}",
		);
		expect(callersIn({ "src/server/b.ts": b })).toEqual([]);
	});

	it("fails closed on a namespace import, a dynamic import and a re-export of a writer module", () => {
		const failures = (b: string) => {
			const models = modelsOf({ [A]: writer, "src/server/b.ts": b });
			const world = buildWorld(models);
			return moduleShapeFailures(
				world,
				deriveWriters(models, SW).writers.keys(),
			);
		};
		expect(
			failures('import * as logic from "./a-logic";\n').join("\n"),
		).toMatch(/namespace import of \.\/a-logic/);
		expect(
			failures(
				'export async function f() {\n\treturn import("./a-logic");\n}\n',
			).join("\n"),
		).toMatch(/dynamic import\(\) of \.\/a-logic/);
		expect(
			failures('export { writeIt } from "./a-logic";\n').join("\n"),
		).toMatch(/re-exports writeIt from/);
		expect(
			failures('export { writeIt as w } from "./a-logic";\n').join("\n"),
		).toMatch(/re-exports writeIt from/);
		expect(failures('export * from "./a-logic";\n').join("\n")).toMatch(
			/re-exports/,
		);
		expect(failures('export { selfCall } from "./a-logic";\n')).toEqual([]);
		// `export { w as v }` in the writer's own module, but not a plain `export { w }`.
		const own = (tail: string) => {
			const models = modelsOf({ [A]: writer + tail });
			return moduleShapeFailures(
				buildWorld(models),
				deriveWriters(models, SW).writers.keys(),
			);
		};
		expect(own("export { writeIt as v };\n").join("\n")).toMatch(
			/exports writeIt as v/,
		);
		expect(own("export { writeIt };\n")).toEqual([]);
	});

	it("fails closed on a top-level expression statement that references a writer", () => {
		const b = lines(
			'import { writeIt } from "./a-logic";',
			"registry.push(writeIt);",
		);
		const models = modelsOf({ [A]: writer, "src/server/b.ts": b });
		const world = buildWorld(models);
		expect(
			strayReferences(world, deriveWriters(models, SW).writers.keys()).join(
				"\n",
			),
		).toMatch(/outside any function or const references/);
	});
});

describe("refusal evidence", () => {
	const W = `${A}#save`;
	const body = (call: string) =>
		lines(
			"export async function save(tx, status) {",
			call,
			"\tawait tx.insert(roleSlots).values({});",
			"}",
		);
	const plan = (extra: Partial<ClassEntry> = {}): Entry => ({
		class: "plan",
		...extra,
	});

	it("accepts a class helper of the writer's class and nothing else", () => {
		expect(
			run(
				{ [A]: body('\tassertMeetingAccepts(status, "plan");') },
				{ [W]: plan() },
			),
		).toEqual([]);
		expect(
			run(
				{ [A]: body('\tassertMeetingAccepts(status, "plan");') },
				{ [W]: { class: "record" } },
			).join("\n"),
		).toMatch(/no "record" refusal/);
		expect(
			run({ [A]: body('\tmeetingRowAccepts("plan");') }, { [W]: plan() }),
		).toEqual([]);
		expect(run({ [A]: body("\tvoid 0;") }, { [W]: plan() }).join("\n")).toMatch(
			/no "plan" refusal/,
		);
	});

	it("does not count a helper call that is commented out or inside a string", () => {
		const commented = '\t// assertMeetingAccepts(status, "plan");';
		const block = '\t/* assertMeetingAccepts(status, "plan") */';
		const inString = "\tconst s = 'assertMeetingAccepts(status, \"plan\")';";
		for (const call of [commented, block, inString]) {
			expect(run({ [A]: body(call) }, { [W]: plan() }).join("\n")).toMatch(
				/no "plan" refusal/,
			);
		}
	});

	it("reads the class from a same-file const, and rejects one it cannot read", () => {
		const viaConst = lines(
			'const KIND: MeetingWriteClass = "plan";',
			"export async function save(tx, status) {",
			"\tassertMeetingAccepts(status, KIND);",
			"\tawait tx.insert(roleSlots).values({});",
			"}",
		);
		expect(run({ [A]: viaConst }, { [W]: plan() })).toEqual([]);
		expect(
			run({ [A]: viaConst }, { [W]: { class: "record" } }).join("\n"),
		).toMatch(/no "record" refusal/);
		const viaParam = lines(
			"export async function save(tx, status, kind) {",
			"\tassertMeetingAccepts(status, kind);",
			"\tawait tx.insert(roleSlots).values({});",
			"}",
		);
		expect(run({ [A]: viaParam }, { [W]: plan() }).join("\n")).toMatch(
			/no "plan" refusal/,
		);
	});

	it("counts a registered wrapper of the class, and not an unregistered one or one of another class", () => {
		const gate = lines(
			"export function assertOpen(status) {",
			'\tassertMeetingAccepts(status, "plan");',
			"}",
		);
		const writer = lines(
			'import { assertOpen } from "./gate";',
			"export async function save(tx, status) {",
			"\tassertOpen(status);",
			"\tawait tx.insert(roleSlots).values({});",
			"}",
		);
		const files = { [A]: writer, "src/server/gate.ts": gate };
		const gates: Gates = { "src/server/gate.ts#assertOpen": "plan" };
		expect(run(files, { [W]: plan() }, gates)).toEqual([]);
		expect(run(files, { [W]: plan() }, {}).join("\n")).toMatch(
			/no "plan" refusal/,
		);
		expect(run(files, { [W]: { class: "record" } }, gates).join("\n")).toMatch(
			/no "record" refusal/,
		);
	});

	it("does not count a wrapper that is only referenced, or that is shadowed in a module that does not import it", () => {
		const gate = lines(
			"export function assertOpen(status) {",
			'\tassertMeetingAccepts(status, "plan");',
			"}",
		);
		const gates: Gates = { "src/server/gate.ts#assertOpen": "plan" };
		const referenced = lines(
			'import { assertOpen } from "./gate";',
			"export async function save(tx, status) {",
			"\tconst f = assertOpen;",
			"\tawait tx.insert(roleSlots).values({});",
			"}",
		);
		expect(
			run(
				{ [A]: referenced, "src/server/gate.ts": gate },
				{ [W]: plan() },
				gates,
			).join("\n"),
		).toMatch(/no "plan" refusal/);
		const shadow = lines(
			"function assertOpen() {}",
			"export async function save(tx, status) {",
			"\tassertOpen(status);",
			"\tawait tx.insert(roleSlots).values({});",
			"}",
		);
		expect(
			run(
				{ [A]: shadow, "src/server/gate.ts": gate },
				{ [W]: plan() },
				gates,
			).join("\n"),
		).toMatch(/no "plan" refusal/);
	});
});

describe("registered wrappers", () => {
	const G = "src/server/gate.ts";
	const gates = (cls: MeetingWriteClass = "plan"): Gates => ({
		[`${G}#gate`]: cls,
	});
	const check = (src: string, g: Gates = gates()): string[] =>
		gateFailures(
			buildWorld(modelsOf({ [G]: src, "src/server/other.ts": other })),
			g,
		);
	const other = lines(
		"export function inner(s) {",
		'\tassertMeetingAccepts(s, "plan");',
		"}",
	);

	it("passes a wrapper that ends in the helper of its class", () => {
		expect(
			check(
				lines(
					"export function gate(s) {",
					'\tassertMeetingAccepts(s, "plan");',
					"}",
				),
			),
		).toEqual([]);
	});

	it("fails a wrapper that passes accept, however it spells it", () => {
		for (const call of [
			'assertMeetingAccepts(s, "plan", { accept: ["completed"] });',
			'assertMeetingAccepts(s, "plan", { accept: [] });',
			'assertMeetingAccepts(s, "plan", { ...OPEN, messages: {} });',
		]) {
			const src = lines(
				'export const OPEN = { accept: ["cancelled"] } as const;',
				"export function gate(s) {",
				`\t${call}`,
				"}",
			);
			const got = check(src).join("\n");
			// `accept: []` passes nothing, so only the first and third fail.
			if (call.includes("accept: []")) expect(got).toBe("");
			else expect(got).toMatch(/passes accept/);
		}
	});

	it("fails a wrapper whose class is the wrong one, or that calls nothing", () => {
		const src = lines(
			"export function gate(s) {",
			'\tassertMeetingAccepts(s, "record");',
			"}",
		);
		expect(check(src).join("\n")).toMatch(/does not end in/);
		expect(
			check("export function gate(s) {\n\treturn s;\n}\n").join("\n"),
		).toMatch(/does not end in/);
	});

	it("follows a chain of wrappers, and rejects two that only call each other", () => {
		const chain = lines(
			'import { inner } from "./other";',
			"export function gate(s) {",
			"\tinner(s);",
			"}",
		);
		expect(
			gateFailures(
				buildWorld(modelsOf({ [G]: chain, "src/server/other.ts": other })),
				{
					[`${G}#gate`]: "plan",
					"src/server/other.ts#inner": "plan",
				},
			),
		).toEqual([]);
		const loop = lines(
			"export function ping(s) {",
			"\tpong(s);",
			"}",
			"export function pong(s) {",
			"\tping(s);",
			"}",
		);
		expect(
			gateFailures(buildWorld(modelsOf({ [G]: loop })), {
				[`${G}#ping`]: "plan",
				[`${G}#pong`]: "plan",
			}).join("\n"),
		).toMatch(/does not end in/);
	});

	it("fails a registry key that names nothing, which is what renaming a wrapper does", () => {
		const src = lines(
			"export function gate(s) {",
			'\tassertMeetingAccepts(s, "plan");',
			"}",
		);
		expect(check(src, { [`${G}#renamedGate`]: "plan" }).join("\n")).toMatch(
			/names no top-level function or const/,
		);
	});
});

describe("overrides", () => {
	const W = `${A}#save`;
	const writer = (options: string) =>
		lines(
			"export async function save(tx, status) {",
			`\tassertMeetingAccepts(status, "plan"${options});`,
			"\tawait tx.insert(roleSlots).values({});",
			"}",
		);
	const override = (reason = "a reason"): Entry => ({
		class: "plan",
		overrides: { completed: { accept: true, reason } },
	});

	it("needs an override for an accept in code, and an accept in code for an override", () => {
		const withAccept = writer(', { accept: ["completed"] }');
		expect(run({ [A]: withAccept }, { [W]: override() })).toEqual([]);
		expect(
			run({ [A]: withAccept }, { [W]: { class: "plan" } }).join("\n"),
		).toMatch(/accepts completed .* with no override/);
		expect(run({ [A]: writer("") }, { [W]: override() }).join("\n")).toMatch(
			/overrides\.completed is declared but no class-helper call/,
		);
	});

	it("needs the exact statuses, not a superset or a subset", () => {
		const both = writer(', { accept: ["cancelled", "completed"] }');
		const failures = run({ [A]: both }, { [W]: override() }).join("\n");
		expect(failures).toMatch(/accepts cancelled/);
		expect(
			run(
				{ [A]: both },
				{
					[W]: {
						class: "plan",
						overrides: {
							cancelled: { accept: true, reason: "r" },
							completed: { accept: true, reason: "r" },
						},
					},
				},
			),
		).toEqual([]);
	});

	it("needs a reason", () => {
		expect(
			run(
				{ [A]: writer(', { accept: ["completed"] }') },
				{ [W]: override("  ") },
			).join("\n"),
		).toMatch(/the completed override needs a reason/);
	});

	it("reads an options constant, a spread of one and a conditional, from wherever it is defined", () => {
		const consts = lines(
			'export const ACCEPT_DONE = { accept: ["completed"] } as const;',
		);
		for (const options of [
			", ACCEPT_DONE",
			", { ...ACCEPT_DONE, messages: {} }",
			", flag ? ACCEPT_DONE : {}",
		]) {
			const files = {
				[A]: `import { ACCEPT_DONE } from "./consts";\n${writer(options)}`,
				"src/server/consts.ts": consts,
			};
			expect(run(files, { [W]: override() }), options).toEqual([]);
			expect(
				run(files, { [W]: { class: "plan" } }).join("\n"),
				options,
			).toMatch(/with no override/);
		}
	});

	it("fails an options argument it cannot read", () => {
		for (const options of [
			", opts",
			", { accept: list }",
			", { ...rest }",
			", makeOptions()",
		]) {
			const failures = run(
				{ [A]: writer(options) },
				{ [W]: { class: "plan" } },
			);
			// `makeOptions()` names no accept and no const: nothing is hidden in it.
			if (options.includes("makeOptions"))
				expect(failures, options).toEqual([]);
			else
				expect(failures.join("\n"), options).toMatch(
					/not a top-level const|not a literal list|spread of/,
				);
		}
	});

	it("ignores `accept` inside a message string", () => {
		expect(
			run(
				{
					[A]: writer(', { messages: { cancelled: "we accept: [nothing]" } }'),
				},
				{ [W]: { class: "plan" } },
			),
		).toEqual([]);
	});
});

describe("refusedBy follows the callers", () => {
	const W = "src/server/w-logic.ts#store";
	const store = lines(
		"export async function store(tx) {",
		"\tawait tx.insert(roleSlots).values({});",
		"}",
	);
	const refuser = (name: string, call: string) =>
		lines(
			'import { store } from "./w-logic";',
			`export async function ${name}(tx, status) {`,
			`\t${call}`,
			"\tawait store(tx);",
			"}",
		);
	const entry = (extra: Partial<ClassEntry>): Entry => ({
		class: "plan",
		...extra,
	});
	const files = (more: Record<string, string> = {}) => ({
		"src/server/w-logic.ts": store,
		...more,
	});

	it("passes when the only caller refuses and is listed", () => {
		expect(
			run(
				files({
					"src/server/h.ts": refuser(
						"handler",
						'assertMeetingAccepts(status, "plan");',
					),
				}),
				{
					[W]: entry({ refusedBy: ["src/server/h.ts#handler"] }),
				},
			),
		).toEqual([]);
	});

	it("fails when the listed caller does not refuse by the writer's class", () => {
		expect(
			run(
				files({
					"src/server/h.ts": refuser(
						"handler",
						'assertMeetingAccepts(status, "record");',
					),
				}),
				{
					[W]: entry({ refusedBy: ["src/server/h.ts#handler"] }),
				},
			).join("\n"),
		).toMatch(/whose body has no "plan" refusal/);
	});

	it("fails a new caller that is not listed, however it refuses", () => {
		const failures = run(
			files({
				"src/server/h.ts": refuser(
					"handler",
					'assertMeetingAccepts(status, "plan");',
				),
				"src/server/rogue.ts": refuser(
					"rogue",
					'assertMeetingAccepts(status, "plan");',
				),
			}),
			{ [W]: entry({ refusedBy: ["src/server/h.ts#handler"] }) },
		);
		expect(failures.join("\n")).toMatch(
			/src\/server\/rogue\.ts#rogue reaches it and is neither a refuser nor an exempt caller/,
		);
	});

	it("follows a chain: an intermediary that refuses nothing passes the path on to its callers", () => {
		const middle = lines(
			'import { store } from "./w-logic";',
			"export async function middle(tx) {",
			"\tawait store(tx);",
			"}",
		);
		const top = lines(
			'import { middle } from "./m";',
			"export async function top(tx, status) {",
			'\tassertMeetingAccepts(status, "plan");',
			"\tawait middle(tx);",
			"}",
		);
		const f = files({ "src/server/m.ts": middle, "src/server/t.ts": top });
		expect(
			run(f, { [W]: entry({ refusedBy: ["src/server/t.ts#top"] }) }),
		).toEqual([]);
		// Naming the intermediary instead says it refuses, which it does not.
		expect(
			run(f, { [W]: entry({ refusedBy: ["src/server/m.ts#middle"] }) }).join(
				"\n",
			),
		).toMatch(/whose body has no "plan" refusal/);
		// A second, unguarded way into the intermediary is a way into the writer.
		const rogue = lines(
			'import { middle } from "./m";',
			"export async function rogue(tx) {",
			"\tawait middle(tx);",
			"}",
		);
		expect(
			run(
				{ ...f, "src/server/r.ts": rogue },
				{ [W]: entry({ refusedBy: ["src/server/t.ts#top"] }) },
			).join("\n"),
		).toMatch(/rogue reaches it through .*middle/);
	});

	it("fails a top-level statement that references an intermediary, which no key can name", () => {
		const middle = lines(
			'import { store } from "./w-logic";',
			"export async function middle(tx) {",
			"\tawait store(tx);",
			"}",
		);
		const top = lines(
			'import { middle } from "./m";',
			"export async function top(tx, status) {",
			'\tassertMeetingAccepts(status, "plan");',
			"\tawait middle(tx);",
			"}",
		);
		const sneaky = lines(
			'import { middle } from "./m";',
			"registry.push(middle);",
		);
		expect(
			run(
				files({
					"src/server/m.ts": middle,
					"src/server/t.ts": top,
					"src/server/s.ts": sneaky,
				}),
				{ [W]: entry({ refusedBy: ["src/server/t.ts#top"] }) },
			).join("\n"),
		).toMatch(/outside any function or const references .*middle/);
	});

	it("fails a listed unit nothing reaches the writer through", () => {
		const stale = lines(
			"export async function idle(tx, status) {",
			'\tassertMeetingAccepts(status, "plan");',
			"}",
		);
		expect(
			run(
				files({
					"src/server/h.ts": refuser(
						"handler",
						'assertMeetingAccepts(status, "plan");',
					),
					"src/server/i.ts": stale,
				}),
				{
					[W]: entry({
						refusedBy: ["src/server/h.ts#handler", "src/server/i.ts#idle"],
					}),
				},
			).join("\n"),
		).toMatch(/idle is listed .* but nothing reaches the writer through it/);
	});

	it("takes an exempt caller with a reason, and fails one without", () => {
		const seed = lines(
			'import { store } from "./w-logic";',
			"export async function seed(tx) {",
			"\tawait store(tx);",
			"}",
		);
		const f = files({
			"src/server/h.ts": refuser(
				"handler",
				'assertMeetingAccepts(status, "plan");',
			),
			"src/server/s.ts": seed,
		});
		expect(
			run(f, {
				[W]: entry({
					refusedBy: ["src/server/h.ts#handler"],
					exemptCallers: { "src/server/s.ts#seed": "runs at creation" },
				}),
			}),
		).toEqual([]);
		expect(
			run(f, {
				[W]: entry({
					refusedBy: ["src/server/h.ts#handler"],
					exemptCallers: { "src/server/s.ts#seed": " " },
				}),
			}).join("\n"),
		).toMatch(/exemptCallers .*seed needs a reason/);
	});

	it("rejects refusedBy on a writer that refuses in its own body, and a writer with neither", () => {
		const own = lines(
			"export async function store(tx, status) {",
			'\tassertMeetingAccepts(status, "plan");',
			"\tawait tx.insert(roleSlots).values({});",
			"}",
		);
		expect(
			run(
				{
					"src/server/w-logic.ts": own,
					"src/server/h.ts": refuser(
						"handler",
						'assertMeetingAccepts(status, "plan");',
					),
				},
				{ [W]: entry({ refusedBy: ["src/server/h.ts#handler"] }) },
			).join("\n"),
		).toMatch(/refuses by "plan" in its own body, so refusedBy/);
		expect(run(files(), { [W]: entry({}) }).join("\n")).toMatch(
			/and no refusedBy/,
		);
	});
});

describe("the way into a unit the walk passes through", () => {
	const W = "src/server/w-logic.ts#store";
	const store = lines(
		"export async function store(tx) {",
		"\tawait tx.insert(roleSlots).values({});",
		"}",
	);
	const middle = lines(
		'import { store } from "./w-logic";',
		"export async function middle(tx) {",
		"\tawait store(tx);",
		"}",
	);
	const top = lines(
		'import { middle } from "./m";',
		"export async function top(tx, status) {",
		'\tassertMeetingAccepts(status, "plan");',
		"\tawait middle(tx);",
		"}",
	);
	const entry: Entry = {
		class: "plan",
		refusedBy: ["src/server/t.ts#top"],
	};
	const base = {
		"src/server/w-logic.ts": store,
		"src/server/m.ts": middle,
		"src/server/t.ts": top,
	};
	const check = (
		more: Record<string, string> = {},
		outside: Record<string, string> = {},
		files: Record<string, string> = base,
	): string =>
		run({ ...files, ...more }, { [W]: entry }, {}, outside).join("\n");

	it("passes when the intermediary is reachable only from its listed chain", () => {
		expect(check()).toBe("");
	});

	it("fails a barrel that re-exports the intermediary, however it spells it", () => {
		expect(
			check({ "src/server/barrel.ts": 'export { middle } from "./m";\n' }),
		).toMatch(/barrel\.ts: re-exports middle from \.\/m/);
		expect(
			check({
				"src/server/barrel.ts": 'export { middle as renamed } from "./m";\n',
			}),
		).toMatch(/barrel\.ts: re-exports middle from \.\/m/);
		expect(check({ "src/server/barrel.ts": 'export * from "./m";\n' })).toMatch(
			/barrel\.ts: re-exports middle from \.\/m/,
		);
	});

	it("fails an alias of the intermediary in its own module, a namespace import and a dynamic import of it", () => {
		expect(
			check({ "src/server/m.ts": `${middle}export { middle as other };\n` }),
		).toMatch(/m\.ts: exports middle as other/);
		expect(check({ "src/server/n.ts": 'import * as m from "./m";\n' })).toMatch(
			/n\.ts: namespace import of \.\/m, which defines middle/,
		);
		expect(
			check({
				"src/server/n.ts":
					'export async function lazy() {\n\treturn import("./m");\n}\n',
			}),
		).toMatch(/n\.ts: dynamic import\(\) of \.\/m, which defines middle/);
	});

	it("fails the same shapes in a module outside src/server, where a route or a lib file can sit", () => {
		expect(
			check(
				{},
				{ "src/lib/barrel.ts": 'export { middle } from "#/server/m";\n' },
			),
		).toMatch(/src\/lib\/barrel\.ts: re-exports middle/);
		expect(
			check(
				{},
				{
					"src/routes/r.tsx":
						'export const lazy = () => import("#/server/m");\n',
				},
			),
		).toMatch(/src\/routes\/r\.tsx: dynamic import\(\) of #\/server\/m/);
		expect(
			check(
				{},
				{ "src/routes/r.tsx": 'import * as logic from "#/server/m";\n' },
			),
		).toMatch(/src\/routes\/r\.tsx: namespace import of #\/server\/m/);
	});

	it("fails a module outside src/server that imports the intermediary or the writer", () => {
		const route = (from: string, name: string) =>
			lines(
				`import { ${name} } from "${from}";`,
				"export function Page() {",
				`\treturn ${name};`,
				"}",
			);
		expect(
			check({}, { "src/routes/api/x.tsx": route("#/server/m", "middle") }),
		).toMatch(
			/src\/routes\/api\/x\.tsx, outside src\/server, reaches .*#middle on the way to it/,
		);
		expect(
			check({}, { "src/routes/api/x.tsx": route("#/server/w-logic", "store") }),
		).toMatch(
			/src\/routes\/api\/x\.tsx, outside src\/server, reaches .*#store, and nothing/,
		);
		// An import that is never used is not a way in.
		expect(
			check(
				{},
				{ "src/routes/x.tsx": 'import { middle } from "#/server/m";\n' },
			),
		).toBe("");
		// Nor is a module that imports something else from the same file.
		expect(check({}, { "src/routes/x.tsx": route("#/server/t", "top") })).toBe(
			"",
		);
	});

	it("fails an intermediary that is a server fn, which anyone can call with nothing in front of it", () => {
		const serverFn = lines(
			'import { store } from "./w-logic";',
			'export const middle = createServerFn({ method: "POST" }).handler(async () => {',
			"\tawait store(tx);",
			"});",
		);
		expect(check({ "src/server/m.ts": serverFn })).toMatch(
			/#middle is on the way to it and is a server fn/,
		);
	});

	it("fails a refusedBy writer that is itself a server fn", () => {
		const serverFn = lines(
			'export const store = createServerFn({ method: "POST" }).handler(async () => {',
			"\tawait tx.insert(roleSlots).values({});",
			"});",
		);
		expect(check({ "src/server/w-logic.ts": serverFn })).toMatch(
			/#store is a server fn, callable directly/,
		);
	});
});

describe("an override that the callers keep refused", () => {
	const W = "src/server/w-logic.ts#store";
	const store = lines(
		"export async function store(tx, status) {",
		'\tassertMeetingAccepts(status, "plan", { accept: ["completed"] });',
		"\tawait tx.insert(roleSlots).values({});",
		"}",
	);
	const caller = (name: string, call: string) =>
		lines(
			'import { store } from "./w-logic";',
			`export async function ${name}(tx, status) {`,
			`\t${call}`,
			"\tawait store(tx, status);",
			"}",
		);
	const entry = (
		extra: Partial<Override> = {},
		overrides: ClassEntry["overrides"] = {
			completed: {
				accept: true,
				reason: "the callers refuse it",
				refusedBy: ["src/server/h.ts#handler"],
				...extra,
			},
		},
	): Entry => ({ class: "plan", overrides });
	const files = (
		more: Record<string, string> = {},
		handler = 'assertMeetingAccepts(status, "plan", { accept: ["cancelled"] });',
	) => ({
		"src/server/w-logic.ts": store,
		"src/server/h.ts": caller("handler", handler),
		...more,
	});

	it("passes when every caller refuses the status the writer accepts", () => {
		expect(run(files(), { [W]: entry() })).toEqual([]);
	});

	it("fails a new caller that is not named, which is how a completed meeting gets through", () => {
		expect(
			run(files({ "src/server/rogue.ts": caller("rogue", "void status;") }), {
				[W]: entry(),
			}).join("\n"),
		).toMatch(
			/rogue reaches it and is neither a refuser nor an exempt caller.*overrides\.completed/,
		);
	});

	it("fails a named caller that accepts the status, or refuses by another class, or nothing", () => {
		for (const handler of [
			'assertMeetingAccepts(status, "plan", { accept: ["cancelled", "completed"] });',
			'assertMeetingAccepts(status, "record");',
			"void status;",
		]) {
			expect(
				run(files({}, handler), { [W]: entry() }).join("\n"),
				handler,
			).toMatch(
				/refusedBy src\/server\/h\.ts#handler, which does not refuse completed by "plan"/,
			);
		}
	});

	it("takes an exempt caller with a reason, and fails one without", () => {
		const seed = caller("seed", "void status;");
		const named = (reason: string) =>
			entry({ exemptCallers: { "src/server/s.ts#seed": reason } });
		expect(
			run(files({ "src/server/s.ts": seed }), { [W]: named("on purpose") }),
		).toEqual([]);
		expect(
			run(files({ "src/server/s.ts": seed }), { [W]: named(" ") }).join("\n"),
		).toMatch(/exemptCallers src\/server\/s\.ts#seed needs a reason/);
	});

	it("fails a listed caller nothing reaches the writer through", () => {
		expect(
			run(files(), {
				[W]: entry({
					refusedBy: ["src/server/h.ts#handler", "src/server/gone.ts#x"],
				}),
			}).join("\n"),
		).toMatch(
			/refusedBy src\/server\/gone\.ts#x names no top-level function or const/,
		);
	});

	it("needs the writer's own refusal for the statuses it does not accept: deleting it fails", () => {
		const noRefusal = lines(
			"export async function store(tx, status) {",
			"\tawait tx.insert(roleSlots).values({});",
			"}",
		);
		expect(
			run(files({ "src/server/w-logic.ts": noRefusal }), { [W]: entry() }).join(
				"\n",
			),
		).toMatch(/no "plan" refusal|has no "plan" refusal in its own body/);
	});

	it("is a way into a server fn writer, which is callable with no caller", () => {
		const serverFn = lines(
			'export const store = createServerFn({ method: "POST" }).handler(async () => {',
			'\tassertMeetingAccepts(status, "plan", { accept: ["completed"] });',
			"\tawait tx.insert(roleSlots).values({});",
			"});",
		);
		expect(
			run(files({ "src/server/w-logic.ts": serverFn }), { [W]: entry() }).join(
				"\n",
			),
		).toMatch(/#store is a server fn, callable directly/);
	});

	it("fails a module outside src/server that calls the writer directly", () => {
		const page = lines(
			'import { store } from "#/server/w-logic";',
			"export function Page() {",
			"\treturn store;",
			"}",
		);
		expect(
			run(files(), { [W]: entry() }, {}, { "src/routes/p.tsx": page }).join(
				"\n",
			),
		).toMatch(/src\/routes\/p\.tsx, outside src\/server, reaches .*#store/);
	});
});

describe("the class map", () => {
	const W = `${A}#save`;
	const src = lines(
		"export async function save(tx) {",
		"\tawait tx.insert(roleSlots).values({});",
		"}",
	);

	it("requires an entry for every derived writer and none for a unit that no longer writes", () => {
		expect(run({ [A]: src }, {}).join("\n")).toMatch(
			/save writes a meeting-scoped table and has no entry/,
		);
		expect(
			run(
				{ [A]: src },
				{
					[W]: { class: "exempt", reason: "r" },
					[`${A}#gone`]: { class: "exempt", reason: "r" },
				},
			).join("\n"),
		).toMatch(/gone, which no longer writes/);
	});

	it("needs a reason on an exempt entry, and puts lifecycle on a fixed list", () => {
		expect(
			run({ [A]: src }, { [W]: { class: "exempt", reason: " " } }).join("\n"),
		).toMatch(/an exempt entry needs a reason/);
		expect(
			run({ [A]: src }, { [W]: { class: "lifecycle", reason: "r" } }).join(
				"\n",
			),
		).toMatch(/lifecycle is a fixed list/);
		expect(
			run({ [A]: src }, { [W]: { class: "exempt", reason: "creation" } }),
		).toEqual([]);
	});

	it("fails a writer flipped to the other class, in either direction", () => {
		const planCall = lines(
			"export async function save(tx, status) {",
			'\tassertMeetingAccepts(status, "plan");',
			"\tawait tx.insert(roleSlots).values({});",
			"}",
		);
		expect(run({ [A]: planCall }, { [W]: { class: "plan" } })).toEqual([]);
		expect(
			run({ [A]: planCall }, { [W]: { class: "record" } }).join("\n"),
		).toMatch(/no "record" refusal/);
		expect(
			run(
				{ [A]: planCall.replace('"plan"', '"record"') },
				{ [W]: { class: "plan" } },
			).join("\n"),
		).toMatch(/no "plan" refusal/);
	});
});
