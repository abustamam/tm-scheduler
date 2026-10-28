/**
 * #1396: the meeting page's nav strip names the viewed meeting by the server's
 * canonical key, `data.urlKey`. `getMeeting` returns it as a SIBLING of
 * `meeting`, so `deriveMeetingNavItems(data.meeting, …)` alone left the current
 * pill without a key and a meeting sharing a date with a cancelled one got a
 * bare-date pill that opened the other meeting. The types now require the key;
 * this pins the loader's call shape so it is the sibling that is passed.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = "src/routes/club.$clubId.meeting.$meetingId.tsx";

describe("meeting page → nav strip current key wiring (#1396)", () => {
	it("passes data.urlKey as the second argument of deriveMeetingNavItems", () => {
		const calls = [
			...readSource(ROUTE).matchAll(/deriveMeetingNavItems\(([\s\S]*?)\)\s*;/g),
		];
		expect(calls).toHaveLength(1);
		const args = (calls[0]?.[1] ?? "").split(",").map((a) => a.trim());
		expect(args[0]).toBe("data.meeting");
		expect(args[1]).toBe("data.urlKey");
	});
});
