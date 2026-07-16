import type { SeasonGridData } from "#/server/season-grid";

/** A role slot's state relative to the member whose cell is open. */
export type SlotState = "open" | "mine" | "other";

export interface RoleOption {
	slotId: string;
	label: string; // "Speaker 2"
	shortCode: string; // "SP2"
	sortOrder: number;
	isSpeakerRole: boolean;
	state: SlotState;
	/** Present when `state === "other"`: the current holder's display name (a
	 *  member, or a guest suffixed "· Guest"). Shown so bumping is an informed
	 *  click. */
	holderName?: string;
}

/** The mutation a click on a slot triggers, for the member whose cell is open:
 *  claim an open slot, release one they hold, or reassign one held by someone
 *  else (bumping them). */
export function slotAction(
	state: SlotState,
): "assign" | "release" | "reassign" {
	return state === "mine"
		? "release"
		: state === "other"
			? "reassign"
			: "assign";
}

/**
 * The meeting's role slots as pick options for one member's cell, in agenda
 * order. `state` (and `holderName`) are relative to `targetMemberId`. Pure —
 * derived entirely from the already-loaded grid data, so the picker needs no
 * extra fetch.
 */
export function meetingRoleOptions(
	data: SeasonGridData,
	meetingId: string,
	targetMemberId: string,
): RoleOption[] {
	const rowByKey = new Map(
		data.rows.map((r) => [`${r.roleDefinitionId}:${r.slotIndex}`, r]),
	);
	const memberName = new Map(data.memberNames.map((m) => [m.id, m.name]));
	const guestName = new Map(data.guestNames.map((g) => [g.id, g.name]));

	return data.cells
		.filter((c) => c.meetingId === meetingId)
		.map((c): RoleOption => {
			const row = rowByKey.get(`${c.roleDefinitionId}:${c.slotIndex}`);
			let state: SlotState;
			let holderName: string | undefined;
			if (c.memberId === targetMemberId) {
				state = "mine";
			} else if (c.memberId) {
				state = "other";
				holderName = memberName.get(c.memberId) ?? "—";
			} else if (c.guestId) {
				state = "other";
				holderName = `${guestName.get(c.guestId) ?? "—"} · Guest`;
			} else {
				state = "open";
			}
			return {
				slotId: c.slotId,
				label: row?.label ?? "role",
				shortCode: row?.shortCode ?? "?",
				sortOrder: row?.sortOrder ?? 999,
				isSpeakerRole: row?.isSpeakerRole ?? false,
				state,
				holderName,
			};
		})
		.sort(
			(a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label),
		);
}
