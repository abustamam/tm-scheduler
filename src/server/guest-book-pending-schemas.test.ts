/**
 * The confirm page's input schemas PARSE (#806).
 *
 * This suite exists because of a bug it would have caught and nothing else
 * did. `patchSchema` shipped with two `z.discriminatedUnion` members both
 * spelling `kind: "field"` — one for `name`, one for the three optional fields
 * — and zod rejects that. Every edit on the confirm page failed with
 * `Duplicate discriminator value "field"`, and typecheck, lint, the wiring
 * guard and 7,600 other tests were all green: a `createServerFn`'s validator
 * runs only inside the Start runtime, so nothing in this repo could reach it.
 * It was found by opening the page in a browser.
 *
 * MEASURED, and this is the part worth remembering: a guard that only IMPORTED
 * the module stayed green on the same mutation. `z.discriminatedUnion` builds
 * its discriminator map lazily, so the throw lands on the first PARSE, not at
 * construction. The gate has to feed the schema an input.
 *
 * Every case below parses through the SAME exported object the server fn
 * validates with. Restating the shapes here would be the one thing that could
 * not have caught the original bug.
 */
import { describe, expect, it } from "vitest";
import {
	applySchema,
	patchSchema,
	pendingIdSchema,
} from "./guest-book-pending-schemas";

// Real v4 UUIDs. zod's `uuid()` checks the version and variant nibbles, so a
// made-up `1111…-2222-…` string fails for a reason that has nothing to do with
// what these cases are about — and both columns are `gen_random_uuid()`, which
// is v4.
const PENDING = "221ae09c-cc89-4f32-ad43-c395b8ad39bc";
const GUEST = "fcf60fa6-d30a-47e3-971f-40a6df79e97c";

describe("patchSchema (#806)", () => {
	// THE case. Each of the four fields has to reach the one `field` branch; a
	// second branch discriminated on the same key is what broke, and a schema
	// that accepts only some of them is the other way to get this wrong.
	for (const field of ["name", "preferredName", "email", "phone"] as const) {
		it(`accepts an edit to \`${field}\``, () => {
			const parsed = patchSchema.safeParse({
				pendingId: PENDING,
				edit: { kind: "field", id: "e1", field, value: "  Vera Real  " },
			});
			expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
			// Trimmed on the way in, so the reducer's comparison against the stored
			// value is not defeated by whitespace.
			expect(
				parsed.success && parsed.data.edit.kind === "field"
					? parsed.data.edit.value
					: null,
			).toBe("Vera Real");
		});
	}

	it("lets an optional field be cleared, and refuses to clear a name", () => {
		// An emptied optional field is how a line says "no phone after all"; the
		// reducer deletes it. A name has no empty form — a guest row with an empty
		// name is a write nothing downstream can undo.
		expect(
			patchSchema.safeParse({
				pendingId: PENDING,
				edit: { kind: "field", id: "e1", field: "phone", value: "" },
			}).success,
		).toBe(true);

		const blankName = patchSchema.safeParse({
			pendingId: PENDING,
			edit: { kind: "field", id: "e1", field: "name", value: "   " },
		});
		expect(blankName.success).toBe(false);
		expect(blankName.error?.issues[0]?.path).toEqual(["edit", "value"]);
	});

	it("accepts both answers to an ambiguity, and un-answering", () => {
		for (const resolve of [
			{ kind: "existing", guestId: GUEST },
			{ kind: "new" },
			null,
		]) {
			const parsed = patchSchema.safeParse({
				pendingId: PENDING,
				edit: { kind: "resolve", id: "e1", resolve },
			});
			expect(parsed.success, JSON.stringify(resolve)).toBe(true);
		}
	});

	it("accepts a drop and a restore", () => {
		for (const dropped of [true, false]) {
			expect(
				patchSchema.safeParse({
					pendingId: PENDING,
					edit: { kind: "dropped", id: "e1", dropped },
				}).success,
			).toBe(true);
		}
	});

	it("refuses an unknown edit kind, an unknown field, and a bad guest id", () => {
		expect(
			patchSchema.safeParse({
				pendingId: PENDING,
				edit: { kind: "delete", id: "e1" },
			}).success,
		).toBe(false);
		expect(
			patchSchema.safeParse({
				pendingId: PENDING,
				edit: { kind: "field", id: "e1", field: "stage", value: "joined" },
			}).success,
		).toBe(false);
		expect(
			patchSchema.safeParse({
				pendingId: PENDING,
				edit: {
					kind: "resolve",
					id: "e1",
					resolve: { kind: "existing", guestId: "not-a-uuid" },
				},
			}).success,
		).toBe(false);
	});

	it("bounds the value, so a padded payload cannot ride to the logic layer", () => {
		expect(
			patchSchema.safeParse({
				pendingId: PENDING,
				edit: {
					kind: "field",
					id: "e1",
					field: "email",
					value: "x".repeat(321),
				},
			}).success,
		).toBe(false);
	});
});

describe("the other two schemas (#806)", () => {
	it("pendingIdSchema takes a uuid and nothing else", () => {
		expect(pendingIdSchema.safeParse({ pendingId: PENDING }).success).toBe(
			true,
		);
		expect(pendingIdSchema.safeParse({ pendingId: "nope" }).success).toBe(
			false,
		);
	});

	it("applySchema requires a non-empty planHash", () => {
		expect(
			applySchema.safeParse({ pendingId: PENDING, planHash: "a".repeat(64) })
				.success,
		).toBe(true);
		expect(
			applySchema.safeParse({ pendingId: PENDING, planHash: "" }).success,
		).toBe(false);
	});
});
