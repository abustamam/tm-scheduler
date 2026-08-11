import { describe, expect, it } from "vitest";
import {
	coalesceToE164,
	DEFAULT_COUNTRY_CODE,
	toE164,
	toStoredPhone,
} from "./phone";

describe("toE164", () => {
	it("keeps an already-international number, stripping formatting", () => {
		expect(toE164("+1 (415) 555-2671")).toBe("+14155552671");
		expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
	});

	it("treats a 00 international prefix as +", () => {
		expect(toE164("0044 20 7946 0958")).toBe("+442079460958");
	});

	it("prepends the club default country code when the number lacks one", () => {
		expect(toE164("(415) 555-2671", "+1")).toBe("+14155552671");
		expect(toE164("415-555-2671", "1")).toBe("+14155552671");
	});

	it("returns null when no country code and no default (can't be made reliable)", () => {
		expect(toE164("415-555-2671")).toBeNull();
		expect(toE164("415-555-2671", null)).toBeNull();
	});

	it("returns null for empty / contentless input", () => {
		expect(toE164("")).toBeNull();
		expect(toE164(null)).toBeNull();
		expect(toE164("   ", "+1")).toBeNull();
		expect(toE164("n/a", "+1")).toBeNull();
	});

	it("does not double-prefix a number already starting with +", () => {
		expect(toE164("+14155552671", "+44")).toBe("+14155552671");
	});
});

/**
 * The read-side coalescer every payload that renders a phone goes through
 * (season grid, club roster, guest pipeline). Its `?? raw` half is the whole
 * reason it exists as a named function rather than an inline `toE164` call, so
 * the digit-less case below is the load-bearing one.
 */
describe("coalesceToE164", () => {
	it("passes an already-E.164 value through, stripping formatting", () => {
		expect(coalesceToE164("+14155552671", "+1")).toBe("+14155552671");
		expect(coalesceToE164("+1 (415) 555-2671", "+1")).toBe("+14155552671");
	});

	it("promotes a national number with the club's country code", () => {
		expect(coalesceToE164("(415) 555-2671", "+1")).toBe("+14155552671");
		expect(coalesceToE164("020 7946 0958", "+44")).toBe("+442079460958");
	});

	it("returns a digit-less value VERBATIM rather than dropping it", () => {
		// `toE164` returns null here, and `toStoredPhone` deliberately stores such
		// input as typed so the member can still read and edit it. Coalescing to
		// null would erase it from the UI and starve `WhatsAppPhoneLink`'s
		// plain-text branch, which renders exactly this case.
		expect(coalesceToE164("call the office", "+1")).toBe("call the office");
		expect(coalesceToE164("ask Dana", "+44")).toBe("ask Dana");
	});

	it("preserves a national number when there is no country code at all", () => {
		// `loadClubDefaultCountryCode` never returns null (#397), but the helper is
		// pure — with no default, the readable number still survives.
		expect(coalesceToE164("415-555-2671", null)).toBe("415-555-2671");
		expect(coalesceToE164("415-555-2671")).toBe("415-555-2671");
	});

	it("returns null for null / undefined", () => {
		expect(coalesceToE164(null, "+1")).toBeNull();
		expect(coalesceToE164(undefined, "+1")).toBeNull();
	});

	it("hands an empty string back unchanged, as the call sites already did", () => {
		// Pins the one shape where `?? null` and `|| null` disagree. Both shipped
		// call sites were `toE164(x, cc) ?? x`, which yields "" here — this helper
		// replaces them, so it has to yield "" too or the refactor is a behavior
		// change smuggled in as a hoist.
		expect(coalesceToE164("", "+1")).toBe("");
	});

	it("returns a digit-less value BYTE-FOR-BYTE, padding included", () => {
		// The doc says "unlike `toStoredPhone` it does not trim or collapse: the
		// stored value comes back byte-for-byte". Every other fixture above is
		// already trimmed, so `?? raw` and `?? raw?.trim()` agree on all of them —
		// swapping one for the other left 139 tests green. This is the only shape
		// where the two disagree, and the difference is real: `toStoredPhone` is
		// what trims on WRITE, so a read path that trims again silently disagrees
		// with the bytes in the column, and a legacy row stored before that write
		// path existed would render differently than it edits.
		expect(coalesceToE164("  call the office  ", "+1")).toBe(
			"  call the office  ",
		);
	});
});

describe("toStoredPhone", () => {
	it("stores E.164 when the number can be normalized", () => {
		expect(toStoredPhone("+1 (415) 555-2671")).toBe("+14155552671");
		expect(toStoredPhone("0044 20 7946 0958")).toBe("+442079460958");
		expect(toStoredPhone("415-555-2671", "+1")).toBe("+14155552671");
	});

	it("preserves the trimmed raw number when E.164 can't be derived (no default)", () => {
		// A bare national number with no club default can't be made reliable — but
		// we must not drop the user's input; keep it as entered (trimmed).
		expect(toStoredPhone("415-555-2671")).toBe("415-555-2671");
		expect(toStoredPhone("  415-555-2671  ", null)).toBe("415-555-2671");
	});

	it("returns null for empty / contentless input", () => {
		expect(toStoredPhone("")).toBeNull();
		expect(toStoredPhone(null)).toBeNull();
		expect(toStoredPhone(undefined, "+1")).toBeNull();
		expect(toStoredPhone("   ", "+1")).toBeNull();
	});
});

/**
 * The dedup key (#397). Guests and people are deduped on the DIGITS of the
 * stored phone, so every spelling of one number has to normalize to one E.164
 * value — and two numbers that genuinely differ must not.
 */
describe("dedup key: one number, one E.164 value (#397)", () => {
	// The variants #397 names, plus the ones a guest book actually receives.
	const SAME_NUMBER = [
		"(555) 123-4567",
		"555-123-4567",
		"555.123.4567",
		"555 123 4567",
		"5551234567",
		"  5551234567  ",
		"1 (555) 123-4567", // domestic long-distance prefix
		"1-555-123-4567",
		"15551234567",
		"+1 (555) 123-4567",
		"+1 555-123-4567",
		"+15551234567",
		"001 555 123 4567", // 00 international access prefix
	];

	// A club that never set a country code gets `DEFAULT_COUNTRY_CODE` from
	// `loadClubDefaultCountryCode`, so these are the values it stores now. Before
	// #397 the first six stored as typed and the rest as E.164 — two keys, two
	// guest rows. (The substitution itself is covered in
	// `guest-pipeline.integration.test.ts`, which goes through that loader.)
	it.each(SAME_NUMBER)("%s → +15551234567", (raw) => {
		expect(toStoredPhone(raw, DEFAULT_COUNTRY_CODE)).toBe("+15551234567");
	});

	it("does NOT merge numbers that differ by a real country code", () => {
		// The tempting fix — compare the last 10 digits — would call these equal.
		// They are two different people's phones.
		const uk = toStoredPhone("+44 20 7946 0958", DEFAULT_COUNTRY_CODE);
		const us = toStoredPhone("+1 (207) 946-0958", DEFAULT_COUNTRY_CODE);
		expect(uk).toBe("+442079460958");
		expect(us).toBe("+12079460958");
		expect(uk).not.toBe(us);
	});

	describe("a club whose country code is not +1", () => {
		it("converges the local and international spellings on +44", () => {
			// The UK trunk `0` is the local spelling of the same number.
			expect(toStoredPhone("020 7946 0958", "+44")).toBe("+442079460958");
			expect(toStoredPhone("+44 20 7946 0958", "+44")).toBe("+442079460958");
			expect(toStoredPhone("(020) 7946-0958", "+44")).toBe("+442079460958");
		});

		it("keeps its numbers distinct from the same digits under +1", () => {
			expect(toStoredPhone("555 123 4567", "+44")).toBe("+445551234567");
			expect(toStoredPhone("555 123 4567", "+1")).toBe("+15551234567");
			expect(toStoredPhone("555 123 4567", "+44")).not.toBe(
				toStoredPhone("555 123 4567", "+1"),
			);
		});

		it("does not treat a leading 1 as a country code outside NANP", () => {
			// `1` is the NANP long-distance prefix, not a universal one: under +44
			// those 11 digits are the number.
			expect(toStoredPhone("15551234567", "+44")).toBe("+4415551234567");
		});
	});

	it("leaves a leading 1 alone when it is part of a 10-digit NANP number", () => {
		// NANP area codes never start with 0 or 1, so only the 11-digit form is a
		// trunk-prefixed number. (This one is not a real area code either way — the
		// point is that the rule keys on length, not on a bare `startsWith("1")`.)
		expect(toE164("1234567890", "+1")).toBe("+11234567890");
	});

	describe("already-international numbers carrying NANP's domestic 1", () => {
		// `+1` + `1 555…` is what the pre-#397 code produced for a pasted "1 555…"
		// in a club that had set a country code, so these rows are already in the
		// database. Left alone they would be permanently unmatchable against the
		// same number typed any other way — the dedup bug for exactly the rows the
		// backfill exists to rescue.
		it("repairs the doubled prefix so it converges with every other spelling", () => {
			expect(toE164("+115551234567")).toBe("+15551234567");
			expect(toStoredPhone("+1 (1) 555-123-4567")).toBe("+15551234567");
			expect(toE164("00115551234567")).toBe("+15551234567");
		});

		it("agrees with the other spellings of the same number", () => {
			const canonical = toStoredPhone("(555) 123-4567", "+1");
			expect(canonical).toBe("+15551234567");
			for (const legacy of ["+115551234567", "+1 1 555 123 4567"]) {
				expect(toStoredPhone(legacy)).toBe(canonical);
			}
		});

		it("leaves a correct +1 number and other country codes untouched", () => {
			// 11 digits, not 12 — a well-formed NANP number.
			expect(toE164("+15551234567")).toBe("+15551234567");
			// No country code other than 1 begins with 1, so a 12-digit number
			// starting `11` is unambiguous; these are not.
			expect(toE164("+442079460958")).toBe("+442079460958");
			expect(toE164("+819012345678")).toBe("+819012345678");
		});
	});
});

describe("toStoredPhone is a fixed point over coalesceToE164", () => {
	// This property is the ONLY reason binding an edit form to the COALESCED
	// phone (`club-logic.ts`'s `phone`, not `phoneRaw`) does not corrupt the
	// column: every write path re-normalizes with `toStoredPhone`, and that
	// re-derivation happens to absorb the country-code guess coalescing added.
	//
	// It is a coincidence of the current implementations, not a promise either
	// function makes, and it is invisible at both call sites. Teach
	// `coalesceToE164` to strip extensions, or `toStoredPhone` to preserve input
	// it currently rewrites, and a coalesced prefill silently starts writing the
	// guess over the stored digits on every save — including a name-only one.
	//
	// The edit dialogs bind to `phoneRaw` so they do not depend on this holding.
	// It is pinned anyway, because the day it breaks is the day that decision
	// stops being a nicety, and a failure here is the only warning available.
	const RAWS = [
		"415-555-2671 x12",
		"(415) 555-2671",
		"+14155552671",
		"+1 916 555 0181",
		"0044 20 7946 0958",
		"020 7946 0018",
		"1 555 123 4567",
		"+1 1555 123 4567",
		"00115551234567",
		"ask at church",
		"call the office",
		"",
		"   ",
		"  (415) 555-2671  ",
		"555.123.4567",
		"+44 20 7946 0958",
	];

	it.each([
		DEFAULT_COUNTRY_CODE,
		"+44",
		"+91",
		"",
		null,
		undefined,
	])("holds for every stored shape with cc=%p", (cc) => {
		for (const raw of RAWS) {
			expect(
				toStoredPhone(coalesceToE164(raw, cc), cc),
				`raw=${JSON.stringify(raw)}`,
			).toBe(toStoredPhone(raw, cc));
		}
	});
});
