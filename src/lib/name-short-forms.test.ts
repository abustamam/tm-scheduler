import { describe, expect, it } from "vitest";
import { givenNamesRelated, isCloseName, surnameOf } from "./name-short-forms";

// protects=which pairs the plan suggests as "may be a member already"; fails_when=a
// distinct name is suggested or a nickname is missed; no_claim=the table's coverage
// beyond the pairs named here (it is reviewed as data).
describe("name short forms", () => {
	it("reads a short form both directions", () => {
		expect(isCloseName("Bob Smith", "Robert Smith")).toBe(true);
		expect(isCloseName("Robert Smith", "Bob Smith")).toBe(true);
		expect(isCloseName("Liz Wu", "Elizabeth Wu")).toBe(true);
		expect(isCloseName("Beth Wu", "Elizabeth Wu")).toBe(true);
		expect(isCloseName("Peggy Wu", "Margaret Wu")).toBe(true);
	});

	it("lets one short form stand for several full names, and not two nicknames for each other", () => {
		expect(givenNamesRelated("al", "albert")).toBe(true);
		expect(givenNamesRelated("al", "alan")).toBe(true);
		expect(givenNamesRelated("bob", "bill")).toBe(false);
	});

	it("accepts a prefix of 3+ letters that is 2+ shorter, and not one letter off", () => {
		expect(isCloseName("Dan Lee", "Daniel Lee")).toBe(true);
		expect(isCloseName("Chris Lee", "Christopher Lee")).toBe(true);
		expect(isCloseName("Jane Smith", "Jan Smith")).toBe(false);
		expect(isCloseName("Dan Lee", "Dana Lee")).toBe(false);
		expect(givenNamesRelated("al", "alex")).toBe(false);
	});

	it("never suggests a one-word name or another surname", () => {
		expect(isCloseName("Bob", "Robert Smith")).toBe(false);
		expect(isCloseName("Bob Smith", "Robert")).toBe(false);
		expect(isCloseName("Bob Smith", "Robert Jones")).toBe(false);
	});

	it("reads the Last, First form", () => {
		expect(isCloseName("Bob Smith", "Smith, Robert")).toBe(true);
		expect(surnameOf("Smith, Robert")).toBe("smith");
		expect(surnameOf("Bob")).toBe("");
	});

	it("ignores case and accents", () => {
		expect(isCloseName("JOSÉ Garcia", "Jose Garcia")).toBe(true);
		expect(isCloseName("bob smith", "ROBERT SMITH")).toBe(true);
	});
});
