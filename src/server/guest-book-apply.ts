/**
 * The write half of the guest-book confirm flow (#806): one locked transaction
 * that turns a pending plan into guests and attendance.
 *
 * This is the shape `record_guest_book` proved and then handed over (#773 D5):
 *
 *   lock the club → re-prove the caller's standing → re-read the pending row
 *   → re-plan against `tx` → compare the hash → refuse while anything blocks
 *   → execute THE PLAN, not the input → log in the same transaction.
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
 * cannot live there. It is also the SOLE owner of the `applied_at IS NULL`
 * guard — a second copy of "has this already been applied" anywhere else is how
 * a double-click writes a page twice.
 *
 * ## The entries are read HERE, inside the lock
 *
 * Not passed in. The confirm page PATCHes edits into the same row, so entries
 * carried across from the render that produced the hash could be a version the
 * hash was never taken over. Reading them under the row lock makes the plan
 * that is hashed, the plan that is executed, and the plan that is stored one
 * thing.
 */
import { eq } from "drizzle-orm";
import { db } from "#/db";
import { guestBookPendingPlans, guests, meetingAttendance } from "#/db/schema";
import {
	isPendingPlanExpired,
	livePendingEntries,
	type PendingEntry,
	pendingPlanArgs,
} from "#/lib/guest-book-pending";
import { logActivity } from "#/server/activity";
import { assertStillClubAdmin } from "#/server/guards";
import {
	parseStoredEntries,
	UNREADABLE_ENTRIES_MESSAGE,
} from "#/server/guest-book-pending-schemas";
import { guestBookPlanHash, plan, planSummary } from "#/server/guest-book-plan";
import { McpError } from "#/server/mcp/errors";
import { lockClub } from "#/server/mcp/lock";

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
	return db.transaction(async (tx) => {
		// Serialise applies on this club before reading anything, so the re-plan
		// below sees a state no other apply can move underneath it.
		await lockClub(tx, input.club.clubId);

		// The grant was proved before this transaction opened, and the lock above
		// may have made it wait. Re-prove it against `tx` now that the lock is
		// held, for the same reason the plan is rebuilt here.
		await assertStillClubAdmin(tx, input.userId, input.club.clubId);

		// `FOR UPDATE` is what makes the `applied_at` check below atomic: a
		// concurrent apply of the same row blocks here rather than reading a row
		// it is about to have written out from under it.
		const [row] = await tx
			.select({
				id: guestBookPendingPlans.id,
				meetingDate: guestBookPendingPlans.meetingDate,
				entries: guestBookPendingPlans.entries,
				appliedAt: guestBookPendingPlans.appliedAt,
				expiresAt: guestBookPendingPlans.expiresAt,
			})
			.from(guestBookPendingPlans)
			.where(eq(guestBookPendingPlans.id, input.pendingId))
			.for("update")
			.limit(1);

		if (!row) throw new McpError("NOT_FOUND", "That plan no longer exists.");
		// THE double-apply guard, and the only one. A second click, a replayed
		// request, or two tabs on the same link all arrive here.
		//
		// Its sentence is DELIBERATELY different from the one
		// `applyPendingPlan` gives for a plan that was already applied before
		// the call started. The two used to read identically, and that made this
		// guard untestable: the cheap check short-circuits every serial case, so
		// an assertion matching both sentences passed without this line ever
		// running. A test can only prove the locked guard fires if the locked
		// guard says something only it says.
		if (row.appliedAt !== null) {
			throw new McpError(
				"BLOCKED",
				"That page was recorded while this one was open.",
				{ alreadyApplied: true },
			);
		}

		// Expiry is decided by `isPendingPlanExpired` and enforced twice: the logic
		// module refuses first, so the page renders an "expired" state instead of
		// a failed apply, and this refuses again under the lock, because a click
		// can land on either side of the boundary. One predicate, two enforcement
		// points — the same shape the archive gate uses.
		if (isPendingPlanExpired(row)) {
			throw new McpError(
				"BLOCKED",
				"That confirmation link has expired. Transcribe the page again.",
				{ expired: true },
			);
		}

		// PARSE, do not trust the column's compile-time type. This read happens
		// inside the lock and is the one whose values reach `guests` — a row
		// written by a previous release across a deploy boundary must refuse
		// here rather than be written half-understood. See `parseStoredEntries`.
		const parsed = parseStoredEntries(row.entries);
		if (row.entries !== null && parsed === null) {
			throw new McpError("BLOCKED", UNREADABLE_ENTRIES_MESSAGE);
		}
		const entries: PendingEntry[] = parsed ?? [];
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
			{ meetingDate: row.meetingDate, ...args },
			input.countryCode,
		);

		// The meeting stopped being identifiable between render and click — it was
		// rescheduled or deleted, or a second one was added to the day. Nothing is
		// written; the transaction rolls back on throw.
		if (!fresh) {
			throw new McpError("BLOCKED", "That date no longer names one meeting.", {
				blocking,
			});
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
				if (!created) throw new McpError("INTERNAL", "Failed to create guest.");
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

		// The tombstone, in the same transaction as the writes. `applied_at` is
		// what makes a re-opened link say "already recorded" instead of
		// "not found"; nulling `entries` is what stops a visitor's name, email and
		// phone sitting here at rest once the write it justified has landed.
		// The app clock, not `now()`. `created_at` and `expires_at` are written
		// from the app clock as UTC, and `now()` is a `timestamptz` cast into a
		// `timestamp` column through the session's TimeZone — so on a non-UTC
		// session this one column would disagree with the other two about what
		// time it is on the same row.
		await tx
			.update(guestBookPendingPlans)
			.set({ appliedAt: new Date(), entries: null })
			.where(eq(guestBookPendingPlans.id, input.pendingId));

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
			meeting: fresh.meeting,
			meetingNumber,
			summary: planSummary(fresh),
			newGuestIds,
			matchedGuestIds,
			attendanceRecorded: attendanceFor.length,
		};
	});
}
