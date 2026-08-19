import { describe, expect, it } from "vitest";
import {
	MAX_ROLE_REPEAT_SLOTS,
	MAX_TEMPLATE_BEATS,
	MAX_TEMPLATE_DETAIL_CHARS,
	MAX_TEMPLATE_LABEL_CHARS,
	MAX_TEMPLATE_ROLES,
} from "./meeting-template-limits";

/**
 * ABSOLUTE ceilings, never stated relative to the constant under test.
 * `expect(x).toBeLessThanOrEqual(MAX)` passes for every value of MAX including
 * one that reintroduces the bug it was written to stop (#519: raising
 * `speakerRows` to 5,000 kept 90/90 green while one request blocked the event
 * loop for 129 seconds).
 */
describe("meeting template limits", () => {
	it("caps beats per template", () => {
		expect(MAX_TEMPLATE_BEATS).toBe(200);
	});

	it("caps roles per template", () => {
		expect(MAX_TEMPLATE_ROLES).toBe(40);
	});

	it("caps the repeat expansion independently of the beat count", () => {
		expect(MAX_ROLE_REPEAT_SLOTS).toBe(20);
	});

	it("caps rendered strings", () => {
		expect(MAX_TEMPLATE_LABEL_CHARS).toBe(120);
		expect(MAX_TEMPLATE_DETAIL_CHARS).toBe(400);
	});

	it("stays reachable from a unit test with no database", () => {
		// The whole reason this module exists. If these constants ever move into a
		// module that imports `#/db`, this file throws `DATABASE_URL is not set`
		// at import and every assertion above silently stops running.
		expect(process.env.DATABASE_URL).toBeUndefined();
		expect(MAX_TEMPLATE_BEATS).toBeGreaterThan(0);
	});
});
