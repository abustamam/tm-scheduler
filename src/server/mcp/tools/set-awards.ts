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
 *  - A CANCELLED meeting. A COMPLETED one is accepted: minutes are written
 *    after the meeting, which is the "record" write class
 *    (`assertMeetingAccepts(status, "record")`).
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
 * ## The check-then-write window is accepted
 *
 * Disqualification is read on the global client before the transaction, and a
 * vote can open between the read of its session and the write. That is the
 * trade `setAward` documents (`minutes-logic.ts`, "CHECK-THEN-WRITE"): a ruling
 * committed in the window is missed because a statement inside the transaction
 * would see the same thing under READ COMMITTED, and both sides of the window
 * are human taps. No lock is added for it here either.
 *
 * ## The club comes from the MEETING
 *
 * `authorizeTokenForMeeting`, never a `clubId` in the input; this tool takes
 * none (`mcp-authz.guard.test.ts`).
 */
import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "#/db";
import { guests, meetingAwards, members } from "#/db/schema";
import {
	isMeetingCancelled,
	MEETING_CANCELLED_MESSAGE,
} from "#/lib/meeting-cancellation-notice";
import {
	disqualificationFor,
	loadDisqualifications,
} from "#/server/award-candidates-logic";
import { lockMeetingForSlotEdit } from "#/server/meeting-slot-lock";
import {
	AWARD_CATEGORIES,
	type AwardCategory,
	deleteAwardRow,
	upsertAwardRow,
} from "#/server/minutes-logic";
import { listVoteSessions } from "#/server/voting-logic";
import { authorizeTokenForMeeting } from "../authz-logic";
import { type McpBlockingItem, McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

const awardCategory = z.enum([
	"best_speaker",
	"best_evaluator",
	"best_table_topics",
]);

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

/** What a category's row held when the call locked the meeting. */
interface CurrentWinner {
	kind: "member" | "guest" | "writeIn";
	/** The member or guest id; null for a write-in. */
	id: string | null;
	name: string;
}

/** One plan line's `from` / `to`: names only, never contact details. */
function describeWinner(w: { kind: string; name: string } | null): string {
	return w
		? `${w.name} (${w.kind === "writeIn" ? "write-in" : w.kind})`
		: "none";
}

export const setAwardsTool: McpToolDefinition = {
	name: "set_awards",
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
		// Read before the transaction opens, as `setAward` does: it needs nothing
		// from it, and a second pooled connection taken while this one holds the
		// meeting lock is how a pool runs dry.
		const disqualified = await loadDisqualifications(args.meetingId);

		return db.transaction(async (tx) => {
			const blocking: McpBlockingItem[] = [];

			const meeting = await lockMeetingForSlotEdit(tx, args.meetingId);
			if (isMeetingCancelled(meeting.status)) {
				blocking.push({
					code: "MEETING_CANCELLED",
					message: MEETING_CANCELLED_MESSAGE,
				});
			}

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

			const memberIds = [
				...new Set(
					args.awards.flatMap((a) => ("memberId" in a ? [a.memberId] : [])),
				),
			];
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

			const votes = await listVoteSessions(args.meetingId, tx);

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

			const current = await loadCurrentWinners(tx, args.meetingId);

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
				const from = current.get(a.category) ?? null;
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
				const same = to
					? from !== null && from.kind === to.kind && from.id === to.id
					: from === null;
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

/**
 * Each category's current winner, read inside the transaction. Null (absent)
 * for an unrecorded category, and for a row whose member was deleted
 * (`member_id` is `ON DELETE SET NULL`), which names nobody.
 */
async function loadCurrentWinners(
	tx: Parameters<Parameters<(typeof db)["transaction"]>[0]>[0],
	meetingId: string,
): Promise<Map<AwardCategory, CurrentWinner>> {
	const awMember = alias(members, "aw_member");
	const awGuest = alias(guests, "aw_guest");
	const rows = await tx
		.select({
			category: meetingAwards.category,
			memberId: meetingAwards.memberId,
			guestId: meetingAwards.guestId,
			writeInName: meetingAwards.writeInName,
			memberName: awMember.name,
			guestName: awGuest.name,
		})
		.from(meetingAwards)
		.leftJoin(awMember, eq(awMember.id, meetingAwards.memberId))
		.leftJoin(awGuest, eq(awGuest.id, meetingAwards.guestId))
		.where(eq(meetingAwards.meetingId, meetingId));
	const out = new Map<AwardCategory, CurrentWinner>();
	for (const r of rows) {
		if (r.memberId && r.memberName) {
			out.set(r.category, {
				kind: "member",
				id: r.memberId,
				name: r.memberName,
			});
		} else if (r.guestId && r.guestName) {
			out.set(r.category, { kind: "guest", id: r.guestId, name: r.guestName });
		} else if (r.writeInName) {
			out.set(r.category, { kind: "writeIn", id: null, name: r.writeInName });
		}
	}
	return out;
}
