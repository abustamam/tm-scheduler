import { describe, expect, it } from "vitest";
import {
	closeTo,
	fold,
	nameIsMatchable,
	nearName,
	sharesContact,
} from "./near-name";

describe("near-name (#1658)", () => {
	it("fold trims and lowercases, null-safe", () => {
		expect(fold("  Ada LOVE ")).toBe("ada love");
		expect(fold(null)).toBe("");
	});

	it("closeTo: a typo of the same person, either direction", () => {
		expect(closeTo("Imani Clark", { name: "Imani Clarke" })).toBe(true);
		expect(closeTo("Imani Clarke", { name: "Imani Clark" })).toBe(true);
	});

	it("closeTo: a shared whole word", () => {
		expect(closeTo("Zed Quill", { name: "Amy Quill" })).toBe(true);
		expect(closeTo("Zed Quill", { name: "Amy Brook" })).toBe(false);
	});

	it("closeTo: a shared word with the preferredName", () => {
		expect(
			closeTo("Bobby Tables", {
				name: "Robert Tables-Xu",
				preferredName: "Bobby",
			}),
		).toBe(true);
	});

	it("nameIsMatchable refuses punctuation-only, empty and one-or-two-letter names", () => {
		expect(nameIsMatchable("!!!")).toBe(false);
		expect(nameIsMatchable("   ")).toBe(false);
		expect(nameIsMatchable("Al")).toBe(false);
		expect(nameIsMatchable("Ali")).toBe(true);
	});

	it("nearName never matches on a name too short to mean anything", () => {
		expect(nearName("!!!", { name: "Anyone" })).toBe(false);
		expect(nearName("A", { name: "Anna" })).toBe(false);
		expect(nearName("Ann", { name: "Anna" })).toBe(true);
	});

	it("sharesContact: email case-insensitively, phone after normalising", () => {
		const m = { email: "A@X.com", phone: "(555) 123-4567" };
		expect(sharesContact(m, { email: "a@x.com", phone: null }, "1")).toBe(true);
		expect(sharesContact(m, { email: null, phone: "+15551234567" }, "1")).toBe(
			true,
		);
		expect(sharesContact(m, { email: "b@x.com", phone: null }, "1")).toBe(
			false,
		);
		expect(sharesContact(m, { email: null, phone: null }, "1")).toBe(false);
	});
});
