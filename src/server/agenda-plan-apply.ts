/**
 * The write half of the `upsert_agendas` confirm flow (#808): this tool's body
 * inside the shared locked-apply skeleton (#812).
 *
 * The SKELETON is `src/server/mcp-pending-apply.ts` — lock the club, re-prove
 * the caller's standing, re-read the row `FOR UPDATE`, refuse an already-applied
 * or expired row, then claim and tombstone it. None of that is agenda knowledge,
 * and a second copy of it is how the double-apply guard gets fixed in one place
 * and not the other.
 *
 * What is HERE is the part only this tool can do:
 *
 *   re-plan against `tx` → refuse while anything blocks → compare the hash
 *   → execute THE PLAN, not the input → log in the same transaction
 *
 * ## Blocking is checked BEFORE the hash, and that ordering is the point
 *
 * `guest-book-apply.ts` compares its hash first. Here the order is reversed,
 * because a date's state can move in a way that produces a specific explanation:
 * a meeting completed between the render and the click both blocks and changes
 * the plan, and "the club changed, look again" would be the less useful of the
 * two sentences the system can say. Hash-first would also make the in-lock
 * meeting-lock refusal unreachable by any test — it would always be shadowed by
 * `PLAN_STALE` — which is exactly the shape #806 shipped twice (AC13).
 *
 * A concurrent edit that blocks nothing still fails the hash, which is AC9.
 *
 * ## Why this is its own module and not under `src/server/mcp/`
 *
 * `mcp-authz.guard.test.ts` fails any `.ts` under `src/server/mcp/` that imports
 * a session guard, and it should: `/api/mcp` is bearer-only, and that is the
 * whole CSRF posture. This apply is authorized by a SESSION.
 *
 * ## The payload is read HERE, inside the lock
 *
 * Not passed in. Reading it under the row lock makes the plan that is hashed,
 * the plan that is executed, and the plan that is stored one thing.
 */
import { asc, eq } from "drizzle-orm";
import { roleDefinitions } from "#/db/schema";
import {
	AGENDA_APPLIED_WHILE_OPEN_MESSAGE,
	AGENDA_EXPIRED_IN_LOCK_MESSAGE,
	AGENDA_MEETING_CANCELLED_IN_LOCK_MESSAGE,
	AGENDA_MEETING_LOCKED_IN_LOCK_MESSAGE,
	AGENDA_STILL_BLOCKED_MESSAGE,
	AGENDA_UNREADABLE_MESSAGE,
} from "#/lib/agenda-upsert";
import { zonedWallTimeToUtc } from "#/lib/datetime";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import { UPSERT_AGENDAS_TOOL } from "#/lib/pending-plan";
import { logActivity } from "#/server/activity";
import {
	type AgendaPlanClub,
	agendaPlanHash,
	plan,
} from "#/server/agenda-plan";
import {
	type AgendaAppliedSummary,
	parseAgendaPayload,
} from "#/server/agenda-plan-pending-schemas";
import { lockClubForWrite } from "#/server/club-write-lock";
import {
	type McpBlockingCode,
	type McpBlockingItem,
	McpError,
} from "#/server/mcp/errors";
import { applyPendingPlanLocked } from "#/server/mcp-pending-apply";
import { insertMeetingWithSlots } from "#/server/meeting-create-logic";
import { applyMeetingMetaPatch } from "#/server/meetings-logic";

export interface ApplyAgendaPlanInput {
	pendingId: string;
	club: AgendaPlanClub;
	/** The session user. Also the hash's `userId` — see `agendaPlanHash`. */
	userId: string;
	/** Credited with the writes; null for a read-write impersonating superadmin. */
	actorMemberId: string | null;
	/** The hash the page last rendered. */
	planHash: string;
}

export interface ApplyAgendaPlanResult extends AgendaAppliedSummary {
	/** Ids of the meetings this apply created, in plan order. */
	createdMeetingIds: string[];
	/** Ids of the meetings this apply changed, in plan order. */
	updatedMeetingIds: string[];
	/** Lines the plan carried that moved no field. Nothing was written for them. */
	unchanged: number;
}

/**
 * The in-lock refusal for a blocking item that appeared during the wait, in
 * PRECEDENCE order: the first code present picks the sentence. A meeting that
 * completed or was cancelled during the wait each get a sentence only this path
 * says, so a test can tell the in-lock refusal from the plan-time one. The
 * completed lock comes first; anything else gets `AGENDA_STILL_BLOCKED_MESSAGE`.
 */
const IN_LOCK_SENTENCES: readonly (readonly [McpBlockingCode, string])[] = [
	["MEETING_LOCKED", AGENDA_MEETING_LOCKED_IN_LOCK_MESSAGE],
	["MEETING_CANCELLED", AGENDA_MEETING_CANCELLED_IN_LOCK_MESSAGE],
];

export async function applyAgendaPlan(
	input: ApplyAgendaPlanInput,
): Promise<ApplyAgendaPlanResult> {
	return applyPendingPlanLocked<ApplyAgendaPlanResult>({
		pendingId: input.pendingId,
		tool: UPSERT_AGENDAS_TOOL,
		clubId: input.club.clubId,
		userId: input.userId,
		copy: {
			notFound: "That plan no longer exists.",
			// DELIBERATELY not the sentence the unlocked pre-check gives for a plan
			// that was already applied before the call started. The two used to read
			// identically on the guest book, and that made the locked guard
			// untestable: the cheap pre-check short-circuits every serial case, so
			// an assertion matching both sentences passed without this line ever
			// running. `src/lib/agenda-upsert.test.ts` asserts the pair differs.
			alreadyApplied: AGENDA_APPLIED_WHILE_OPEN_MESSAGE,
			expired: AGENDA_EXPIRED_IN_LOCK_MESSAGE,
		},
		apply: async (tx, row) => {
			// The club write lock (#925), before this body's first club or meeting
			// row lock. This apply both CREATES meetings — whose agenda read takes
			// the club row FOR SHARE (`startMeetingOnClubDefault`, #910) — and
			// UPDATES existing ones (`applyMeetingMetaPatch`'s UPDATE takes the
			// meeting's row lock).
			// A save-as-club-template locks a meeting and then the club row; with
			// both orders in play, a plan holding the club SHARE and waiting on
			// meeting M deadlocked against a save holding M and waiting on the
			// club. Taking this lock first serialises the two per club, as every
			// other writer that row-locks both already does.
			//
			// ADVISORY LOCK ORDER: the MCP apply lock (`mcp/lock.ts`, taken by
			// `applyPendingPlanLocked` before this body runs) and THEN this one.
			// Nothing takes the MCP lock after the club write lock, so the two
			// are always acquired in that one order.
			await lockClubForWrite(tx, input.club.clubId);

			// PARSE, do not trust the column's compile-time type. This read happens
			// inside the lock and its values reach `meetings` — a row written by a
			// previous release across a deploy boundary must refuse here rather
			// than be written half-understood.
			const payload = parseAgendaPayload(row.payload);
			if (!payload || payload.entriesUnreadable) {
				throw new McpError("BLOCKED", AGENDA_UNREADABLE_MESSAGE);
			}
			const entries = payload.entries ?? [];
			if (entries.length === 0) {
				throw new McpError(
					"BLOCKED",
					"This plan names no dates, so there is nothing to save.",
				);
			}

			const {
				plan: fresh,
				blocking,
				defaultMeetingMinutes,
			} = await plan(tx, input.club, entries);

			// Before the hash — see the module header. A blocking item is a
			// specific explanation; a hash mismatch is a generic one, and the
			// specific one should win when both are true.
			if (blocking.length > 0) {
				const sentence =
					IN_LOCK_SENTENCES.find(([code]) =>
						blocking.some((b) => b.code === code),
					)?.[1] ?? AGENDA_STILL_BLOCKED_MESSAGE;
				throw new McpError("BLOCKED", sentence, { blocking });
			}

			const freshHash = agendaPlanHash({
				clubId: input.club.clubId,
				userId: input.userId,
				plan: fresh,
			});
			if (freshHash !== input.planHash) {
				throw new McpError(
					"PLAN_STALE",
					"The club's calendar changed since this page was loaded. Check the refreshed plan and apply again.",
				);
			}

			// The role template, fetched ONCE for the whole batch and reused —
			// `applyBatchCreateMeetings`' precedent, and what keeps a 52-meeting
			// create from issuing 52 template reads inside the club lock. Skipped
			// entirely when the plan creates nothing.
			const creates = fresh.lines.filter((l) => l.action === "create");
			const defs =
				creates.length === 0
					? []
					: await tx
							.select()
							.from(roleDefinitions)
							// The club's whole BANK: `generateSlotRows` filters
							// `standing && enabled`, so a contest role is kept off an
							// ordinary meeting by DATA rather than by a predicate here
							// (#801).
							.where(eq(roleDefinitions.clubId, input.club.clubId))
							.orderBy(asc(roleDefinitions.sortOrder));

			// Execute THE PLAN, not the input.
			const createdMeetingIds: string[] = [];
			const updatedMeetingIds: string[] = [];
			const dates: string[] = [];
			let unchanged = 0;

			for (const line of fresh.lines) {
				if (line.action === "create") {
					const meetingId = await insertMeetingWithSlots(
						tx,
						{
							clubId: input.club.clubId,
							scheduledAt: zonedWallTimeToUtc(
								`${line.date}T${line.time}`,
								input.club.timezone,
							),
							// Not a field the caller supplies. Copy-at-insert from the
							// club default, the same source `applyBatchCreateMeetings`
							// uses.
							lengthMinutes: defaultMeetingMinutes,
							location: line.location,
							// ONE insert carrying the meta (AC7). An insert-then-patch
							// would log a `meeting_create` AND a `meeting_edit` for one
							// user action, and write the row twice.
							meta: line.meta,
						},
						defs,
					);
					// Null means the unique `(club_id, scheduled_at)` index refused
					// it: something created a meeting at that exact instant between
					// the re-plan and this insert. The club lock excludes other MCP
					// applies, not the browser or the read-triggered top-up. Refuse
					// the whole batch rather than report a create that did not
					// happen — the transaction rolls back on throw.
					if (!meetingId) {
						throw new McpError(
							"PLAN_STALE",
							`A meeting appeared on ${line.date} while this page was open. Check the refreshed plan and apply again.`,
						);
					}
					createdMeetingIds.push(meetingId);
					dates.push(line.date);
					// `meeting_create` has had an enum member and a formatter case
					// since #358 and NO writer — `applyBatchCreateMeetings` and the
					// top-up both log nothing. This is the first one (#808), and it
					// is inside the apply transaction so the row and its audit entry
					// commit together.
					await logActivity(tx, {
						clubId: input.club.clubId,
						actorMemberId: input.actorMemberId,
						action: "meeting_create",
						targetType: "meeting",
						targetId: meetingId,
						detail: {
							meetingId,
							date: line.date,
							// Not "mcp": the dates came from an MCP call but this write
							// is a session action by a named admin, and "mcp" would name
							// something that is no longer true.
							via: "agenda-plan-confirm",
						},
					});
					continue;
				}

				if (line.changes.length === 0) {
					// A line the caller named whose every field already matches. The
					// patch would drop every key and return without writing, so skip
					// it here and say so in the result rather than pretending.
					unchanged += 1;
					continue;
				}

				// ONLY the fields the diff moves. An omitted field is left alone by
				// `applyMeetingMetaPatch`, which is what keeps this tool from
				// clearing a Word of the Day it was never asked about (AC8).
				const patch: Record<string, string | null> = {};
				for (const change of line.changes) patch[change.field] = change.to;
				try {
					await applyMeetingMetaPatch(
						{
							meetingId: line.meetingId,
							actorMemberId: input.actorMemberId,
							...patch,
						},
						// `tx`, never `db`: this transaction already holds the club's
						// advisory lock, and a write on a second pooled connection would
						// neither be covered by it nor roll back with the batch.
						tx,
					);
				} catch (err) {
					// The club write lock does not exclude a cancel: `applyCancelMeeting`
					// locks only the meeting row. So a cancel can commit AFTER the
					// re-plan above and before this UPDATE, which then refuses it
					// (#1088). Report that as the same BLOCKED result the re-plan
					// gives, rather than as a thrown error the page cannot render; the
					// throw rolls back everything this batch already wrote. Compared by
					// identity with the exported sentence, never by substring.
					if (
						err instanceof Error &&
						err.message === MEETING_CANCELLED_MESSAGE
					) {
						const item: McpBlockingItem = {
							code: "MEETING_CANCELLED",
							entryIndex: line.index,
							message: MEETING_CANCELLED_MESSAGE,
							detail: { date: line.date, meetingId: line.meetingId },
						};
						throw new McpError(
							"BLOCKED",
							AGENDA_MEETING_CANCELLED_IN_LOCK_MESSAGE,
							{ blocking: [item] },
						);
					}
					throw err;
				}
				updatedMeetingIds.push(line.meetingId);
				dates.push(line.date);
			}

			return {
				result: {
					created: createdMeetingIds.length,
					updated: updatedMeetingIds.length,
					unchanged,
					dates,
					createdMeetingIds,
					updatedMeetingIds,
				},
				// The tombstone the skeleton writes beside `applied_at`. The dates
				// survive and the instructions do not: the applied page still says
				// what it did, and a re-opened link cannot be mistaken for something
				// still pending. Nothing here is personal data — unlike the guest
				// book, whose tombstone exists to stop contact details sitting at
				// rest — so what is dropped is dropped for clarity, not privacy.
				tombstone: {
					meetings: null,
					applied: {
						created: createdMeetingIds.length,
						updated: updatedMeetingIds.length,
						dates,
					},
				},
			};
		},
	});
}
