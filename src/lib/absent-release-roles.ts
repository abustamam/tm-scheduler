// The roles roll mode's Absent dialog lists, each carrying its own slot id (#1256).
//
// The dialog's list is also the release's CEILING: the ids sent with
// `releaseHeldRoles` are the ones the officer read, so a role the member is given
// before a replay drains is never freed by it. That makes label, speech title and
// slot id one record. They used to be zipped by index from `buildHeldRoleLabels`
// and a separate `slots.filter(...)`, which pairs a speech title with the wrong
// role the moment the two lists disagree in order or length.
//
// In `lib/` for the reason `held-role-labels.ts` gives: the route cannot mount in
// vitest, so a derivation left in it is covered by source greps alone.

import { buildRoleCounts, slotLabel } from "#/lib/agenda";

/** One role the member holds. */
export interface HeldRoleLine {
	slotId: string;
	/** NUMBERED ("Speaker 2"). */
	label: string;
	/** The attached speech's title, for a speaker slot that has one. */
	speechTitle: string | null;
}

/**
 * Group a meeting's assigned slots by member, one `HeldRoleLine` per slot, in the
 * payload's slot order. MUST be called with every slot, unfiltered: the numbering
 * comes from how many slots a role HAS (see `buildHeldRoleLabels`). Guest-held
 * slots (null `assigneeId`) are skipped.
 */
export function buildHeldRoleLines(
	slots: readonly {
		id: string;
		roleName: string;
		slotIndex: number;
		assigneeId: string | null;
		speechTitle?: string | null;
		slotsUnordered?: boolean;
	}[],
): Record<string, HeldRoleLine[]> {
	const roleCounts = buildRoleCounts(
		slots.map((s) => ({ roleName: s.roleName })),
	);
	const byMember: Record<string, HeldRoleLine[]> = {};
	for (const slot of slots) {
		if (!slot.assigneeId) continue;
		const line = {
			slotId: slot.id,
			label: slotLabel(slot, roleCounts),
			speechTitle: slot.speechTitle ?? null,
		};
		const held = byMember[slot.assigneeId];
		if (held) held.push(line);
		else byMember[slot.assigneeId] = [line];
	}
	return byMember;
}
