import { describe, expect, it } from "vitest";
import {
	CLEARABLE_ASK,
	clearFloor,
	SELF_SERVICE_RUNGS,
} from "#/server/attendance-plan-logic";

/**
 * `clearFloor` is the whole decision behind `clearPlannedAttendance`'s
 * `onlyFrom`: which rungs the caller's "No answer" may delete. Pure, so every
 * arm x self/other cell is asserted here without a database; the integration
 * suite beside `clearPlanStatus` proves what each floor does to a real row.
 */
describe("clearFloor", () => {
	const ME = "member-me";
	const OTHER = "member-other";
	const sorted = (rungs: readonly string[]) => [...rungs].sort();

	it("officer clearing their OWN row: their answer and the ask", () => {
		expect(
			sorted(clearFloor({ via: "officer", actorMemberId: ME, memberId: ME })),
		).toEqual(["coming", "not_coming", "reached_out"]);
	});

	it("officer clearing SOMEONE ELSE's row: only the ask (#573)", () => {
		expect(
			clearFloor({ via: "officer", actorMemberId: ME, memberId: OTHER }),
		).toEqual(CLEARABLE_ASK);
	});

	it("an impersonating superadmin (no member row) is never 'self'", () => {
		// `actorMemberId` is null on the synthetic effective-admin; no subject id
		// can equal it.
		expect(
			clearFloor({ via: "officer", actorMemberId: null, memberId: ME }),
		).toEqual(CLEARABLE_ASK);
	});

	it.each([
		"tmod",
		"self",
	] as const)("%s arm keeps the self-service floor, on their own row and on another's", (via) => {
		expect(clearFloor({ via, actorMemberId: ME, memberId: ME })).toEqual(
			SELF_SERVICE_RUNGS,
		);
		expect(clearFloor({ via, actorMemberId: ME, memberId: OTHER })).toEqual(
			SELF_SERVICE_RUNGS,
		);
	});

	it("a non-officer arm never gets the ask, even when actor equals subject", () => {
		// The self test is gated on `via`: only the officer arm's actor is the
		// session's own membership. Elsewhere `actorMemberId` can be asserted.
		for (const via of ["tmod", "self"] as const) {
			expect(
				clearFloor({ via, actorMemberId: ME, memberId: ME }),
			).not.toContain("reached_out");
		}
	});
});
