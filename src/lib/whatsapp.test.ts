import { describe, expect, it } from "vitest";
import { whatsappHref } from "#/lib/whatsapp";

describe("whatsappHref", () => {
	it("sends mobile to wa.me so the installed app takes over", () => {
		expect(whatsappHref("+14155552671", "mobile")).toBe(
			"https://wa.me/14155552671",
		);
	});

	it("sends desktop straight to WhatsApp Web, not the wa.me interstitial", () => {
		// `wa.me` on a desktop dead-ends on an "open in app" screen (#485).
		const href = whatsappHref("+14155552671", "desktop");
		expect(href).toBe(
			"https://web.whatsapp.com/send/?phone=14155552671&type=phone_number&app_absent=0",
		);
		expect(href).not.toContain("wa.me");
	});

	it("appends an encoded message when one is given, on both platforms", () => {
		expect(whatsappHref("+14155552671", "mobile", "Hi Jane, you're up!")).toBe(
			`https://wa.me/14155552671?text=${encodeURIComponent("Hi Jane, you're up!")}`,
		);
		expect(whatsappHref("+14155552671", "desktop", "Hi Jane, you're up!")).toBe(
			`https://web.whatsapp.com/send/?phone=14155552671&text=${encodeURIComponent(
				"Hi Jane, you're up!",
			)}&type=phone_number&app_absent=0`,
		);
	});

	it("treats an empty message as no message, not an empty prefill", () => {
		expect(whatsappHref("+14155552671", "mobile", "")).toBe(
			"https://wa.me/14155552671",
		);
		expect(whatsappHref("+14155552671", "desktop", "")).toBe(
			"https://web.whatsapp.com/send/?phone=14155552671&type=phone_number&app_absent=0",
		);
	});

	// The fixture matrix is by CHARACTER CLASS, not one happy value — the shapes
	// that actually exist in this database, including what `src/db/seed.ts:874`
	// writes (E.164 with spaces) and a pre-#397 national number.
	it.each([
		["+14155552671", "14155552671"],
		["+1 916 555 0181", "19165550181"],
		["(555) 123-4567", "5551234567"],
		["0044 20 7946 0958", "00442079460958"],
		["+1-415-555-2671", "14155552671"],
	])("strips %s to digits", (input, digits) => {
		expect(whatsappHref(input, "mobile")).toBe(`https://wa.me/${digits}`);
	});

	it.each([
		null,
		undefined,
		"",
		"   ",
		"ask at church",
	])("returns null for %p — there is no chat to open", (input) => {
		expect(whatsappHref(input, "mobile")).toBeNull();
		expect(whatsappHref(input, "desktop")).toBeNull();
	});
});
