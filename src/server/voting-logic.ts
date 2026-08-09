/**
 * Digital voting DB logic (#510), split out from `voting.ts` (a createServerFn
 * module the guard test forbids from exporting db-touching functions).
 *
 * A vote SESSION is the window for one award category on one meeting. NULL
 * `closed_at` means open. The winner is NOT stored here — the Ballot Counter
 * confirms it into `meeting_awards` via the existing `setAward`.
 *
 * Authorization is the caller's job (`resolveVoteCounterAuthz`), matching how
 * `minutes-logic.ts` trusts its server fn's admin gate.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "#/db";
import { meetingVoteSessions } from "#/db/schema";
import { logActivity } from "./activity";
import { AWARD_CATEGORIES, type AwardCategory } from "./minutes-logic";

export interface VoteSessionState {
	isOpen: boolean;
	openedAt: Date | null;
	closedAt: Date | null;
}

export type VoteSessionStates = Record<AwardCategory, VoteSessionState>;

/** Every category's window state, whether or not a session row exists. */
export async function listVoteSessions(
	meetingId: string,
): Promise<VoteSessionStates> {
	const rows = await db
		.select()
		.from(meetingVoteSessions)
		.where(eq(meetingVoteSessions.meetingId, meetingId));
	const byCategory = new Map(rows.map((r) => [r.category, r]));
	const out = {} as VoteSessionStates;
	for (const category of AWARD_CATEGORIES) {
		const row = byCategory.get(category);
		out[category] = {
			isOpen: Boolean(row) && row?.closedAt == null,
			openedAt: row?.openedAt ?? null,
			closedAt: row?.closedAt ?? null,
		};
	}
	return out;
}

interface WindowInput {
	meetingId: string;
	clubId: string;
	category: AwardCategory;
	actorMemberId: string | null;
}

/**
 * Open (or re-open) a category's vote. Upserts on the (meeting, category)
 * unique index rather than inserting a second row, so re-opening after a close
 * restores the SAME session and every ballot already cast into it.
 */
export async function openVote(input: WindowInput): Promise<void> {
	await db.transaction(async (tx) => {
		await tx
			.insert(meetingVoteSessions)
			.values({
				meetingId: input.meetingId,
				category: input.category,
				openedByMemberId: input.actorMemberId,
			})
			.onConflictDoUpdate({
				target: [meetingVoteSessions.meetingId, meetingVoteSessions.category],
				set: {
					closedAt: null,
					openedAt: new Date(),
					openedByMemberId: input.actorMemberId,
					updatedAt: new Date(),
				},
			});
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId,
			action: "vote_open",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: { category: input.category },
		});
	});
}

/** Close a category's vote. A no-op when it was never opened or is already
 *  closed — closing is idempotent so a double-tap is harmless. */
export async function closeVote(input: WindowInput): Promise<void> {
	await db.transaction(async (tx) => {
		const closed = await tx
			.update(meetingVoteSessions)
			.set({ closedAt: new Date(), updatedAt: new Date() })
			.where(
				and(
					eq(meetingVoteSessions.meetingId, input.meetingId),
					eq(meetingVoteSessions.category, input.category),
					isNull(meetingVoteSessions.closedAt),
				),
			)
			.returning({ id: meetingVoteSessions.id });
		if (closed.length === 0) return;
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId,
			action: "vote_close",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: { category: input.category },
		});
	});
}

/**
 * Force-close every open vote on a meeting, inside a caller-supplied
 * transaction. Called by `applyCompleteMeeting` (#510) so a meeting that has
 * been closed out cannot still be voted on.
 *
 * Takes `tx` rather than opening its own, and does NOT route through
 * `closeVote`: the completion path sets `status = completed`, and `closeVote`'s
 * caller asserts the lock — so calling it here would throw on the very
 * transition that triggers it.
 */
export async function closeAllVotesTx(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	meetingId: string,
): Promise<void> {
	await tx
		.update(meetingVoteSessions)
		.set({ closedAt: sql`now()`, updatedAt: sql`now()` })
		.where(
			and(
				eq(meetingVoteSessions.meetingId, meetingId),
				isNull(meetingVoteSessions.closedAt),
			),
		);
}
