/**
 * The MCP caps, asserted as VALUES (#776 item 1).
 *
 * This is the whole reason these numbers moved out of the tool modules:
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
	MAX_ROLE_ASSIGNMENTS,
	MAX_ROLE_SLOT_OPS,
	MAX_ROLE_SLOTS_PER_ADD,
	MAX_ROLE_SLOTS_TOTAL_ADDED,
} from "./mcp-limits";

describe("the caps themselves (#776 item 1)", () => {
	it("are the values the tools were shipped with", () => {
		expect(MAX_GUEST_BOOK_ENTRIES).toBe(100);
		expect(MAX_FIND_PEOPLE_RESULTS).toBe(200);
		expect(MAX_MCP_BODY_BYTES).toBe(1_000_000);
		expect(MAX_ROLE_ASSIGNMENTS).toBe(100);
		expect(MAX_ROLE_SLOT_OPS).toBe(30);
		expect(MAX_ROLE_SLOTS_PER_ADD).toBe(20);
		expect(MAX_ROLE_SLOTS_TOTAL_ADDED).toBe(20);
	});

	it("are whole positive numbers — a cap of 0 or 1.5 is a bug, not a policy", () => {
		for (const cap of [
			MAX_GUEST_BOOK_ENTRIES,
			MAX_FIND_PEOPLE_RESULTS,
			MAX_MCP_BODY_BYTES,
			MAX_ROLE_ASSIGNMENTS,
			MAX_ROLE_SLOT_OPS,
			MAX_ROLE_SLOTS_PER_ADD,
			MAX_ROLE_SLOTS_TOTAL_ADDED,
		]) {
			expect(Number.isSafeInteger(cap)).toBe(true);
			expect(cap).toBeGreaterThan(0);
		}
	});

	it("edit_role_slots ceilings hold as absolute numbers, and the total never exceeds one add's worth of room", () => {
		// Absolute, not relative to each other: raising a cap to 600 must fail here.
		expect(MAX_ROLE_SLOTS_TOTAL_ADDED).toBeLessThanOrEqual(20);
		expect(MAX_ROLE_SLOT_OPS).toBeLessThanOrEqual(30);
		expect(MAX_ROLE_SLOTS_PER_ADD).toBeLessThanOrEqual(20);
		// One add may use the whole budget, but the budget is the binding bound.
		expect(MAX_ROLE_SLOTS_TOTAL_ADDED).toBeLessThanOrEqual(
			MAX_ROLE_SLOTS_PER_ADD,
		);
	});
});
