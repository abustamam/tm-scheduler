// Club action-item DB logic (#529), split out from the `createServerFn`
// wrappers in `action-items.ts` — the server-modules guard forbids db-touching
// exports there, and a plain db-touching export in a server-fn module drags
// `#/db` → `pg` → `Buffer` into the browser bundle and white-screens the page.
//
// Every mutation is scoped by `clubId` in its WHERE clause rather than trusting
// the id alone, so a valid id from another club cannot be reached even if the
// authz layer above were bypassed.
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "#/db";
import { clubActionItems, members } from "#/db/schema";
import {
	ACTION_ITEM_READ_CAP,
	ACTION_ITEM_RENDER_CAPS,
} from "#/lib/action-item-limits";
import {
	type ActionItemFact,
	openAsOf,
	resolvedBetween,
} from "#/lib/action-items";

export type ActionItemResolution = "done" | "dropped";

export interface ActionItemRow extends ActionItemFact {
	id: string;
	text: string;
	ownerMemberId: string | null;
	/** Joined for display; null for an unowned item OR a departed owner. */
	ownerName: string | null;
	/** A calendar day ("YYYY-MM-DD"), not an instant — see the schema comment. */
	dueDate: string | null;
	resolution: ActionItemResolution | null;
}

/**
 * Action items for a club, oldest first, bounded by `ACTION_ITEM_READ_CAP`.
 *
 * The bound is not optional politeness: nothing prunes this table, so without it
 * every meeting-page load and every PDF render fetches and serializes a club's
 * entire history.
 */
export async function listActionItems(
	clubId: string,
): Promise<ActionItemRow[]> {
	const rows = await db
		.select({
			id: clubActionItems.id,
			text: clubActionItems.text,
			ownerMemberId: clubActionItems.ownerMemberId,
			ownerName: members.name,
			dueDate: clubActionItems.dueDate,
			createdAt: clubActionItems.createdAt,
			resolvedAt: clubActionItems.resolvedAt,
			resolution: clubActionItems.resolution,
		})
		.from(clubActionItems)
		// Scoped on the JOIN as well as the WHERE. `assertOwnerInClub` already
		// stops a cross-club owner being written, but a join condition that only
		// matches on id would happily print another club's member name if any
		// future writer, backfill or merge ever got it wrong.
		.leftJoin(
			members,
			and(
				eq(members.id, clubActionItems.ownerMemberId),
				eq(members.clubId, clubId),
			),
		)
		.where(eq(clubActionItems.clubId, clubId))
		.orderBy(asc(clubActionItems.createdAt))
		.limit(ACTION_ITEM_READ_CAP);

	return rows;
}

/**
 * The items open RIGHT NOW — what the meeting page shows before a meeting has
 * been completed, when "what do we still owe the club" is the live question.
 *
 * Goes through `openAsOf` rather than a second hand-written predicate so
 * "which items are open" has exactly one definition. Two copies of that rule is
 * the shape that makes a cross-surface disagreement invisible to any test which
 * compares the surfaces to each other.
 */
export async function listOpenActionItems(
	clubId: string,
): Promise<ActionItemRow[]> {
	const rows = await listActionItems(clubId);
	return openAsOf(rows, new Date()).slice(0, ACTION_ITEM_RENDER_CAPS.rows);
}

/** Reject an owner who is not a member of this club. */
async function assertOwnerInClub(clubId: string, ownerMemberId: string) {
	const [row] = await db
		.select({ id: members.id })
		.from(members)
		.where(and(eq(members.id, ownerMemberId), eq(members.clubId, clubId)))
		.limit(1);
	if (!row) throw new Error("That member is not in this club.");
}

export async function createActionItem(input: {
	clubId: string;
	text: string;
	ownerMemberId?: string | null;
	dueDate?: string | null;
}): Promise<string> {
	if (input.ownerMemberId) {
		await assertOwnerInClub(input.clubId, input.ownerMemberId);
	}
	const [row] = await db
		.insert(clubActionItems)
		.values({
			clubId: input.clubId,
			text: input.text,
			ownerMemberId: input.ownerMemberId ?? null,
			dueDate: input.dueDate ?? null,
		})
		.returning({ id: clubActionItems.id });
	if (!row) throw new Error("Failed to create the action item.");
	return row.id;
}

export async function updateActionItem(input: {
	clubId: string;
	id: string;
	text: string;
	ownerMemberId: string | null;
	dueDate: string | null;
}): Promise<void> {
	if (input.ownerMemberId) {
		await assertOwnerInClub(input.clubId, input.ownerMemberId);
	}
	const updated = await db
		.update(clubActionItems)
		.set({
			text: input.text,
			ownerMemberId: input.ownerMemberId,
			dueDate: input.dueDate,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(clubActionItems.id, input.id),
				eq(clubActionItems.clubId, input.clubId),
				// Open items only. A closed item's text is already printed in every
				// minutes document issued since it closed, so editing it in place
				// rewrites history the same way a moved `resolvedAt` would. Reopen it
				// first if it genuinely needs correcting.
				isNull(clubActionItems.resolvedAt),
			),
		)
		.returning({ id: clubActionItems.id });
	if (updated.length === 0) {
		throw new Error("Action item not found, or already closed.");
	}
}

/**
 * Close an item. `resolvedAt` and `resolution` are always written together —
 * the database check constraint refuses the half-closed row that would
 * otherwise render in neither the open list nor the resolved list.
 */
export async function resolveActionItem(input: {
	clubId: string;
	id: string;
	resolution: ActionItemResolution;
}): Promise<void> {
	const updated = await db
		.update(clubActionItems)
		.set({
			resolvedAt: new Date(),
			resolution: input.resolution,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(clubActionItems.id, input.id),
				eq(clubActionItems.clubId, input.clubId),
				isNull(clubActionItems.resolvedAt),
			),
		)
		.returning({ id: clubActionItems.id });
	if (updated.length === 0) {
		throw new Error("Action item not found, or already resolved.");
	}
}

/**
 * Reopen a closed item, clearing both fields together.
 *
 * Club-scoped in the WHERE like every other mutation here, so an admin of one
 * club cannot reach another club's item with a guessed id.
 */
export async function reopenActionItem(input: {
	clubId: string;
	id: string;
}): Promise<void> {
	const updated = await db
		.update(clubActionItems)
		.set({ resolvedAt: null, resolution: null, updatedAt: new Date() })
		.where(
			and(
				eq(clubActionItems.id, input.id),
				eq(clubActionItems.clubId, input.clubId),
			),
		)
		.returning({ id: clubActionItems.id });
	if (updated.length === 0) throw new Error("Action item not found.");
}

export async function deleteActionItem(input: {
	clubId: string;
	id: string;
}): Promise<void> {
	const deleted = await db
		.delete(clubActionItems)
		.where(
			and(
				eq(clubActionItems.id, input.id),
				eq(clubActionItems.clubId, input.clubId),
			),
		)
		.returning({ id: clubActionItems.id });
	if (deleted.length === 0) throw new Error("Action item not found.");
}

export interface MinutesActionItems {
	/** Open as of the meeting instant, oldest first. Capped — see `openTotal`. */
	open: ActionItemRow[];
	/** Resolved since the previous meeting, most recent first. Capped. */
	resolved: ActionItemRow[];
	/**
	 * How many items each list would hold uncapped, so a renderer can say
	 * "+N more" honestly without being handed the rows to count.
	 *
	 * Saturates at `ACTION_ITEM_READ_CAP`, which is the point of that cap.
	 */
	openTotal: number;
	resolvedTotal: number;
}

/**
 * The action items a MEETING'S MINUTES must show, reconstructed from
 * timestamps rather than from current state.
 *
 * This is the correctness heart of the feature. Minutes are a historical
 * record; "what is open" is a live query. Rendering live state into minutes
 * means March's minutes show April's answer, and regenerating last year's
 * minutes produces something that was never true. Selecting by
 * `createdAt`/`resolvedAt` against the meeting instant makes a past meeting
 * render identically today, next month and next year.
 *
 * `previousMeetingAt` is null for a club's first minutes, which opens the
 * resolved window at the beginning of time rather than returning nothing.
 *
 * Both lists are row-capped HERE rather than in each renderer, so the PDF, the
 * meeting page, the server-fn payload and the offline snapshot all inherit one
 * bound. Capping in the renderer alone leaves the pipeline feeding it unbounded,
 * which is the shape that made #519's cap fail to bound anything.
 */
export async function loadActionItemsForMinutes(input: {
	clubId: string;
	meetingAt: Date;
	previousMeetingAt: Date | null;
}): Promise<MinutesActionItems> {
	const all = await listActionItems(input.clubId);
	const open = openAsOf(all, input.meetingAt);
	const resolved = resolvedBetween(
		all,
		input.previousMeetingAt,
		input.meetingAt,
	);
	return {
		open: open.slice(0, ACTION_ITEM_RENDER_CAPS.rows),
		resolved: resolved.slice(0, ACTION_ITEM_RENDER_CAPS.rows),
		openTotal: open.length,
		resolvedTotal: resolved.length,
	};
}
