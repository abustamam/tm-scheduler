import { describe, expect, it } from "vitest";
import { firstNameOf, greetingName } from "./person-name";

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
