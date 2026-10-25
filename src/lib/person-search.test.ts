import { describe, expect, it } from "vitest";
import { goesBy, isBlankQuery, matchTier, searchPeople } from "./person-search";

const names = (rows: { name: string }[]) => rows.map((r) => r.name);

describe("matchTier", () => {
	// protects=accent folding; fails_when=query or name is not NFD-folded; no_claim=ordering
	it("folds accents in both directions", () => {
		expect(matchTier("jose", { name: "José Ruiz" })).not.toBeNull();
		expect(matchTier("josé", { name: "Jose Ruiz" })).not.toBeNull();
	});

	// protects=case insensitivity; fails_when=compare is case-sensitive; no_claim=accents
	it("ignores case", () => {
		expect(matchTier("JO SMITH", { name: "jo smith" })).toBe(0);
	});

	// protects=exact tier incl preferred name; fails_when=preferredName not a candidate; no_claim=nickname derivation
	it("scores a preferred-name exact hit as tier 0", () => {
		expect(
			matchTier("bob", { name: "Robert Smith", preferredName: "Bob" }),
		).toBe(0);
	});

	// protects=prefix tier; fails_when=startsWith replaced by includes; no_claim=word-prefix
	it("scores a name-start hit as tier 1", () => {
		expect(matchTier("ana", { name: "Ana Lee" })).toBe(1);
	});

	// protects=any word order; fails_when=words matched in sequence only; no_claim=exact tier
	it("matches words in any order at tier 2", () => {
		expect(matchTier("smith jo", { name: "Jo Smith" })).toBe(2);
	});

	// protects=union across name and preferred; fails_when=each candidate checked alone; no_claim=extra terms
	it("takes words from the union of name and preferred name", () => {
		expect(
			matchTier("bob smi", { name: "Robert Smith", preferredName: "Bob" }),
		).toBe(2);
	});

	// protects=substring fallback; fails_when=fallback removed; no_claim=tier 2 semantics
	it("falls back to substring at tier 3", () => {
		expect(matchTier("ana", { name: "Diana Park" })).toBe(3);
	});

	// protects=apostrophe stripped not split; fails_when=punctuation splits words; no_claim=hyphen handling
	it("treats an apostrophe as inner punctuation", () => {
		const p = { name: "D'Angelo Russo" };
		expect(matchTier("dangelo", p)).toBe(1);
		expect(matchTier("angelo", p)).toBe(3);
	});

	// protects=extra terms are searched; fails_when=extraTerms ignored; no_claim=they rank higher
	it("matches extra terms", () => {
		expect(
			matchTier("president", { name: "Jo", extraTerms: ["President"] }),
		).toBe(0);
		expect(matchTier("president", { name: "Jo" })).toBeNull();
	});

	// protects=no match is null; fails_when=non-matches pass; no_claim=fuzzy matching absent
	it("returns null for no match and does not match fuzzily", () => {
		expect(matchTier("jonh", { name: "John Doe" })).toBeNull();
		expect(matchTier("bob", { name: "Robert Smith" })).toBeNull();
	});

	// protects=empty query lists all; fails_when=blank or punctuation-only query filters rows; no_claim=ordering
	it("treats blank and punctuation-only queries as tier 0", () => {
		expect(matchTier("", { name: "Jo" })).toBe(0);
		expect(matchTier("   ", { name: "Jo" })).toBe(0);
		expect(matchTier("''", { name: "Jo" })).toBe(0);
	});

	// protects=word cap; fails_when=words past 8 are required; no_claim=exact boundary of cost
	it("ignores query words past the eighth", () => {
		const q = "a b c d e f g h zzz";
		expect(matchTier(q, { name: "a b c d e f g h" })).toBe(0);
	});

	// protects=length cap; fails_when=query uncapped (the zz survives and the row stops matching); no_claim=speed
	it("caps the query length", () => {
		const long = `${"'".repeat(200)}zz`;
		expect(matchTier(long, { name: "Jo" })).toBe(0);
	});
});

describe("searchPeople", () => {
	const people = [
		{ name: "Adiana Park" },
		{ name: "Anabel Cruz" },
		{ name: "Ana Lee" },
	];

	// protects=tier before name, then name within a tier, and dropping non-matches; fails_when=tier or name sort missing (Adiana sorts first by name but is tier 3); no_claim=rank
	it("orders by tier then name", () => {
		expect(names(searchPeople("ana", [...people, { name: "Zed" }]))).toEqual([
			"Ana Lee",
			"Anabel Cruz",
			"Adiana Park",
		]);
	});

	// protects=caller rank outranks tier; fails_when=tier sorted first; no_claim=rank scale
	it("sorts rank before tier", () => {
		const rows = [
			{ name: "Ana", r: 1 },
			{ name: "Diana", r: 0 },
		];
		expect(names(searchPeople("ana", rows, { rank: (p) => p.r }))).toEqual([
			"Diana",
			"Ana",
		]);
	});

	// protects=empty query keeps all, rank then name; fails_when=empty filters; no_claim=input order
	it("lists everyone by rank then name for an empty query", () => {
		const rows = [
			{ name: "Bo", r: 0 },
			{ name: "Al", r: 1 },
			{ name: "Cy", r: 0 },
		];
		expect(names(searchPeople("", rows, { rank: (p) => p.r }))).toEqual([
			"Bo",
			"Cy",
			"Al",
		]);
	});

	// protects=stable ties; fails_when=sort unstable on equal names; no_claim=identity beyond order
	it("keeps input order for identical names", () => {
		const rows = [
			{ name: "Jo", id: 1 },
			{ name: "Jo", id: 2 },
		];
		expect(searchPeople("jo", rows).map((r) => r.id)).toEqual([1, 2]);
	});
});

describe("isBlankQuery", () => {
	// protects=the one blank-query rule find_people shares with the matcher; fails_when=punctuation-only counts as a query or a word is called blank; no_claim=matching
	it("is true for empty, blank and punctuation-only, false for a word", () => {
		expect(isBlankQuery("")).toBe(true);
		expect(isBlankQuery("  ")).toBe(true);
		expect(isBlankQuery("''")).toBe(true);
		expect(isBlankQuery("jo")).toBe(false);
	});
});

describe("goesBy", () => {
	// protects=shows differing preferred name; fails_when=returns null or the full name; no_claim=rendering
	it("returns the preferred name when it differs from the first name", () => {
		expect(goesBy({ name: "Robert Smith", preferredName: "Bob" })).toBe("Bob");
	});

	// protects=hides redundant/blank; fails_when=case or blank not folded; no_claim=comma-form names beyond firstNameOf
	it("returns null when blank or equal to the first name", () => {
		expect(
			goesBy({ name: "Robert Smith", preferredName: "robert" }),
		).toBeNull();
		expect(goesBy({ name: "Robert Smith", preferredName: "  " })).toBeNull();
		expect(goesBy({ name: "Robert Smith", preferredName: null })).toBeNull();
	});
});
