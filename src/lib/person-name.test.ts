import { describe, expect, it } from "vitest";
import { firstNameOf, greetingName, namesAgree } from "./person-name";

describe("namesAgree", () => {
	it("matches the same name written the same way", () => {
		expect(namesAgree("Jane Doe", "Jane Doe")).toBe(true);
	});

	it("matches across the two shapes the Toastmasters export emits", () => {
		// THE case this function exists for. The export carries both "First Last"
		// and "Last, First" (members-csv.test.ts), so a comparison that can't see
		// through the comma silently disables the guard for every comma-shaped row
		// — which is the whole roster, for some clubs.
		expect(namesAgree("Khan, Zabihullah", "Zabihullah Khan")).toBe(true);
		expect(
			namesAgree("Bustamam, Abdul-Rasheed", "Abdul-Rasheed Bustamam"),
		).toBe(true);
	});

	it("ignores case, padding and repeated whitespace", () => {
		expect(namesAgree("  jane   DOE ", "Jane Doe")).toBe(true);
	});

	it("ignores punctuation differences, including hyphens", () => {
		expect(namesAgree("Abdul-Rasheed Bustamam", "Abdul Rasheed Bustamam")).toBe(
			true,
		);
		expect(namesAgree("J. R. Ewing", "J R Ewing")).toBe(true);
	});

	it("ignores diacritics, so one human typing it two ways still matches", () => {
		expect(namesAgree("José García", "Jose Garcia")).toBe(true);
	});

	it("keeps non-Latin scripts comparable rather than stripping them away", () => {
		// A script-blind tokenizer reduces these to zero tokens, which would make
		// the guard permanently reject every match for those members.
		expect(namesAgree("练 习", "练 习")).toBe(true);
		expect(namesAgree("练 习", "别 的")).toBe(false);
	});

	it("rejects two family members sharing a household phone", () => {
		// THE case #488 is about: same surname, different given name. These must
		// stay separate or the guest converts onto their spouse's Person and takes
		// their own future speeches and Pathways progress there with them.
		expect(namesAgree("Jane Doe", "John Doe")).toBe(false);
		expect(namesAgree("Doe, Jane", "John Doe")).toBe(false);
	});

	it("matches one human who initialised their own name", () => {
		// The other half of the job. A guest book gets "Jamie Rivera" one week and
		// "Jamie R." the next; splitting those into two prospects undercounts the
		// returning visitor the VP-Membership funnel is built on.
		expect(namesAgree("Jamie Rivera", "Jamie R.")).toBe(true);
		expect(namesAgree("Zabihullah Kogyani", "Z. Kogyani")).toBe(true);
	});

	it("does not try to model nicknames", () => {
		// Only a single letter abbreviates. "Rob"/"Robert" is left as a mismatch on
		// purpose: this codebase holds that a nickname is not derivable from a
		// stored name (#486), and the alternative — general prefix matching — fuses
		// the "Janet"/"Jane" and "Sandra"/"Sam" pairs asserted below.
		expect(namesAgree("Robert Smith", "Rob Smith")).toBe(false);
	});

	it("tolerates a dropped middle name and a bare given name", () => {
		expect(namesAgree("Mary Jane Watson", "Mary Watson")).toBe(true);
		expect(namesAgree("Jane Doe", "Jane")).toBe(true);
	});

	it("pairs tokens without burning a match greedily", () => {
		// ["j","jane"] vs ["jane","john"]: pairing j→jane first strands `jane`,
		// though j→john / jane→jane is valid.
		expect(namesAgree("J Jane", "Jane John")).toBe(true);
	});

	it("still separates people whose given names merely start alike", () => {
		expect(namesAgree("Jane Doe", "Janet Doe")).toBe(false);
		expect(namesAgree("Sam Doe", "Sandra Doe")).toBe(false);
	});

	it("stays fast on a name built to abuse the pairing search", () => {
		// The pairing search backtracks, so its cost is factorial in the token
		// count when no complete pairing exists. `captureGuestVisit` is the PUBLIC
		// unauthenticated guest book with no max length on the name, and two POSTs
		// sharing a phone number reach this comparison — so an attacker picks the
		// input. Unbounded, ~40 characters cost 4.8s of synchronous event-loop time
		// at 12 tokens and hours at 15.
		const stored = Array.from({ length: 24 }, () => "ab").join(" ");
		const attack = `${Array.from({ length: 23 }, () => "ab").join(" ")} zz`;
		const started = Date.now();
		expect(namesAgree(stored, attack)).toBe(false);
		expect(Date.now() - started).toBeLessThan(50);
	});

	it("compares long names exactly, never more loosely", () => {
		// Past the cap the pairing search is skipped. That must make the comparison
		// STRICTER — an over-cap name that would have "paired" must not agree, or
		// the bound would become a way to fuse two people.
		const nine = Array.from({ length: 9 }, (_, i) => `tok${i}`).join(" ");
		expect(namesAgree(nine, nine)).toBe(true);
		expect(namesAgree(nine, `${nine} extra`)).toBe(false);
		expect(namesAgree(nine, nine.replace("tok8", "t"))).toBe(false);
	});

	it("still pairs at exactly the cap", () => {
		// Boundary: MAX_MATCH_TOKENS is 8, and the check is `> MAX`. An 8-token pair
		// must still go through the pairing search (so an initial matches), or a
		// `>` → `>=` slip would silently switch real names to exact-only.
		const eight = "alpha bravo charlie delta echo foxtrot golf hotel";
		expect(namesAgree(eight, eight.replace("hotel", "h"))).toBe(true);
		// Nine tokens is over the cap: exact only, so the initial no longer matches.
		const nine = `${eight} india`;
		expect(namesAgree(nine, nine.replace("india", "i"))).toBe(false);
	});

	it("refuses a bare initial as a wildcard", () => {
		// The hole that defeated the whole guard: a single letter matched ANY token,
		// so a guest-book row named "J" carrying a member's household phone
		// converted straight onto that member. Guest names have a 1-char minimum,
		// so this was reachable by typing one character.
		expect(namesAgree("Jane Doe", "j")).toBe(false);
		expect(namesAgree("Jane Doe", "J.")).toBe(false);
		expect(namesAgree("John Doe", "j")).toBe(false);
	});

	it("does not let a name particle absorb a different given name", () => {
		// Real names, not adversarial input: a standalone particle is a token, and
		// as an unguarded initial it matched any word starting with that letter.
		expect(namesAgree("Ana Silva e Costa", "Eduardo Silva Costa")).toBe(false);
		expect(namesAgree("Maria Garcia y Lopez", "Yolanda Garcia Lopez")).toBe(
			false,
		);
	});

	it("treats an apostrophe as part of the word, not a separator", () => {
		// Splitting on all punctuation made "D'Angelo" into ["d","angelo"], and that
		// stray "d" matched any D-name.
		expect(namesAgree("David Russo", "D'Angelo Russo")).toBe(false);
		expect(namesAgree("D'Angelo Russo", "DAngelo Russo")).toBe(true);
		expect(namesAgree("O'Brien, Sean", "Sean O'Brien")).toBe(true);
	});

	it("does not read an email address as a name", () => {
		expect(namesAgree("Jane Doe", "jane@doe.com")).toBe(false);
	});

	it("stays fast when no pairing exists, at any token count", () => {
		// Kuhn's matching is O(V*E); the backtracking it replaced was factorial and
		// reachable from the public guest book.
		const stored = Array.from({ length: 8 }, () => "ab").join(" ");
		const attack = `${Array.from({ length: 7 }, () => "ab").join(" ")} zz`;
		const started = Date.now();
		expect(namesAgree(stored, attack)).toBe(false);
		expect(Date.now() - started).toBeLessThan(20);
	});

	it("bounds a pathologically long stored name", () => {
		// The other side of the comparison comes from stored rows, and not every
		// write path caps its input.
		const huge = "ab ".repeat(50_000);
		const started = Date.now();
		expect(namesAgree(huge, "Jane Doe")).toBe(false);
		expect(Date.now() - started).toBeLessThan(50);
	});

	it("treats an empty or punctuation-only name as no match", () => {
		expect(namesAgree("", "Jane Doe")).toBe(false);
		expect(namesAgree("Jane Doe", "   ")).toBe(false);
		expect(namesAgree(",", ",")).toBe(false);
	});
});

describe("firstNameOf", () => {
	it("takes the first token", () => {
		expect(firstNameOf("Zabihullah Kogyani")).toBe("Zabihullah");
		expect(firstNameOf("Abdul-Rasheed Bustamam")).toBe("Abdul-Rasheed");
	});

	it("handles a mononym and a three-part name", () => {
		expect(firstNameOf("Prince")).toBe("Prince");
		expect(firstNameOf("Mary Jane Watson")).toBe("Mary");
	});

	it("ignores surrounding and repeated whitespace", () => {
		expect(firstNameOf("  Jane   Doe  ")).toBe("Jane");
	});

	it("reads the given name out of a `Last, First` row", () => {
		// The Toastmasters export carries this shape too (members-csv.test.ts has
		// `Name: "Khan, Mois"`). Splitting on whitespace alone returns "Khan,",
		// which greets the person by their FAMILY name with a doubled comma.
		expect(firstNameOf("Khan, Mois")).toBe("Mois");
		expect(firstNameOf("Bustamam, Abdul-Rasheed")).toBe("Abdul-Rasheed");
		expect(firstNameOf("Watson, Mary Jane")).toBe("Mary");
	});

	it("never returns a token with trailing punctuation welded on", () => {
		// Belt to the suspenders above: a stray trailing comma with nothing after
		// it must not reach the greeting.
		expect(firstNameOf("Khan,")).toBe("Khan");
		expect(firstNameOf("Prince;")).toBe("Prince");
		expect(firstNameOf("Khan, ")).toBe("Khan");
	});

	it("returns empty for a blank name rather than throwing", () => {
		expect(firstNameOf("")).toBe("");
		expect(firstNameOf("   ")).toBe("");
	});
});

describe("greetingName", () => {
	it("falls back to the first token when nothing is recorded", () => {
		expect(greetingName({ name: "Zabihullah Kogyani" })).toBe("Zabihullah");
		expect(greetingName({ name: "Jane Doe", preferredName: null })).toBe(
			"Jane",
		);
	});

	it("uses the recorded name when the first token is wrong", () => {
		// The case that motivated this: the stored name's first token is not what
		// the person is called (#486).
		expect(
			greetingName({
				name: "Abdul-Rasheed Bustamam",
				preferredName: "Rasheed",
			}),
		).toBe("Rasheed");
		expect(greetingName({ name: "Robert Smith", preferredName: "Bob" })).toBe(
			"Bob",
		);
	});

	it("treats a blank recorded name as unset", () => {
		// A cleared text input submits "" and whitespace, not null. Greeting
		// someone by an empty string is worse than guessing.
		expect(greetingName({ name: "Jane Doe", preferredName: "" })).toBe("Jane");
		expect(greetingName({ name: "Jane Doe", preferredName: "   " })).toBe(
			"Jane",
		);
	});

	it("trims a recorded name", () => {
		expect(greetingName({ name: "Jane Doe", preferredName: " Janey " })).toBe(
			"Janey",
		);
	});

	it("keeps a mononym intact", () => {
		expect(greetingName({ name: "Prince" })).toBe("Prince");
	});
});
