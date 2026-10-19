import { describe, expect, it } from "vitest";
import { buildHeldRoleLines } from "#/lib/absent-release-roles";

const slot = (
	id: string,
	roleName: string,
	slotIndex: number,
	assigneeId: string | null,
	speechTitle: string | null = null,
) => ({ id, roleName, slotIndex, assigneeId, speechTitle });

describe("buildHeldRoleLines (#1256)", () => {
	it("a speech title lands on its own role when a non-speech role is listed before it", () => {
		// protects=the dialog line for "Speaker 2" carries Speaker 2's title and slot
		//   id even though the member's Timer (no speech) comes first in the payload
		// fails_when=titles are paired to labels by position in a separately filtered
		//   list, or the slot id comes from another slot
		// no_claim=the dialog's wording (absent-release-dialog.test.tsx)
		const lines = buildHeldRoleLines([
			slot("t", "Timer", 0, "m1"),
			slot("o", "Speaker", 0, "m2", "Not mine"),
			slot("s", "Speaker", 1, "m1", "Ice Breaker"),
		]);

		expect(lines.m1).toEqual([
			{ slotId: "t", label: "Timer", speechTitle: null },
			{ slotId: "s", label: "Speaker 2", speechTitle: "Ice Breaker" },
		]);
		expect(lines.m2).toEqual([
			{ slotId: "o", label: "Speaker 1", speechTitle: "Not mine" },
		]);
	});

	it("skips guest-held slots and members holding nothing", () => {
		// protects=a null assignee is not a key, so an absent member falls through to
		//   the direct write
		// fails_when=null assignees are grouped under "null"
		// no_claim=none beyond protects
		const lines = buildHeldRoleLines([slot("g", "Timer", 0, null)]);
		expect(lines).toEqual({});
	});
});
