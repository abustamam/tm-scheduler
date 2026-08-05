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
	dueDate: Date | null;
	resolution: ActionItemResolution | null;
}

/** Every action item for a club, oldest first. */
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
		.leftJoin(members, eq(members.id, clubActionItems.ownerMemberId))
		.where(eq(clubActionItems.clubId, clubId))
		.orderBy(asc(clubActionItems.createdAt));

	return rows;
}

/** The open items only — what the meeting page and the admin route lead with. */
export async function listOpenActionItems(
	clubId: string,
): Promise<ActionItemRow[]> {
	const rows = await listActionItems(clubId);
	return rows.filter((r) => r.resolvedAt === null);
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
	dueDate?: Date | null;
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
	dueDate: Date | null;
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
			and(eq(clubActionItems.id, input.id), eq(clubActionItems.clubId, input.clubId)),
		)
		.returning({ id: clubActionItems.id });
	if (updated.length === 0) throw new Error("Action item not found.");
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

/** Reopen a closed item, clearing both fields together. */
export async function reopenActionItem(input: {
	clubId: string;
	id: string;
}): Promise<void> {
	const updated = await db
		.update(clubActionItems)
		.set({ resolvedAt: null, resolution: null, updatedAt: new Date() })
		.where(
			and(eq(clubActionItems.id, input.id), eq(clubActionItems.clubId, input.clubId)),
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
			and(eq(clubActionItems.id, input.id), eq(clubActionItems.clubId, input.clubId)),
		)
		.returning({ id: clubActionItems.id });
	if (deleted.length === 0) throw new Error("Action item not found.");
}

export interface MinutesActionItems {
	/** Open as of the meeting instant, oldest first. */
	open: ActionItemRow[];
	/** Resolved since the previous meeting, most recent first. */
	resolved: ActionItemRow[];
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
 */
export async function loadActionItemsForMinutes(input: {
	clubId: string;
	meetingAt: Date;
	previousMeetingAt: Date | null;
}): Promise<MinutesActionItems> {
	const all = await listActionItems(input.clubId);
	return {
		open: openAsOf(all, input.meetingAt),
		resolved: resolvedBetween(all, input.previousMeetingAt, input.meetingAt),
	};
}
