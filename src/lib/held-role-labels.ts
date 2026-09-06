// Which roles a member holds on ONE meeting, keyed by member (#663).
//
// The rail's decline now frees every one of them, so the confirm step has to
// NAME them before it happens — "This frees Toastmaster of the Day and
// Evaluator 2" — and that means a LIST per member, which the rail's existing
// `buildPanelRoleMap` (`#/lib/attendance-panel`) deliberately does not have:
// its `PanelRole` is one badge per member, first slot wins, because a 340px
// column has room for one code. Widening that map to serve this would make a
// shared derivation everyone's problem, so this is its own function.
//
// It lives in `lib/` rather than inline in `club.$clubId.meeting.$meetingId.tsx`
// for the reason `buildPanelRoleMap`'s own doc gives: that route cannot mount in
// vitest, so a derivation there is guarded by source greps alone — and both of
// the mutations that matter here pass every grep AND a clean typecheck. Keying
// by `s.id` instead of `s.assigneeId` produces an empty map (nobody is ever
// warned, the release lands silently, which is the whole bug this fix exists to
// close); dropping `roleCounts` renders "Evaluator" twice for two evaluator
// slots, so the officer cannot tell which roles they are about to free.

import { buildRoleCounts, slotLabel } from "#/lib/agenda";

/** What one member holds on this meeting. Absent from the map ⇒ they hold
 *  nothing, which is the "no confirm, write straight through" case. */
export interface HeldRoles {
	/** The assignee's name as the meeting payload resolved it. Null only if the
	 *  join produced none; the caller falls back to its own roster. */
	name: string | null;
	/** NUMBERED labels ("Evaluator 2"), in the slot order the payload arrives
	 *  in — which is the agenda's own order (`sortOrder`, then `slotIndex`), so
	 *  the dialog lists roles the way the officer just read them on the agenda.
	 *  Numbered, unlike the rail's badge and unlike the outreach draft's base
	 *  name: this sentence is about WHICH SLOTS are being emptied, and "Speaker"
	 *  when there are three of them does not say. */
	labels: string[];
}

/**
 * Group a meeting's assigned slots by member.
 *
 * MUST be called with every slot, unfiltered: `buildRoleCounts` decides
 * "Evaluator" vs "Evaluator 1" from how many slots the role HAS, so
 * `buildHeldRoleLabels(slots.filter(s => s.assigneeId))` would renumber the
 * labels as the week's slots fill. Guest-held slots carry a null `assigneeId`
 * and are skipped — a guest has no attendance rung to decline.
 */
export function buildHeldRoleLabels(
	slots: readonly {
		roleName: string;
		slotIndex: number;
		assigneeId: string | null;
		assigneeName: string | null;
	}[],
): Record<string, HeldRoles> {
	// A fresh array rather than a cast: `buildRoleCounts` takes a mutable `T[]`
	// and this parameter is `readonly`, and a cast to get past that is the kind
	// that silently survives the parameter changing shape.
	const roleCounts = buildRoleCounts(
		slots.map((s) => ({ roleName: s.roleName })),
	);
	const byMember: Record<string, HeldRoles> = {};
	for (const slot of slots) {
		if (!slot.assigneeId) continue;
		const held = byMember[slot.assigneeId];
		if (held) {
			// The FIRST slot's name is kept. Both rows name the same member, so this
			// only matters if the payload ever disagreed with itself.
			held.labels.push(slotLabel(slot, roleCounts));
			continue;
		}
		byMember[slot.assigneeId] = {
			name: slot.assigneeName,
			labels: [slotLabel(slot, roleCounts)],
		};
	}
	return byMember;
}
