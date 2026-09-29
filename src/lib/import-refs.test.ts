import { describe, expect, it } from "vitest";
import { IMPORT_REF_KINDS, importRefKindSchema } from "./import-refs";

// The contract #1046 hands the importer (#1054's C). The importer's own test
// holds what it writes to this list; this one holds the list to the issue, so
// a kind cannot be dropped or renamed without a failing test saying so.
describe("import_refs kinds", () => {
	it("is exactly the issue's eight kinds", () => {
		expect([...IMPORT_REF_KINDS]).toEqual([
			"meeting",
			"speech",
			"role_slot",
			"guest",
			"person",
			"award",
			"table_topic",
			"attendance",
		]);
	});

	it("the zod enum accepts exactly that list", () => {
		expect(importRefKindSchema.options).toEqual([...IMPORT_REF_KINDS]);
		for (const kind of IMPORT_REF_KINDS) {
			expect(importRefKindSchema.parse(kind)).toBe(kind);
		}
	});

	it("rejects a kind that is not on the list", () => {
		expect(importRefKindSchema.safeParse("member").success).toBe(false);
		expect(importRefKindSchema.safeParse("Meeting").success).toBe(false);
		expect(importRefKindSchema.safeParse("").success).toBe(false);
	});
});
