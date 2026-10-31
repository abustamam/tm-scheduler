// Route wiring pins for the cover link (#1440): the route's own call sites,
// which a component tested through its props cannot see. Comment-blind.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"club.$clubId.meeting.$meetingId.tsx",
);

describe("meeting route: cover wiring (#1440)", () => {
	const src = readSource(ROUTE).replace(/\s+/g, " ");

	it("'I'll take it' refreshes the page after the claim", () => {
		expect(src).toContain("refresh: () => router.invalidate()");
	});

	it("the card and the chips share one over definition, cancelled included", () => {
		expect(src).toContain(
			"const coverOver = coverMeetingOver({ over, status: meeting.status })",
		);
		expect(src).toContain("meetingOver: coverOver,");
		expect(src).toContain("meetingOver={coverOver}");
	});

	it("takes the claim through the same claim call as the agenda", () => {
		expect(src).toContain("await claimAs(me, slot);");
		expect(src).toContain("await claimAs(me, slot, speakerDetails);");
	});
});
