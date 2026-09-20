/**
 * The write half of the guest-book confirm flow (#806): this tool's body inside
 * the shared locked-apply skeleton (#812).
 *
 * The SKELETON is `src/server/mcp-pending-apply.ts` — lock the club, re-prove
 * the caller's standing, re-read the row `FOR UPDATE`, refuse an already-applied
 * or expired row, then claim and tombstone it. None of that is guest-book
 * knowledge, and a second copy of it is how the double-apply guard gets fixed in
 * one place and not the other.
 *
 * What is HERE is the part only this tool can do, and the shape
 * `record_guest_book` proved (#773 D5):
 *
 *   re-plan against `tx` → compare the hash → refuse while anything blocks
 *   → execute THE PLAN, not the input → log in the same transaction
 *
 * Everything that decides is re-decided inside the lock, because the gap
 * between "the page rendered" and "the button was clicked" is unbounded — a
 * confirm link is open for up to a day — and every fact the plan rests on can
 * move inside it.
 *
 * ## Why this is its own module
 *
 * `mcp-authz.guard.test.ts` fails any `.ts` under `src/server/mcp/` that
 * imports a session guard, and it should: `/api/mcp` is bearer-only, and that
 * is the whole CSRF posture. This apply is authorized by a SESSION, so it
 * cannot live there.
 *
 * ## The payload is read HERE, inside the lock
 *
 * Not passed in. The confirm page PATCHes edits into the same row, so entries
 * carried across from the render that produced the hash could be a version the
 * hash was never taken over. Reading them under the row lock makes the plan
 * that is hashed, the plan that is executed, and the plan that is stored one
 * thing.
 */
import { guests, meetingAttendance } from "#/db/schema";
import {
	EXPIRED_IN_LOCK_MESSAGE,
	livePendingEntries,
	type PendingEntry,
	pendingPlanArgs,
	RECORDED_WHILE_OPEN_MESSAGE,
} from "#/lib/guest-book-pending";
import { RECORD_GUEST_BOOK_TOOL } from "#/lib/pending-plan";
import { logActivity } from "#/server/activity";
import {
	parseGuestBookPayload,
	UNREADABLE_ENTRIES_MESSAGE,
} from "#/server/guest-book-pending-schemas";
import { guestBookPlanHash, plan, planSummary } from "#/server/guest-book-plan";
import { McpError } from "#/server/mcp/errors";
import { applyPendingPlanLocked } from "#/server/mcp-pending-apply";

/** The tool this apply claims rows for. Matched in the `FOR UPDATE`'s WHERE. */
const GUEST_BOOK_TOOL = RECORD_GUEST_BOOK_TOOL;

export interface ApplyGuestBookPlanInput {
	pendingId: string;
	club: { clubId: string; timezone: string };
	/** The session user. Also the hash's `userId` — see `guestBookPlanHash`. */
	userId: string;
	/** Credited with the write; null for a read-write impersonating superadmin. */
	actorMemberId: string | null;
	/** The hash the page last rendered. */
	planHash: string;
	countryCode: string;
}

export interface ApplyGuestBookPlanResult {
	meeting: { meetingId: string; date: string; theme: string | null };
	meetingNumber: number | null;
	summary: ReturnType<typeof planSummary>;
	newGuestIds: string[];
	matchedGuestIds: string[];
	attendanceRecorded: number;
}

/**
 * Apply a pending plan. Throws `McpError` on every refusal, which rolls the
 * transaction back; `guest-book-pending-logic.ts` maps those codes to the page
 * states the route renders.
 *
 * `McpError` rather than a second error vocabulary because the codes are the
 * same facts — `PLAN_STALE`, `BLOCKED`, `NOT_RECORDABLE` — raised by the same
 * `plan()` this calls. Inventing a parallel set here would mean the confirm
 * page had to handle two names for each one.
 */
export async function applyGuestBookPlan(
	input: ApplyGuestBookPlanInput,
): Promise<ApplyGuestBookPlanResult> {
	return applyPendingPlanLocked<ApplyGuestBookPlanResult>({
		pendingId: input.pendingId,
		tool: GUEST_BOOK_TOOL,
		clubId: input.club.clubId,
		userId: input.userId,
		copy: {
			notFound: "That plan no longer exists.",
			// DELIBERATELY not the sentence `applyPendingPlan` gives for a plan
			// that was already applied before the call started. The two used to
			// read identically, and that made the locked guard untestable: the
			// cheap pre-check short-circuits every serial case, so an assertion
			// matching both sentences passed without the locked guard ever
			// running. A test can only prove it fires if it says something only
			// it says. `src/lib/pending-plan.test.ts` asserts the pair differs.
			alreadyApplied: RECORDED_WHILE_OPEN_MESSAGE,
			expired: EXPIRED_IN_LOCK_MESSAGE,
		},
		apply: async (tx, row) => {
			// PARSE, do not trust the column's compile-time type. This read happens
			// inside the lock and is the one whose values reach `guests` — a row
			// written by a previous release across a deploy boundary must refuse
			// here rather than be written half-understood. See
			// `parseGuestBookPayload`.
			const payload = parseGuestBookPayload(row.payload);
			if (!payload || payload.entriesUnreadable) {
				throw new McpError("BLOCKED", UNREADABLE_ENTRIES_MESSAGE);
			}
			const entries: PendingEntry[] = payload.entries ?? [];
			if (livePendingEntries(entries).length === 0) {
				throw new McpError(
					"BLOCKED",
					"Every line on this page has been dropped, so there is nothing to record.",
				);
			}

			const args = pendingPlanArgs(entries);
			const {
				plan: fresh,
				blocking,
				meetingNumber,
			} = await plan(
				tx,
				input.club,
				{ meetingDate: payload.meetingDate, ...args },
				input.countryCode,
			);

			// The meeting stopped being identifiable between render and click — it was
			// rescheduled or deleted, or a second one was added to the day. Nothing is
			// written; the transaction rolls back on throw.
			if (!fresh) {
				throw new McpError(
					"BLOCKED",
					"That date no longer names one meeting.",
					{
						blocking,
					},
				);
			}

			const freshHash = guestBookPlanHash({
				clubId: input.club.clubId,
				userId: input.userId,
				plan: fresh,
			});
			if (freshHash !== input.planHash) {
				throw new McpError(
					"PLAN_STALE",
					"The club changed since this page was loaded. Check the refreshed plan and apply again.",
				);
			}
			if (blocking.length > 0) {
				throw new McpError(
					"BLOCKED",
					"Some lines still need an answer before this page can be recorded.",
					{ blocking },
				);
			}

			// Execute THE PLAN, not the input.
			const newGuestIds: string[] = [];
			const matchedGuestIds: string[] = [];
			const attendanceFor: string[] = [];

			for (const e of fresh.entries) {
				if (e.outcome === "new" && e.write) {
					const [created] = await tx
						.insert(guests)
						.values({
							clubId: input.club.clubId,
							name: e.write.name,
							preferredName: e.write.preferredName,
							email: e.write.email,
							phone: e.write.phone,
							// This flow never changes a guest's stage, and a brand-new visitor
							// starts where the guest book's own front door starts them
							// (ADR-0018).
							stage: "prospect",
						})
						.returning({ id: guests.id });
					if (!created)
						throw new McpError("INTERNAL", "Failed to create guest.");
					newGuestIds.push(created.id);
					attendanceFor.push(created.id);
				} else if (e.outcome === "matched" && e.guestId) {
					matchedGuestIds.push(e.guestId);
					attendanceFor.push(e.guestId);
				}
			}

			if (attendanceFor.length > 0) {
				await tx
					.insert(meetingAttendance)
					.values(
						attendanceFor.map((guestId) => ({
							meetingId: fresh.meeting.meetingId,
							guestId,
							status: "present" as const,
						})),
					)
					// Idempotent per (meeting, guest) — the same safety net the public
					// guest book and the minutes editor both rely on.
					.onConflictDoNothing({
						target: [meetingAttendance.meetingId, meetingAttendance.guestId],
					});
			}

			// Same transaction as the writes, so the two commit together (D10). The
			// detail carries IDS ONLY — every member of the club can read the activity
			// feed, and a visitor's name and email are not theirs to read.
			//
			// `via: "guest-book-confirm"`, not `"mcp"`: the transcription came from an
			// MCP call but this write is a session action by a named admin, and "mcp"
			// would name something that is no longer true.
			await logActivity(tx, {
				clubId: input.club.clubId,
				actorMemberId: input.actorMemberId,
				action: "guest_visits_record",
				targetType: "meeting",
				targetId: fresh.meeting.meetingId,
				detail: {
					meetingId: fresh.meeting.meetingId,
					newGuestIds,
					matchedGuestIds,
					via: "guest-book-confirm",
				},
			});

			return {
				result: {
					meeting: fresh.meeting,
					meetingNumber,
					summary: planSummary(fresh),
					newGuestIds,
					matchedGuestIds,
					attendanceRecorded: attendanceFor.length,
				},
				// The tombstone the skeleton writes beside `applied_at`. The
				// meeting DATE survives and the transcription does not: the applied
				// page still says which meeting the visitors are on, while no
				// visitor's name, email or phone sits here at rest once the write it
				// justified has landed.
				tombstone: { meetingDate: payload.meetingDate, entries: null },
			};
		},
	});
}
