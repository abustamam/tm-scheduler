import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

// `loadMeetingDetail` lives in `meetings.ts`, a `createServerFn` module no test
// can import, so its `answeredRungs` read has no behavioural surface.
// `loadMeetingDetailForTest` (meetings-logic.ts) is the seam that REPEATS the
// read and is covered by `former-member-readers.integration.test.ts`; what this
// pins is that the real loader makes the same ACTIVE-members-only read (#1342),
// because `answeredRungs` is public. Comment-blind: a comment that merely names
// `activeOnly` must not satisfy it.
const source = readSource(resolve(__dirname, "meetings.ts"));

describe("loadMeetingDetail reads plan rows of active members only (#1342)", () => {
	it("passes activeOnly to listPlanForMeetings", () => {
		expect(source).toMatch(
			/listPlanForMeetings\(db,\s*\[meetingId\],\s*\{\s*activeOnly:\s*true,?\s*\}\s*\)/,
		);
	});
});
