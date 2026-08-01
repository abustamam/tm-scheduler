import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { guestBookSchema } from "./guest-pipeline-schemas";

/**
 * Bounds on the PUBLIC, session-less guest book. These are a security layer, not
 * cosmetics: the guest-book form sets no `maxLength`, so this schema is the only
 * thing between an anonymous POST and an unbounded `text` column, and it is the
 * second layer behind the `MAX_MATCH_TOKENS` cap in `namesAgree` (#488 review).
 */
describe("guestBookSchema", () => {
	const clubId = randomUUID();

	it("accepts an ordinary submission", () => {
		const parsed = guestBookSchema.parse({
			clubId,
			name: "  Jamie Rivera  ",
			email: "jamie@example.com",
			phone: "555-123-4567",
		});
		expect(parsed.name).toBe("Jamie Rivera");
	});

	it("caps the name at 120 characters", () => {
		expect(
			guestBookSchema.parse({ clubId, name: "x".repeat(120) }).name,
		).toHaveLength(120);
		expect(() =>
			guestBookSchema.parse({ clubId, name: "x".repeat(121) }),
		).toThrow(/too long/i);
	});

	it("still requires a name", () => {
		expect(() => guestBookSchema.parse({ clubId, name: "   " })).toThrow(
			/enter your name/i,
		);
	});

	it("caps email and phone", () => {
		expect(() =>
			guestBookSchema.parse({
				clubId,
				name: "A Guest",
				email: `${"e".repeat(200)}@example.com`,
			}),
		).toThrow();
		expect(() =>
			guestBookSchema.parse({ clubId, name: "A Guest", phone: "1".repeat(41) }),
		).toThrow();
	});

	it("keeps omitted and empty contact fields valid", () => {
		// `.max()` sits before `.optional().or(z.literal(""))`. A guest who fills in
		// neither field must still be able to sign the book.
		expect(guestBookSchema.parse({ clubId, name: "A Guest" })).toMatchObject({
			name: "A Guest",
		});
		expect(
			guestBookSchema.parse({ clubId, name: "A Guest", email: "", phone: "" }),
		).toMatchObject({ email: "", phone: "" });
	});

	it("rejects a malformed club id", () => {
		expect(() =>
			guestBookSchema.parse({ clubId: "nope", name: "A" }),
		).toThrow();
	});
});
