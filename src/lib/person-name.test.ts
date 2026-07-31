import { describe, expect, it } from "vitest";
import {
	firstNameOf,
	greetingName,
	lastNameOf,
	sortKeyOf,
} from "./person-name";

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

	it("returns empty for a blank name rather than throwing", () => {
		expect(firstNameOf("")).toBe("");
		expect(firstNameOf("   ")).toBe("");
	});
});

describe("lastNameOf", () => {
	it("takes the last token", () => {
		expect(lastNameOf("Zabihullah Kogyani")).toBe("Kogyani");
		expect(lastNameOf("Mary Jane Watson")).toBe("Watson");
	});

	it("returns empty for a mononym, not a copy of the first name", () => {
		expect(lastNameOf("Prince")).toBe("");
		expect(lastNameOf("")).toBe("");
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

describe("sortKeyOf", () => {
	it("files under the family name", () => {
		expect(sortKeyOf({ name: "Zabihullah Kogyani" })).toBe(
			"kogyani zabihullah",
		);
		expect(sortKeyOf({ name: "Mary Jane Watson" })).toBe("watson mary");
	});

	it("sorts a mononym by its only token", () => {
		expect(sortKeyOf({ name: "Prince" })).toBe("prince");
	});

	it("orders a roster by family name, not given name", () => {
		const roster = [
			{ name: "Zabihullah Kogyani" },
			{ name: "Abdul-Rasheed Bustamam" },
			{ name: "Jane Adams" },
		];
		const sorted = [...roster].sort((a, b) =>
			sortKeyOf(a).localeCompare(sortKeyOf(b)),
		);
		expect(sorted.map((m) => m.name)).toEqual([
			"Jane Adams",
			"Abdul-Rasheed Bustamam",
			"Zabihullah Kogyani",
		]);
	});
});
