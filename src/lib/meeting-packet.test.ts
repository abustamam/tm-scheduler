import { describe, expect, it } from "vitest";
import {
	clampPosterCopies,
	DEFAULT_WORD_POSTER_COPIES,
	defaultPacketSelection,
	PACKET_PIECES,
	packetPageCount,
	WORD_POSTER_COPIES,
} from "./meeting-packet";

/** A club running everything, so each test turns exactly one thing off. */
const ALL_ROLES = [
	{ key: "timer", name: "Timer" },
	{ key: "ah_counter", name: "Ah-Counter" },
	{ key: "grammarian", name: "Grammarian" },
	{ key: "vote_counter", name: "Vote Counter" },
	{ key: "general_evaluator", name: "General Evaluator" },
];
const ctx = (
	over: Partial<Parameters<typeof defaultPacketSelection>[0]> = {},
) =>
	defaultPacketSelection({
		roles: ALL_ROLES,
		usesDigitalVoting: false,
		hasWord: true,
		...over,
	});

describe("defaultPacketSelection", () => {
	it("offers every piece to a club that runs every role", () => {
		expect(ctx()).toEqual([
			"word-poster",
			"timer",
			"ah-counter",
			"grammarian",
			"ballot-counter",
			"general-evaluator",
		]);
	});

	/**
	 * The first of the two cases that decided this feature: "our club doesn't
	 * have general evaluator yet so we don't want that either". No configuration
	 * — the club's role slots already say so.
	 */
	it("drops a sheet whose role the club does not run", () => {
		const roles = ALL_ROLES.filter((r) => r.key !== "general_evaluator");
		expect(ctx({ roles })).not.toContain("general-evaluator");
		// …and keeps everything else, so this is a narrowing rather than a reset.
		expect(ctx({ roles })).toContain("timer");
	});

	/**
	 * The second: "we have digital voting -- we dont need ballot counter tally.
	 * But it's good to have for clubs that don't do digital voting."
	 *
	 * Both halves asserted, because dropping it unconditionally would satisfy
	 * the first half and break the second — which is the whole reason this is a
	 * derivation and not a deletion.
	 */
	it("drops the ballot tally for a club using digital voting, and keeps it otherwise", () => {
		expect(ctx({ usesDigitalVoting: true })).not.toContain("ballot-counter");
		expect(ctx({ usesDigitalVoting: false })).toContain("ballot-counter");
	});

	it("does not resurrect the tally for a club that runs no Vote Counter", () => {
		// The digital-voting rule only ever REMOVES. A club with no such role gets
		// no sheet whether it votes on paper or not.
		const roles = ALL_ROLES.filter((r) => r.key !== "vote_counter");
		expect(ctx({ roles, usesDigitalVoting: false })).not.toContain(
			"ballot-counter",
		);
	});

	it("omits the poster when the meeting has no word", () => {
		// A poster of nothing is a blank sheet.
		expect(ctx({ hasWord: false })).not.toContain("word-poster");
	});

	it("puts the poster first — it goes on the wall before anything else", () => {
		expect(ctx()[0]).toBe("word-poster");
	});

	it("offers nothing to a club running no roles and no word", () => {
		expect(ctx({ roles: [], hasWord: false })).toEqual([]);
	});
});

describe("clampPosterCopies", () => {
	it("defaults to three, the number that was actually asked for", () => {
		// "3 pieces of paper that have the same thing, so we can put it in various
		// places of the meeting room" — a property of the room, not the roster.
		expect(DEFAULT_WORD_POSTER_COPIES).toBe(3);
	});

	it("bounds the count, because copies multiply pages on a synchronous render", () => {
		expect(clampPosterCopies(9999)).toBe(WORD_POSTER_COPIES.max);
		expect(clampPosterCopies(-5)).toBe(WORD_POSTER_COPIES.min);
		// An absolute ceiling, not a comparison with the constant it guards: the
		// latter passes for every value including one that reintroduces the cost.
		expect(WORD_POSTER_COPIES.max).toBeLessThanOrEqual(20);
	});

	it("survives the values a query string can actually carry", () => {
		// Non-finite falls back to the DEFAULT, not to the max. Both are "safe" in
		// the render-cost sense, but they differ in what the user gets: a garbled
		// `?copies=` should print the three sheets they expected, not twelve.
		expect(clampPosterCopies(Number.NaN)).toBe(DEFAULT_WORD_POSTER_COPIES);
		expect(clampPosterCopies(Number.POSITIVE_INFINITY)).toBe(
			DEFAULT_WORD_POSTER_COPIES,
		);
		// A finite over-large number IS a real request, so it clamps rather than
		// resetting — the distinction is deliberate.
		expect(clampPosterCopies(9999)).toBe(WORD_POSTER_COPIES.max);
		expect(clampPosterCopies(2.9)).toBe(2);
	});
});

describe("packetPageCount", () => {
	it("counts one page per sheet plus one per poster copy", () => {
		expect(packetPageCount(["word-poster", "timer", "grammarian"], 3)).toBe(5);
	});

	it("ignores the copy count when the poster is not selected", () => {
		expect(packetPageCount(["timer"], 12)).toBe(1);
	});

	it("bounds the total through the same clamp the renderer uses", () => {
		expect(packetPageCount(["word-poster"], 9999)).toBe(WORD_POSTER_COPIES.max);
	});
});

describe("PACKET_PIECES", () => {
	it("offers the poster plus every role sheet, with no duplicates", () => {
		const keys = PACKET_PIECES.map((p) => p.key);
		expect(keys).toContain("word-poster");
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys).toHaveLength(6);
	});
});

/**
 * Roles with a NULL key — a genuinely custom club role, and every role
 * definition predating the #368 key backfill.
 *
 * A key-only match looks correct and silently tells such a club it runs no
 * Timer, so the packet opens with the Timer's log unticked. This is the same
 * key-or-name rule `matchesRole` uses; the test exists because the seeded
 * fixture in `packet-pdf.integration.test.ts` has exactly this shape and
 * caught it.
 */
describe("defaultPacketSelection with unkeyed roles", () => {
	it("matches on NAME when a role definition carries no key", () => {
		expect(
			defaultPacketSelection({
				roles: [{ key: null, name: "Timer" }],
				usesDigitalVoting: false,
				hasWord: false,
			}),
		).toEqual(["timer"]);
	});

	it("matches a name case-insensitively, as matchesRole does", () => {
		expect(
			defaultPacketSelection({
				roles: [{ key: null, name: "ah-COUNTER" }],
				usesDigitalVoting: false,
				hasWord: false,
			}),
		).toEqual(["ah-counter"]);
	});

	it("prefers the key when there is one, so a renamed role still matches", () => {
		// A club that renamed Timer to "Timekeeper" keeps its key, and the sheet
		// follows the key rather than the label (#445).
		expect(
			defaultPacketSelection({
				roles: [{ key: "timer", name: "Timekeeper" }],
				usesDigitalVoting: false,
				hasWord: false,
			}),
		).toEqual(["timer"]);
	});

	it("does not match an unrelated custom role by accident", () => {
		expect(
			defaultPacketSelection({
				roles: [{ key: null, name: "Joke Master" }],
				usesDigitalVoting: false,
				hasWord: false,
			}),
		).toEqual([]);
	});
});
