/**
 * The MCP caps, asserted as VALUES (#776 item 1).
 *
 * This is the whole reason the three numbers moved out of the tool modules:
 * while they lived beside `db`, no test could import them, so nothing in the
 * suite disagreed with any value they might have had.
 *
 * The body reader that enforces the last of them is asserted in
 * `request-body-limits.test.ts`, where it moved with the helpers (#800).
 */
import { describe, expect, it } from "vitest";
import {
	MAX_FIND_PEOPLE_RESULTS,
	MAX_GUEST_BOOK_ENTRIES,
	MAX_MCP_BODY_BYTES,
} from "./mcp-limits";

describe("the caps themselves (#776 item 1)", () => {
	it("are the values the tools were shipped with", () => {
		expect(MAX_GUEST_BOOK_ENTRIES).toBe(100);
		expect(MAX_FIND_PEOPLE_RESULTS).toBe(200);
		expect(MAX_MCP_BODY_BYTES).toBe(1_000_000);
	});

	it("are whole positive numbers — a cap of 0 or 1.5 is a bug, not a policy", () => {
		for (const cap of [
			MAX_GUEST_BOOK_ENTRIES,
			MAX_FIND_PEOPLE_RESULTS,
			MAX_MCP_BODY_BYTES,
		]) {
			expect(Number.isSafeInteger(cap)).toBe(true);
			expect(cap).toBeGreaterThan(0);
		}
	});
});
