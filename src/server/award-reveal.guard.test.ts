import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

describe("the award reveal stays session-gated and off the public payload (#1654)", () => {
	it("getAwardReveal resolves the session and hands it to loadAwardReveal", () => {
		// protects=the gate is fed a real session; fails_when=the handler passes a constant or skips getSessionUser; no_claim=what loadAwardReveal decides (the integration suite)
		const src = readSource("src/server/award-reveal.ts");
		expect(src).toContain("getSessionUser()");
		expect(src).toContain("loadAwardReveal(data.meetingId, user?.id ?? null)");
	});

	it("neither the in-room payload, the present route nor the public meeting reader carries award fields", () => {
		// protects=winners (members-only, guest names) never join the public payload; fails_when=any of the three sources mentions awards; no_claim=loadMeetingDetail's own columns (read through the payload test)
		for (const file of [
			"src/lib/in-room-meeting-payload.ts",
			"src/routes/club.$clubId_.meeting.$meetingId.present.tsx",
		]) {
			expect(readSource(file), file).not.toMatch(/award/i);
		}
		const meetings = readSource("src/server/meetings.ts");
		const start = meetings.indexOf("export const getPublicMeetingByKey");
		expect(start).toBeGreaterThan(-1);
		const body = meetings.slice(start, meetings.indexOf("});", start));
		expect(body).not.toMatch(/award/i);
	});
});
