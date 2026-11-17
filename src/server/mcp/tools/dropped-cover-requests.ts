/**
 * The open cover requests a slot removal drops (#1640).
 *
 * `slot_cover_requests.slot_id` cascades, so removing an open slot deletes the
 * request a member left on it (finding_cover or dropped, with the undo data).
 * The cascade stays; what the MCP slot tools owed the user was to SAY so in the
 * preview and to bind it into the plan hash. Only OPEN requests
 * (`covered_at IS NULL`) are listed: a covered one records a finished handoff.
 */
import { and, asc, inArray, isNull } from "drizzle-orm";
import { members, slotCoverRequests } from "#/db/schema";
import type { DbOrTx } from "#/server/meeting-templates-logic";

export type DroppedCoverRequest = {
	slotId: string;
	kind: "finding_cover" | "dropped";
	/** Display name of who released the slot, or null when that member is gone. */
	releasedByName: string | null;
	/** The slot's readable name ("Speaker 2"). */
	slotLabel: string;
	/** Readable on its own: the plan is what the user is shown. */
	note: string;
};

/** Open cover requests on `slotIds`, in slot id order. `label` names a slot for
 *  the note ("Speaker 2"). */
export async function loadOpenCoverRequests(
	conn: DbOrTx,
	slotIds: string[],
	label: (slotId: string) => string,
): Promise<DroppedCoverRequest[]> {
	if (slotIds.length === 0) return [];
	const rows = await conn
		.select({
			slotId: slotCoverRequests.slotId,
			kind: slotCoverRequests.kind,
			releasedByMemberId: slotCoverRequests.releasedByMemberId,
		})
		.from(slotCoverRequests)
		.where(
			and(
				inArray(slotCoverRequests.slotId, slotIds),
				isNull(slotCoverRequests.coveredAt),
			),
		)
		.orderBy(asc(slotCoverRequests.slotId), asc(slotCoverRequests.id));
	if (rows.length === 0) return [];
	const ids = [
		...new Set(
			rows.flatMap((r) => (r.releasedByMemberId ? [r.releasedByMemberId] : [])),
		),
	];
	const names =
		ids.length > 0
			? await conn
					.select({ id: members.id, name: members.name })
					.from(members)
					.where(inArray(members.id, ids))
			: [];
	return rows.map((r) => {
		const releasedByName =
			names.find((n) => n.id === r.releasedByMemberId)?.name ?? null;
		const who = releasedByName ?? "a member who is no longer in the club";
		return {
			slotId: r.slotId,
			kind: r.kind,
			releasedByName,
			slotLabel: label(r.slotId),
			note:
				r.kind === "finding_cover"
					? `${label(r.slotId)} has an open request from ${who} for someone to cover it. Removing the slot deletes that request.`
					: `${label(r.slotId)} was dropped by ${who} and is waiting for someone to take it. Removing the slot deletes that open request.`,
		};
	});
}
