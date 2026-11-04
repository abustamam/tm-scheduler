import { describe, expect, it } from "vitest";
import { givenNamesRelated, isCloseName, surnameOf } from "./name-short-forms";

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
