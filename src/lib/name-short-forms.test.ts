import { describe, expect, it } from "vitest";
import {
	givenNamesRelated,
	isCloseName,
	isLikelySameName,
	surnameOf,
} from "./name-short-forms";

describe("name short forms", () => {
	// protects=a nickname and its full name are close in either order;
	// fails_when=a nickname is missed or only one direction works;
	// no_claim=the table's coverage beyond these pairs.
	it("reads a short form both directions", () => {
		expect(isCloseName("Bob Smith", "Robert Smith")).toBe(true);
		expect(isCloseName("Robert Smith", "Bob Smith")).toBe(true);
		expect(isCloseName("Liz Wu", "Elizabeth Wu")).toBe(true);
		expect(isCloseName("Beth Wu", "Elizabeth Wu")).toBe(true);
		expect(isCloseName("Peggy Wu", "Margaret Wu")).toBe(true);
	});

	// protects=one short form may stand for several full names, and two nicknames are not related;
	// fails_when=al/alan is missed or bob/bill is related;
	// no_claim=other short forms.
	it("lets one short form stand for several full names, and not two nicknames for each other", () => {
		expect(givenNamesRelated("al", "albert")).toBe(true);
		expect(givenNamesRelated("al", "alan")).toBe(true);
		expect(givenNamesRelated("bob", "bill")).toBe(false);
	});

	// protects=a 3+ letter prefix that is 2+ shorter is related, one letter off is not;
	// fails_when=jan/jane, dan/dana or al/alex is related, or chris/christopher is missed;
	// no_claim=the short-form table.
	it("accepts a prefix of 3+ letters that is 2+ shorter, and not one letter off", () => {
		expect(isCloseName("Dan Lee", "Daniel Lee")).toBe(true);
		expect(isCloseName("Chris Lee", "Christopher Lee")).toBe(true);
		expect(isCloseName("Jane Smith", "Jan Smith")).toBe(false);
		expect(isCloseName("Dan Lee", "Dana Lee")).toBe(false);
		expect(givenNamesRelated("al", "alex")).toBe(false);
	});

	// protects=a one-word name or another surname is never close;
	// fails_when=either is suggested;
	// no_claim=given-name relations.
	it("never suggests a one-word name or another surname", () => {
		expect(isCloseName("Bob", "Robert Smith")).toBe(false);
		expect(isCloseName("Bob Smith", "Robert")).toBe(false);
		expect(isCloseName("Bob Smith", "Robert Jones")).toBe(false);
	});

	// protects="Last, First" reads the same as "First Last";
	// fails_when=the comma form is not parsed, or surnameOf returns the given name;
	// no_claim=multi-word surnames.
	it("reads the Last, First form", () => {
		expect(isCloseName("Bob Smith", "Smith, Robert")).toBe(true);
		expect(surnameOf("Smith, Robert")).toBe("smith");
		expect(surnameOf("Bob")).toBe("");
	});

	// protects=case and accents do not hide a match;
	// fails_when=an accented or upper-case name is missed;
	// no_claim=other normalisation such as punctuation.
	it("ignores case and accents", () => {
		expect(isCloseName("JOSÉ Garcia", "Jose Garcia")).toBe(true);
		expect(isCloseName("bob smith", "ROBERT SMITH")).toBe(true);
	});
});

describe("isLikelySameName (#1589)", () => {
	// protects=initials for the first name are a likely duplicate, either order;
	// fails_when=CJ Doe / Christopher Doe is not suggested;
	// no_claim=initials with a different surname.
	it("reads initials as the same first name", () => {
		expect(isLikelySameName("CJ Doe", "Christopher Doe")).toBe(true);
		expect(isLikelySameName("Christopher Doe", "CJ Doe")).toBe(true);
	});

	// protects=a short first name plus one part of a hyphenated surname is a likely duplicate;
	// fails_when=Tish Roe / Tishiana Roe-Smith is not suggested;
	// no_claim=surnames joined by a space rather than a hyphen.
	it("reads a prefix first name and one part of a hyphenated surname", () => {
		expect(isLikelySameName("Tish Roe", "Tishiana Roe-Smith")).toBe(true);
		expect(isLikelySameName("Tishiana Roe-Smith", "Tish Roe")).toBe(true);
	});

	// protects=a one-letter typo in a long enough name is a likely duplicate;
	// fails_when=Sam Towler / Sam Tawler is not suggested;
	// no_claim=two-letter typos.
	it("reads a one-letter typo", () => {
		expect(isLikelySameName("Sam Towler", "Sam Tawler")).toBe(true);
	});

	// protects=a shared word that is not the other's surname does not suggest;
	// fails_when=Carlos Doe / Alejandra Doe Lopez is suggested;
	// no_claim=none beyond protects.
	it("does not read a middle word as the surname", () => {
		expect(isLikelySameName("Carlos Doe", "Alejandra Doe Lopez")).toBe(false);
	});

	// protects=two people sharing only a surname are not suggested;
	// fails_when=Ann Lee / Bob Lee is suggested;
	// no_claim=short-form pairs, held by the isCloseName tests.
	it("does not read a shared surname alone", () => {
		expect(isLikelySameName("Ann Lee", "Bob Lee")).toBe(false);
	});

	// protects=two letters apart across first and last name is not a typo;
	// fails_when=Mary Stone / Mark Stine is suggested;
	// no_claim=none beyond protects.
	it("does not read a two-letter difference as a typo", () => {
		expect(isLikelySameName("Mary Stone", "Mark Stine")).toBe(false);
	});

	// protects=a name already matched by the fold is never a suggestion;
	// fails_when=identical or accent-only different names return true;
	// no_claim=none beyond protects.
	it("is false for names that fold the same", () => {
		expect(isLikelySameName("Sam Tawler", "Sam Tawler")).toBe(false);
		expect(isLikelySameName("José Tawler", "jose  tawler")).toBe(false);
	});

	// protects=the typo rule needs at least 6 letters on each side;
	// fails_when=Al Wu / Al Xu is suggested;
	// no_claim=the exact threshold beyond this pair and Sam Towler.
	it("does not read a typo in a short name", () => {
		expect(isLikelySameName("Al Wu", "Al Xu")).toBe(false);
	});
});
