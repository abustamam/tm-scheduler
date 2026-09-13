import { describe, expect, it } from "vitest";
import {
	BUCKET_BOUNDARIES,
	CONTENT_W,
	hasWordOfTheDay,
	posterBodySize,
	posterWordSize,
	SAFETY_MARGIN,
	TARGET_W,
} from "./word-poster";

/**
 * What the two tables held before #718 turned the sheet, largest bucket first.
 *
 * Kept as literals, and deliberately not imported from anywhere: this is the
 * before half of the issue's central claim — a landscape sheet is 35% more
 * measure and the word should be visibly bigger for it. A test written against
 * the CURRENT table can only say the sizes step; it cannot say they went up,
 * and a revert of `word-poster.ts` alone would leave every other assertion in
 * this file green.
 */
const PORTRAIT_NORMAL = [173, 116, 90, 74, 61];
const PORTRAIT_ALL_CAPS = [141, 94, 65, 52, 44];
/** One word per bucket, at the bucket's own length. */
const PER_BUCKET = [
	"candid",
	"ephemeral!",
	"ephemerally",
	"a".repeat(18),
	"a".repeat(19),
];

describe("posterWordSize", () => {
	it("steps down at each bucket boundary", () => {
		// Lengths are spelled out because the boundary is the whole point.
		expect(posterWordSize("apt")).toBe(233); // 3
		expect(posterWordSize("candid")).toBe(233); // 6
		expect(posterWordSize("aplomb!")).toBe(157); // 7
		expect(posterWordSize("ephemeral!")).toBe(157); // 10
		expect(posterWordSize("ephemerally")).toBe(124); // 11
		expect(posterWordSize("magnanimously!")).toBe(124); // 14
		expect(posterWordSize("circumlocution!")).toBe(111); // 15
		expect(posterWordSize("a".repeat(18))).toBe(111); // 18
		expect(posterWordSize("a".repeat(19))).toBe(93); // 19
	});

	it("floors at the smallest size for pathological input", () => {
		expect(posterWordSize("a".repeat(60))).toBe(93);
	});

	it("measures the trimmed word, so padding does not shrink it", () => {
		expect(posterWordSize("   apt   ")).toBe(233);
	});

	it("sizes an empty word like a short one — there is no empty-string special case", () => {
		expect(posterWordSize("")).toBe(233);
	});

	// Capitals are far wider than lowercase, so an all-caps word gets its own,
	// much smaller table. Pin the branch from both sides at the same length.
	it("uses the smaller all-caps sizes for a word typed in capitals", () => {
		expect(posterWordSize("EPHEMERAL")).toBe(129); // 9, all caps
		expect(posterWordSize("Ephemeral")).toBe(157); // 9, not all caps
	});

	it("steps down at each all-caps bucket boundary", () => {
		expect(posterWordSize("CANDID")).toBe(190); // 6
		expect(posterWordSize("APLOMB!")).toBe(129); // 7
		expect(posterWordSize("EPHEMERAL!")).toBe(129); // 10
		expect(posterWordSize("EPHEMERALLY")).toBe(95); // 11
		expect(posterWordSize("MAGNANIMOUSLY!")).toBe(95); // 14
		expect(posterWordSize("CIRCUMLOCUTION!")).toBe(72); // 15
		expect(posterWordSize("A".repeat(18))).toBe(72); // 18
		expect(posterWordSize("A".repeat(19))).toBe(60); // 19
	});

	it("treats mixed case as ordinary, not all-caps", () => {
		expect(posterWordSize("EPhemeral")).toBe(157); // 9
	});

	// The all-caps test is "contains a letter AND equals its own uppercase".
	// Digits equal their own uppercase, so without the letter half of that
	// condition "1234" would be sized as shouted text.
	it("sizes letterless input from the normal table", () => {
		expect(posterWordSize("1234")).toBe(233); // 4, no letters
	});

	// THE POINT OF #718, asserted as a direction rather than as five more
	// literals. Every bucket in both tables has to be strictly larger than the
	// portrait size it replaced — that is what 35% more measure buys, and it is
	// the thing a reader of this file should be able to check without a browser.
	it("sizes every bucket larger than the portrait table it replaced", () => {
		PER_BUCKET.forEach((word, i) => {
			const before = PORTRAIT_NORMAL[i] as number;
			expect(
				posterWordSize(word),
				`bucket ${i} shrank or held: the landscape measure is 925px against ` +
					"685px, so every size must go up. If the tables were re-derived, " +
					"update PORTRAIT_NORMAL here in the same change.",
			).toBeGreaterThan(before);
			expect(posterWordSize(word.toUpperCase())).toBeGreaterThan(
				PORTRAIT_ALL_CAPS[i] as number,
			);
		});
	});

	// And how much larger. The gains are NOT uniform (see "NEVER EXTRAPOLATE A
	// SIZE"): the short and middle buckets track the measure's own +35%, while
	// the long ones gain 50%+ because that is where `opsz` is still changing
	// fast. So a single scale factor applied to the old table would be wrong at
	// the tail, and pinning both ends says so.
	it("tracks the measure at the short end and beats it at the long one", () => {
		const measureGain = 925 / 685; // 1.3504
		expect(posterWordSize("Apt") / 173).toBeCloseTo(1.347, 2);
		expect(posterWordSize("Ephemeral") / 116).toBeCloseTo(1.353, 2);
		// The tail gains materially MORE than the measure did.
		expect(posterWordSize("a".repeat(19)) / 61).toBeGreaterThan(
			measureGain * 1.1,
		);
		expect(posterWordSize("a".repeat(19)) / 61).toBeCloseTo(1.525, 2);
	});

	// The measurement harness sweeps length ranges built from BUCKET_BOUNDARIES
	// and applies the all-caps sizes within them. If the two tables stepped at
	// different lengths, the harness would measure an all-caps bucket over the
	// wrong range and still report PASS.
	it("steps both tables at the same lengths", () => {
		for (const boundary of BUCKET_BOUNDARIES) {
			const at = posterWordSize("A".repeat(boundary));
			const past = posterWordSize("A".repeat(boundary + 1));
			expect(at).not.toBe(past);
		}
		// And the boundaries really are the normal table's, not a stale copy.
		expect([...BUCKET_BOUNDARIES]).toEqual([6, 10, 14, 18]);
	});
});

describe("posterBodySize", () => {
	// A third of the word size at every bucket in BOTH tables, so the definition
	// keeps a constant relationship to the word instead of a fixed size the word
	// drifts away from. Spelled out per bucket because the clamp makes the
	// mapping non-obvious at the ends.
	it("is a third of the word size at each normal bucket", () => {
		expect(posterBodySize("apt")).toBe(32); // 233/3 = 78 → clamped
		expect(posterBodySize("ephemeral!")).toBe(32); // 157/3 = 52 → clamped
		expect(posterBodySize("ephemerally")).toBe(32); // 124/3 = 41 → clamped
		expect(posterBodySize("circumlocution!")).toBe(32); // 111/3 = 37 → clamped
		expect(posterBodySize("a".repeat(19))).toBe(31); // 93/3
	});

	it("is a third of the word size at each all-caps bucket", () => {
		expect(posterBodySize("CANDID")).toBe(32); // 190/3 = 63 → clamped
		expect(posterBodySize("EPHEMERAL!")).toBe(32); // 129/3 = 43 → clamped
		expect(posterBodySize("EPHEMERALLY")).toBe(32); // 95/3 = 31.7 → 32
		expect(posterBodySize("A".repeat(18))).toBe(24); // 72/3
		expect(posterBodySize("A".repeat(19))).toBe(20); // 60/3
	});

	/**
	 * THE CEILING NOW DOES MOST OF THE WORK, and that is a #718 consequence
	 * worth failing on rather than discovering later.
	 *
	 * At the portrait sizes the clamp caught 2 of the 10 buckets and the
	 * third-of-the-word rule set the other 8. At the landscape sizes it catches
	 * 7, so an ordinary word's definition is 32px at every length. Counting it
	 * here means a later retune that changes the balance — raising the ceiling,
	 * or shrinking the tables again — says so out loud instead of silently
	 * restoring a ratio the comments no longer describe.
	 */
	it("clamps 7 of the 10 buckets at the ceiling", () => {
		const everyBucket = [
			"apt",
			"ephemeral!",
			"ephemerally",
			"circumlocution!",
			"a".repeat(19),
			"CANDID",
			"EPHEMERAL!",
			"EPHEMERALLY",
			"A".repeat(18),
			"A".repeat(19),
		];
		const clamped = everyBucket.filter((w) => posterBodySize(w) === 32);
		expect(clamped).toHaveLength(7);
		// …and the ratio still holds where it is not clamped, which is what makes
		// the clamp a ceiling rather than a fixed size in disguise.
		expect(posterBodySize("A".repeat(18))).toBe(
			Math.round(posterWordSize("A".repeat(18)) / 3),
		);
	});

	// Both ends of the clamp. The floor no longer FIRES: the smallest size in
	// either table is 60 and 60/3 is exactly 20, where the portrait table had two
	// all-caps buckets under it (52/3 and 44/3). So it is now a boundary the
	// table sits exactly on, with no slack — the next retune that shrinks the
	// tail crosses it, and the definition stops tracking the word at that end.
	it("lands exactly on the 20px floor at the smallest size", () => {
		expect(Math.round(posterWordSize("A".repeat(19)) / 3)).toBe(20);
		expect(posterBodySize("A".repeat(19))).toBe(20);
		// Pathological input is longer still, and gets the same floor.
		expect(posterBodySize("A".repeat(40))).toBe(20);
	});

	it("ceilings at 32px so a short word's definition cannot balloon", () => {
		// 233/3 is 78 — more than double the cap, and would compete with the word.
		expect(Math.round(posterWordSize("apt") / 3)).toBeGreaterThan(32);
		expect(posterBodySize("apt")).toBe(32);
	});

	// The ceiling used to be what priced the poster's `min(23em, CONTENT_W px)`
	// cap: 23em at 32px is 736px, which exceeded the 704px PORTRAIT content box.
	// The landscape box is 944px, so the cap is now slack. Pinned in both
	// directions because "the cap does nothing" is the reasoning under which
	// someone deletes it, and the portrait number is why it exists.
	it("no longer needs the width cap at the landscape measure", () => {
		expect(23 * 32).toBeLessThan(CONTENT_W); // 736 < 944 — slack
		expect(23 * 32).toBeGreaterThan(704); // but it bound on the portrait box
	});

	it("measures the trimmed word, like the word size it is derived from", () => {
		expect(posterBodySize("   apt   ")).toBe(posterBodySize("apt"));
	});
});

describe("the width budget", () => {
	// TARGET_W is DERIVED, so a change to the page geometry cannot silently
	// re-price the safety margin the sizes were measured with.
	it("keeps the safety margin between the content box and the target", () => {
		expect(TARGET_W).toBe(CONTENT_W - SAFETY_MARGIN);
		expect(SAFETY_MARGIN).toBeGreaterThan(0);
		expect(TARGET_W).toBeLessThan(CONTENT_W);
	});

	// The measure the tables were actually derived against (#718). The geometry
	// identity — that this really is the landscape sheet less the padding — is
	// pinned in `word-of-the-day-poster.test.tsx`, which can import the page box
	// without pulling React into this module. This is the other half: the exact
	// numbers the harness ran with, so a re-derivation against a different
	// measure cannot land without saying so.
	it("is the landscape measure the size tables were derived against", () => {
		expect(CONTENT_W).toBe(944);
		expect(TARGET_W).toBe(925);
		// And it really is WIDER than the portrait box it replaced, by the 34%
		// the issue is about — a revert of CONTENT_W alone leaves the tables
		// sized for a box they no longer fit in, and this is what catches it.
		expect(CONTENT_W).toBeGreaterThan(704);
	});
});

describe("hasWordOfTheDay", () => {
	it("is true for a real word", () => {
		expect(hasWordOfTheDay("Ephemeral")).toBe(true);
	});

	it("is false for null and undefined", () => {
		expect(hasWordOfTheDay(null)).toBe(false);
		expect(hasWordOfTheDay(undefined)).toBe(false);
	});

	it("is false for empty and whitespace-only", () => {
		expect(hasWordOfTheDay("")).toBe(false);
		expect(hasWordOfTheDay("   ")).toBe(false);
		expect(hasWordOfTheDay("\t\n")).toBe(false);
	});

	// The poster route feeds `meeting.wordOfTheDay` (string | null) straight into
	// a `word: string` prop after this check, so the predicate has to do the
	// narrowing — otherwise the call site needs an `as string` cast, which would
	// silently outlive any later weakening of this function. This test fails at
	// TYPECHECK (not at runtime) if the return type stops being `word is string`.
	it("narrows its argument to a string, so callers need no cast", () => {
		const maybe = "Ephemeral" as string | null;
		if (!hasWordOfTheDay(maybe)) throw new Error("expected a word");
		expect(maybe.trim()).toBe("Ephemeral");
	});
});
