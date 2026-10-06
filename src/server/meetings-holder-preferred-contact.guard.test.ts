/**
 * #1094: `loadMeetingDetail` (`meetings.ts`) copies the holder's effective
 * preferred contact from `loadHolderContacts` onto each slot. A `createServerFn`
 * cannot be invoked from vitest, so this reads the source: severing the copy
 * leaves every other test green and the agenda silently falls back to the
 * classic two buttons.
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

describe("meeting slot holder preferred contact (#1094)", () => {
	it("copies the effective value from the holder contact onto the slot", () => {
		const src = readSource(resolve(__dirname, "meetings.ts"));
		expect(src).toMatch(
			/holderPreferredContact:\s*c\?\.preferredContact\s*\?\?\s*null/,
		);
	});
});
