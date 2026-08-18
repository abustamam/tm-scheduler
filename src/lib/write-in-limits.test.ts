import { describe, expect, it } from "vitest";
import {
	capWriteInName,
	WRITE_IN_LIMITS,
	writeInKey,
	writeInNameSchema,
} from "./write-in-limits";

describe("WRITE_IN_LIMITS", () => {
	/**
	 * An ABSOLUTE ceiling, not a comparison against the constant it guards.
	 *
	 * `expect(name.length).toBeLessThanOrEqual(WRITE_IN_LIMITS.name)` is the
	 * obvious assertion and it passes for EVERY value of the constant, including
	 * one that reintroduces the bug — CLAUDE.md's #519 case, where raising a cap
	 * to 5,000 kept 90/90 green while one public request blocked the event loop
	 * for 129 seconds. So the number is pinned against a literal, well below the
	 * knee #519 measured (500 and 5,000 characters both rendered in 39ms; 49,999
	 * took 3,707ms).
	 *
	 * Raising this is a decision to let a stranger put a longer string on the
	 * projected awards slide and into a synchronously-rendered public PDF. Make
	 * it with a fresh measurement, not to turn a red test green.
	 */
	it("caps a write-in name far below the measured render knee", () => {
		expect(WRITE_IN_LIMITS.name).toBeLessThanOrEqual(120);
		// …and is still comfortably above any real name. The longest `members.name`
		// in dev data is 34 characters.
		expect(WRITE_IN_LIMITS.name).toBeGreaterThanOrEqual(60);
	});
});

describe("writeInNameSchema", () => {
	it("trims before measuring, so trailing space cannot push a name over", () => {
		const atCap = "a".repeat(WRITE_IN_LIMITS.name);
		expect(writeInNameSchema.parse(`  ${atCap}  `)).toBe(atCap);
	});

	it("rejects a name past the cap rather than truncating it", () => {
		// The opposite of `WOD_UPDATE_FIELDS`, deliberately: the field IS the whole
		// input here, a truncated name is a different person, and the voter is
		// standing there able to retype. Silent truncation would put "Bartholo" on
		// the awards slide.
		expect(() =>
			writeInNameSchema.parse("a".repeat(WRITE_IN_LIMITS.name + 1)),
		).toThrow();
	});

	it("rejects a blank or whitespace-only name", () => {
		// Otherwise it becomes an invisible candidate nobody can tell apart from
		// another invisible candidate.
		for (const blank of ["", "   ", "\t\n "]) {
			expect(() => writeInNameSchema.parse(blank)).toThrow();
		}
	});

	it("accepts an ordinary name unchanged", () => {
		expect(writeInNameSchema.parse("Rehanna Khan")).toBe("Rehanna Khan");
	});
});

describe("capWriteInName", () => {
	/**
	 * Goes through the audited `cap`, not `.slice()`.
	 *
	 * #522 measured the difference: a UTF-16 slice cuts a surrogate pair in half,
	 * node-postgres UTF-8-encodes the lone surrogate to U+FFFD, and the corrupted
	 * value sits exactly AT the cap so every later length check passes it
	 * through — onto a public PDF, as a tombstone glyph in an invalid PDF text
	 * string.
	 */
	it("never splits an astral character", () => {
		const emoji = "🎤".repeat(WRITE_IN_LIMITS.name);
		const out = capWriteInName(emoji);
		expect([...out].every((ch) => ch === "🎤")).toBe(true);
		expect(out).not.toContain("�");
		// A lone surrogate would survive a naive round trip; this asserts none is
		// present rather than trusting the code-point count alone.
		expect(
			/[\uD800-\uDFFF]/.test(out.replace(/\uD83C[\uDF00-\uDFFF]|🎤/g, "")),
		).toBe(false);
	});

	it("leaves a name under the cap alone", () => {
		expect(capWriteInName("Rehanna Khan")).toBe("Rehanna Khan");
	});
});

describe("writeInKey", () => {
	/**
	 * The key is what stops one person becoming two candidates splitting one
	 * person's vote — the failure mode a free-text ballot has and a roster-backed
	 * one does not.
	 */
	it("folds case and collapses whitespace", () => {
		const same = [
			"Bob Smith",
			"bob smith",
			"BOB SMITH",
			"  Bob   Smith  ",
			"Bob\tSmith",
		];
		const keys = new Set(same.map(writeInKey));
		expect(keys.size).toBe(1);
		expect([...keys][0]).toBe("bob smith");
	});

	/**
	 * Punctuation is deliberately NOT stripped. "O'Brien" and "OBrien" are
	 * plausibly different people, and a ballot is the wrong place to guess —
	 * merging two real people is worse than showing two entries the room can
	 * read and pick between.
	 */
	it("does not merge names that differ by punctuation", () => {
		expect(writeInKey("O'Brien")).not.toBe(writeInKey("OBrien"));
		expect(writeInKey("Anne-Marie")).not.toBe(writeInKey("Anne Marie"));
	});

	it("distinguishes genuinely different people", () => {
		expect(writeInKey("Bob Smith")).not.toBe(writeInKey("Bob Smyth"));
	});
});
