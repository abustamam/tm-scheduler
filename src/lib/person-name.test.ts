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
