/**
 * `set_awards` — record and clear a meeting's ribbon winners (#1172, epic #771).
 *
 * Recording a meeting's minutes through an assistant used to stop at the
 * awards: the roles and the guests could be staged, and the three winners had
 * to be entered by hand. `get_agenda` returns the awards now (`awards`) so an
 * assistant can tell whether they are already recorded, and this writes them.
 *
 * ## It applies in the same call, like `assign_roles`
 *
 * Three rows at most, every id in the input came from `get_agenda` or
 * `find_people`, and a wrong winner is one tap to fix in the minutes. So no
 * `planHash`, no `mcp_pending_plans` row: the `plan` it returns is the account
 * of what changed, not something to approve. `src/lib/mcp-plan.ts` records this
 * tool beside `assign_roles` as the exemption.
 *
 * ## One transaction, or nothing
 *
 * The meeting row is locked `FOR NO KEY UPDATE` through the same helper the
 * lineup editors use, every problem across every entry is collected, and a
 * single one blocks the whole call. A half-recorded set of awards is worse
 * than a refused one: the caller is an LLM that will report success.
 *
 * ## What it refuses, and why each
 *
 *  - A meeting the "record" write class refuses: a CANCELLED one today. A
 *    COMPLETED one is accepted, because minutes are written after the meeting.
 *    `meetingRefusal(status, "record")` says which status refused, and the
 *    blocking item is chosen from that, never from a thrown sentence.
 *  - A category whose digital vote is still open, for a set AND a clear. The
 *    Ballot Counter owns the winner until the vote closes; a winner written
 *    under an open ballot is overwritten by, or contradicts, the tap that
 *    confirms the tally.
 *  - A candidate ruled out of the category (#786), through the same reader
 *    (`loadDisqualifications` + `disqualificationFor`) `setAward` uses.
 *  - A guest id that is not a guest of the meeting's club. That includes a
 *    guest staged by `record_guest_book`, which exists only once its confirm
 *    page is applied: this never resolves or mints a guest.
 *  - A write-in winner. The input has no write-in arm. Reads show an existing
 *    one (`get_agenda`), and `{clear: true}` removes it.
 *
 * ## Locks, in order, and what they close
 *
 *  1. The membership merge lock (#1035), SHARED, on every member the input
 *     names, BEFORE any row lock (`membership-merge-lock.ts` documents the
 *     order). A merge absorbing a winner would otherwise `on delete set null`
 *     the row recorded under it and leave a winner naming nobody under a
 *     success. A member absorbed while this waited is refused with
 *     `CLUB_BUSY_MESSAGE`. Only ids of THIS meeting's club that exist are
 *     locked: an unknown id, or a member of another club, is the
 *     `NOT_A_MEMBER` item below (and the lock helper would refuse an unknown
 *     one as absorbed).
 *  2. The meeting row, `FOR NO KEY UPDATE`.
 *
 * WHY ONLY THE MEETING'S CLUB. A merge collapses the absorbed Person's
 * memberships club by club and holds every exclusive lock to commit
 * (`mergePeople`, `collapseMemberships`). Shared locks on another club's
 * members, taken in uuid order before the club check, can cycle with it: clubs
 * A < B, absorbed memberships X (in A) and Y (in B) with Y < X by uuid. The tool
 * holds Y shared and waits for X, which the merge holds, while the merge waits
 * for Y in club B. A foreign or unknown id is never locked here, so that edge
 * does not exist and the call answers `NOT_A_MEMBER` without waiting.
 *
 * WITHIN the meeting's club no cycle is possible, so the uuid order need not
 * match the merge's. `collapseMemberships` takes the club write lock, then the
 * exclusive lock on the ABSORBED membership only (never the keeper's), and
 * `members_club_person_unique` allows one membership per Person per club: one
 * merge holds exactly one exclusive membership lock in this club. The club
 * write lock is held to commit, so no second merge holds an exclusive lock in
 * the same club at the same time. This tool takes no club write lock and holds
 * only shared advisory locks while it waits here. A cycle needs the merge to
 * wait for a lock this tool holds, and the only lock the merge asks for in this
 * club is its one exclusive lock: if this tool holds it shared, the merge waits
 * for this tool, which needs no lock the merge holds in this club (the other
 * member ids are not that merge's, and a second merge cannot hold one while
 * this one has the club) and runs on to its commit.
 *
 * Under the meeting lock, the rulings and the open-vote check are RACE-FREE, because both
 * are read through the transaction AFTER the meeting lock: `openVote` and
 * `disqualifyCandidate` / `undoDisqualification` take `FOR SHARE` on the
 * meeting row, which conflicts with this lock, so one of them either committed
 * before this read or waits until this commits.
 *
 * What remains is the web `setAward`, which takes no meeting lock: a winner it
 * records between this read of `from` and the write is overwritten (last write
 * wins), and the plan's `from` can be stale for that reason. Both sides are
 * human taps, and the next `get_agenda` shows what is there.
 *
 * ## The club comes from the MEETING
 *
 * `authorizeTokenForMeeting`, never a `clubId` in the input; this tool takes
 * none (`mcp-authz.guard.test.ts`).
 */
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { guests, members } from "#/db/schema";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import {
	assertMeetingAccepts,
	type FrozenMeetingStatus,
	MEETING_LOCKED_MESSAGE,
	meetingRefusal,
} from "#/lib/meeting-lifecycle";
import {
	disqualificationFor,
	loadDisqualifications,
} from "#/server/award-candidates-logic";
import { lockMeetingForSlotEdit } from "#/server/meeting-slot-lock";
import { lockMembershipsAgainstMerge } from "#/server/membership-merge-lock";
import {
	AWARD_CATEGORIES,
	type AwardCategory,
	type AwardWinner,
	deleteAwardRow,
	loadAwardRows,
	upsertAwardRow,
} from "#/server/minutes-logic";
import { listVoteSessions } from "#/server/voting-logic";
import { authorizeTokenForMeeting } from "../authz-logic";
import { type McpBlockingItem, McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

const awardCategory = z.enum(AWARD_CATEGORIES);

const awardSchema = z.union([
	z.object({ category: awardCategory, memberId: z.string().uuid() }).strict(),
	z.object({ category: awardCategory, guestId: z.string().uuid() }).strict(),
	z.object({ category: awardCategory, clear: z.literal(true) }).strict(),
]);

const inputSchema = {
	meetingId: z.string().uuid(),
	awards: z
		.array(awardSchema)
		.min(1)
		.max(AWARD_CATEGORIES.length)
		.describe(
			"One instruction per category: {category, memberId}, {category, " +
				"guestId} or {category, clear: true}. Ids come from get_agenda or " +
				"find_people. Categories: best_speaker, best_evaluator, " +
				"best_table_topics.",
		),
};

type Award = z.infer<typeof awardSchema>;

const CATEGORY_LABELS: Record<AwardCategory, string> = {
	best_speaker: "Best Speaker",
	best_evaluator: "Best Evaluator",
	best_table_topics: "Best Table Topics",
};

/** The winner an entry asks for, or null for a clear. */
type Target = { kind: "member" | "guest"; id: string } | null;

function targetOf(a: Award): Target {
	if ("memberId" in a) return { kind: "member", id: a.memberId };
	if ("guestId" in a) return { kind: "guest", id: a.guestId };
	return null;
}

/**
 * The blocking item for a status the "record" class refuses. Exhaustive over
 * the frozen statuses: a status added to the type fails the build here rather
 * than falling through to a sentence that names the wrong state.
 */
export function recordRefusalItem(
	refused: FrozenMeetingStatus,
): McpBlockingItem {
	switch (refused) {
		case "cancelled":
			return {
				code: "MEETING_CANCELLED",
				message: MEETING_CANCELLED_MESSAGE,
			};
		case "completed":
			// Unreachable while the "record" class accepts a completed meeting; here
			// so the day it stops, the caller reads the class's own sentence rather
			// than an INTERNAL error.
			return { code: "MEETING_LOCKED", message: MEETING_LOCKED_MESSAGE };
		default: {
			const unreachable: never = refused;
			throw new Error(`Unhandled refused status: ${String(unreachable)}`);
		}
	}
}

/** One plan line's `from` / `to`: names only, never contact details. */
function describeWinner(w: AwardWinner | null): string {
	return w
		? `${w.name} (${w.kind === "writeIn" ? "write-in" : w.kind})`
		: "none";
}

export const setAwardsTool: McpToolDefinition = {
	name: "set_awards",
	audience: "officer",
	config: {
		title: "Set awards",
		description:
			"Record or clear a meeting's award winners (Best Speaker, Best " +
			"Evaluator, Best Table Topics). Each entry names a category and either " +
			"a memberId, a guestId, or clear: true; ids come from get_agenda or " +
			"find_people. It APPLIES IMMEDIATELY, in the same call, and returns a " +
			"plan saying what each category was and is. The whole call applies or " +
			"none of it does. It refuses a cancelled meeting, a category whose " +
			"digital vote is still open, a candidate ruled out of the award, and a " +
			"guest that is not in the club yet; it cannot record a write-in " +
			"winner. get_agenda shows what is recorded.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club } = await authorizeTokenForMeeting(ctx, args.meetingId);
		const memberIds = [
			...new Set(
				args.awards.flatMap((a) => ("memberId" in a ? [a.memberId] : [])),
			),
		];

		return db.transaction(async (tx) => {
			const blocking: McpBlockingItem[] = [];

			// Lock order: the membership merge lock, then the meeting row. Only
			// members of THIS meeting's club that exist are locked: see the
			// header. A plain read, so it takes no row lock ahead of the lock it
			// is looked up for. `club.clubId` is the meeting's club (a meeting's
			// `club_id` is never rewritten), the same value `meeting.clubId` has
			// under the lock below.
			const existing =
				memberIds.length === 0
					? []
					: await tx
							.select({ id: members.id })
							.from(members)
							.where(
								and(
									inArray(members.id, memberIds),
									eq(members.clubId, club.clubId),
								),
							);
			await lockMembershipsAgainstMerge(
				tx,
				existing.map((r) => r.id),
			);

			const meeting = await lockMeetingForSlotEdit(tx, args.meetingId);
			// The write class's own policy, not a status check of this tool's: a
			// status the policy starts refusing is refused here too, with the
			// sentence for THAT status. `meetingRefusal` throws on a status it has
			// never heard of (fail closed), which the tool layer reports as INTERNAL.
			const refused = meetingRefusal(meeting.status, "record");
			if (refused !== null) blocking.push(recordRefusalItem(refused));

			// Decided from the input alone: two instructions about one category
			// means one of them was a mistake, and applying the later one silently
			// picks which.
			const firstIndexOf = new Map<AwardCategory, number>();
			for (const [index, a] of args.awards.entries()) {
				if (!firstIndexOf.has(a.category)) {
					firstIndexOf.set(a.category, index);
					continue;
				}
				blocking.push({
					code: "DUPLICATE_AWARD_CATEGORY",
					entryIndex: index,
					message: `${CATEGORY_LABELS[a.category]} is named more than once. Send one instruction per category.`,
					detail: { category: a.category },
				});
			}

			const guestIds = [
				...new Set(
					args.awards.flatMap((a) => ("guestId" in a ? [a.guestId] : [])),
				),
			];
			// The meeting's club, from the locked row. Any membership status: the
			// same rule as `requireMemberInMeetingClub`, which the minutes writer
			// applies, so a member who lapsed can still be recorded for a meeting
			// they won at.
			const memberRows =
				memberIds.length === 0
					? []
					: await tx
							.select({ id: members.id, name: members.name })
							.from(members)
							.where(
								and(
									inArray(members.id, memberIds),
									eq(members.clubId, meeting.clubId),
								),
							);
			const guestRows =
				guestIds.length === 0
					? []
					: await tx
							.select({ id: guests.id, name: guests.name })
							.from(guests)
							.where(
								and(
									inArray(guests.id, guestIds),
									eq(guests.clubId, meeting.clubId),
								),
							);
			const memberById = new Map(memberRows.map((r) => [r.id, r]));
			const guestById = new Map(guestRows.map((r) => [r.id, r]));

			// Both read through `tx`, AFTER the meeting lock: see the header.
			const votes = await listVoteSessions(args.meetingId, tx);
			const disqualified = await loadDisqualifications(args.meetingId, tx);

			for (const [index, a] of args.awards.entries()) {
				const label = CATEGORY_LABELS[a.category];
				const target = targetOf(a);

				// A set AND a clear: either one changes the winner the Ballot
				// Counter is about to confirm.
				if (votes[a.category].isOpen) {
					blocking.push({
						code: "VOTE_OPEN",
						entryIndex: index,
						message: `The ${label} vote is still open. Close it on the vote counter, or complete the meeting, then record the winner.`,
						detail: { category: a.category },
					});
				}

				if (!target) continue;

				let known = true;
				if (target.kind === "member" && !memberById.has(target.id)) {
					known = false;
					blocking.push({
						code: "NOT_A_MEMBER",
						entryIndex: index,
						message:
							"That member is not on this club's roster. find_people lists who can be recorded.",
						detail: { category: a.category, memberId: target.id },
					});
				}
				if (target.kind === "guest" && !guestById.has(target.id)) {
					known = false;
					blocking.push({
						code: "NOT_A_GUEST",
						entryIndex: index,
						message:
							"No guest with that id in this club. A guest staged by record_guest_book exists only once its confirm page is applied: apply it, then use find_people for the id.",
						detail: { category: a.category, guestId: target.id },
					});
				}

				if (known) {
					const ruledOut = disqualificationFor(
						disqualified,
						a.category,
						target,
					);
					if (ruledOut) {
						blocking.push({
							code: "AWARD_RULED_OUT",
							entryIndex: index,
							message: `That candidate was ruled out of this award: ${ruledOut.reason}`,
							detail: { category: a.category },
						});
					}
				}
			}

			// Nothing has been written, and nothing will be: the throw aborts the
			// transaction that holds the meeting lock.
			if (blocking.length > 0) {
				throw new McpError(
					"BLOCKED",
					`Nothing was changed — ${blocking.length} problem${blocking.length === 1 ? "" : "s"} to fix first.`,
					{ blocking },
				);
			}

			// The enforcement, apart from the explanation above: it throws for any
			// status the class refuses, so a refusal the switch in
			// `recordRefusalItem` or the blocking item missed still stops the call
			// before a write, as an INTERNAL error rather than a silent success. It
			// is the call `meeting-writers.guard.test.ts` reads as this tool's
			// "record" refusal. With `blocking` empty it cannot throw.
			assertMeetingAccepts(meeting.status, "record");

			const current = await loadAwardRows(tx, args.meetingId);

			const plan: {
				category: AwardCategory;
				from: string;
				to: string;
				unchanged: boolean;
			}[] = [];
			let recorded = 0;
			let cleared = 0;
			let unchanged = 0;

			for (const a of args.awards) {
				const target = targetOf(a);
				const row = current.get(a.category);
				const from = row?.winner ?? null;
				const to = target
					? {
							kind: target.kind,
							id: target.id,
							name:
								// Present: every unknown id blocked the call above.
								// biome-ignore lint/style/noNonNullAssertion: validated above
								(target.kind === "member"
									? memberById.get(target.id)
									: guestById.get(target.id))!.name,
						}
					: null;

				// Compared by identity, never by name: two people can share one.
				// A clear is unchanged only when there is NO row: a row naming nobody
				// (its member was deleted) is still a row, and the clear removes it.
				const same = to
					? from !== null && from.kind === to.kind && from.id === to.id
					: row === undefined;
				plan.push({
					category: a.category,
					from: describeWinner(from),
					to: describeWinner(to),
					unchanged: same,
				});
				// An unchanged line writes nothing, so `updated_at` does not move.
				if (same) {
					unchanged++;
					continue;
				}
				if (to) {
					await upsertAwardRow(tx, {
						meetingId: args.meetingId,
						category: a.category,
						memberId: to.kind === "member" ? to.id : null,
						guestId: to.kind === "guest" ? to.id : null,
						writeInName: null,
					});
					recorded++;
				} else {
					await deleteAwardRow(tx, {
						meetingId: args.meetingId,
						category: a.category,
					});
					cleared++;
				}
			}

			const parts: string[] = [];
			if (recorded > 0)
				parts.push(`Recorded ${recorded} award${recorded === 1 ? "" : "s"}`);
			if (cleared > 0)
				parts.push(`${parts.length ? "cleared" : "Cleared"} ${cleared}`);
			if (unchanged > 0)
				parts.push(
					`${parts.length ? "" : "Nothing changed: "}${unchanged} unchanged`,
				);

			return {
				applied: true,
				meetingId: args.meetingId,
				clubId: club.clubId,
				summary: `${parts.join(", ")}.`,
				plan,
			};
		});
	},
};
