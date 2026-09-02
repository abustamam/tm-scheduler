import { describe, expect, it } from "vitest";
import { listRoles } from "./list-roles";

describe("listRoles (#665)", () => {
	// ABSOLUTE expected strings, not a property relative to the implementation —
	// the point of this file is that the punctuation matches the three existing
	// `Intl.ListFormat` copies in the repo. A hand-rolled version passed a
	// "contains every name" style assertion while emitting no Oxford comma.
	it.each([
		[[], ""],
		[["Timer"], "Timer"],
		[["Grammarian", "Timer"], "Grammarian and Timer"],
		[
			["Grammarian", "Timer", "Ah-Counter"],
			"Grammarian, Timer, and Ah-Counter",
		],
	])("formats %j as %j", (names, expected) => {
		expect(listRoles(names)).toBe(expected);
	});

	it("matches the options the rest of the repo joins names with", () => {
		// The divergence that shipped first was punctuation, so pin it against the
		// same call the other three copies make rather than against a literal.
		const names = ["A", "B", "C"];
		expect(listRoles(names)).toBe(
			new Intl.ListFormat("en", {
				style: "long",
				type: "conjunction",
			}).format(names),
		);
	});
});
