import { describe, expect, it } from "vitest";
import {
	CLEARABLE_ASK,
	clearFloor,
	NO_CLEARABLE_RUNGS,
	SELF_SERVICE_RUNGS,
} from "#/server/attendance-plan-logic";

/**
 * `clearFloor` is the whole decision behind `clearPlannedAttendance`'s
 * `onlyFrom`: which rungs the caller's "No answer" may delete. Pure, so every
 * arm x self/other cell is asserted here without a database; the integration
 * suite beside `clearPlanStatus` proves what each floor does to a real row.
 *
 * The rule: a member's ANSWER is cleared by that member, or by an officer acting
 * deliberately on the season grid (not through this floor), and by nobody else.
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

	// protects=the Toastmaster clears their OWN answer and nothing else on their own row; fails_when=the own-row test is inverted or dropped so the Toastmaster loses the self-service clear, or gains the ask; no_claim=who the caller IS (resolveActor's job)
	it("tmod arm clearing their OWN row: the self-service floor", () => {
		expect(
			clearFloor({ via: "tmod", actorMemberId: ME, memberId: ME }),
		).toEqual(SELF_SERVICE_RUNGS);
	});

	// protects=the Toastmaster's clear of ANOTHER member's row deletes no rung; fails_when=that floor goes back to SELF_SERVICE_RUNGS (another member's coming/not_coming erasable) or widens to the ask; no_claim=none beyond protects
	it("tmod arm clearing SOMEONE ELSE's row: nothing at all", () => {
		const floor = clearFloor({
			via: "tmod",
			actorMemberId: ME,
			memberId: OTHER,
		});
		expect(floor).toEqual(NO_CLEARABLE_RUNGS);
		expect(floor).toHaveLength(0);
	});

	it("a tmod arm with no actor (null) is never 'self'", () => {
		expect(
			clearFloor({ via: "tmod", actorMemberId: null, memberId: ME }),
		).toEqual(NO_CLEARABLE_RUNGS);
	});

	it("self arm keeps the self-service floor", () => {
		// `resolveActor` throws SELF_ONLY_MESSAGE unless the self arm's actor is the
		// subject, so this arm only ever reaches the floor on its own row.
		expect(
			clearFloor({ via: "self", actorMemberId: ME, memberId: ME }),
		).toEqual(SELF_SERVICE_RUNGS);
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

	it("the empty floor is a distinct constant that deletes nothing", () => {
		expect(NO_CLEARABLE_RUNGS).toEqual([]);
		for (const rung of ["coming", "not_coming", "reached_out"] as const) {
			expect(NO_CLEARABLE_RUNGS).not.toContain(rung);
		}
	});
});
