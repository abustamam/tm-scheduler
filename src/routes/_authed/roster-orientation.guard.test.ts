/**
 * Which roster add starts new-member orientation (#940, maintainer decision),
 * pinned at the two call sites of `bulkImportMembers` in `roster.tsx`.
 *
 * Both dialogs go through the same server fn, and the server's rule is "only
 * an explicit `startOrientation: true` leaves the column to its default"
 * (`orientation.integration.test.ts` exercises that against real rows). What
 * no DB test can see is which dialog sends the flag: the one-row Quick add
 * must, and the paste dialog must not, or a pasted roster of long-standing
 * members all land in orientation. The route cannot be mounted with its
 * server fns live, so this reads each dialog's source, comment-blind.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROSTER = readSource("src/routes/_authed/roster.tsx");

/** One top-level function's text, both ends asserted found. */
function fnText(name: string): string {
	const at = ROSTER.indexOf(`function ${name}(`);
	expect(at, `${name} missing`).toBeGreaterThanOrEqual(0);
	const end = ROSTER.indexOf("\n}\n", at);
	expect(end, `${name}: end not found`).toBeGreaterThan(at);
	return ROSTER.slice(at, end);
}

describe("roster adds and orientation (#940)", () => {
	it("Quick add (AddMemberDialog) sends startOrientation: true", () => {
		const text = fnText("AddMemberDialog");
		expect(text).toMatch(/bulkImportMembers\(/);
		expect(text).toMatch(/startOrientation:\s*true/);
	});

	it("the paste dialog (BulkImportDialog) never sends startOrientation: true", () => {
		const text = fnText("BulkImportDialog");
		expect(text).toMatch(/bulkImportMembers\(/);
		expect(text).not.toMatch(/startOrientation:\s*true/);
	});
});
