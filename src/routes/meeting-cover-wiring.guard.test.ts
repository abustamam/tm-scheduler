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

// The claim and cover handlers moved out of the route into `useMeetingCover`
// (#1476); the chip's render site stays in the route.
const COVER_HOOK = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../components/club/use-meeting-cover.ts",
);

describe("meeting route: cover wiring (#1440)", () => {
	const src = readSource(ROUTE).replace(/\s+/g, " ");
	const hook = readSource(COVER_HOOK).replace(/\s+/g, " ");

	it("'I'll take it' refreshes the page after the claim", () => {
		expect(hook).toContain("refresh: () => router.invalidate()");
	});

	it("the card and the chips share one over definition, cancelled included", () => {
		expect(hook).toContain(
			"const coverOver = coverMeetingOver({ over, status: meeting.status })",
		);
		expect(hook).toContain("meetingOver: coverOver,");
		expect(src).toContain("meetingOver={coverOver}");
	});

	it("each chip sits under its own row, with no strip above the agenda (#1461)", () => {
		expect(src).toContain("slotExtra={coverChipUnderRow}");
		// Structural: exactly one chip render site, defined before the agenda's
		// JSX, so a strip rebuilt anywhere else adds a second `<CoverChip`.
		const sites = src.split("<CoverChip").length - 1;
		expect(sites).toBe(1);
		const site = src.indexOf("<CoverChip");
		expect(site).toBeGreaterThan(src.indexOf("const coverChipUnderRow"));
		expect(site).toBeLessThan(src.indexOf("<MeetingAgenda"));
	});

	it("takes the claim through the same claim call as the agenda", () => {
		expect(hook).toContain("await claimAs(me, slot);");
		expect(hook).toContain("await claimAs(me, slot, speakerDetails);");
	});
});
