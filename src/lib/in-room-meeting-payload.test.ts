import { describe, expect, it } from "vitest";
import {
	IN_ROOM_NEXT_MEETING_ROLE_FIELDS,
	inRoomNextMeeting,
} from "./in-room-meeting-payload";
import type { NextMeetingSummary } from "./next-meeting-summary";

const next = (
	roles: NextMeetingSummary["roles"],
	toastmaster: NextMeetingSummary["toastmaster"] = null,
): NextMeetingSummary => ({
	scheduledAt: new Date("2026-07-09T23:45:00Z"),
	location: null,
	theme: null,
	meetingNumber: null,
	urlKey: "2026-07-09",
	toastmaster,
	roles,
});

describe("the in-room next meeting keeps the (V) flag (#1164)", () => {
	// protects=/present's next-meeting slide still knows a role holds a visiting
	// Toastmaster after the payload is narrowed, so it can draw its legend; the flag
	// is a boolean the rendered "(V)" already shows, and nothing else rides with it;
	// fails_when=`pickRole` drops `visiting`, or copies a key outside the allowlist;
	// no_claim=the loader path that ships it: join-url-not-on-print-surfaces.guard.test.ts.
	it("carries `visiting` on a role that has one, and omits it otherwise", () => {
		const out = inRoomNextMeeting(
			next(
				[
					{
						label: "Speaker",
						names: ["Jane Doe (V)"],
						openCount: 0,
						visiting: true,
					},
					{ label: "Timer", names: ["Ann Lee"], openCount: 0 },
				],
				{
					label: "Toastmaster",
					names: ["Bo Chen (V)"],
					openCount: 0,
					visiting: true,
				},
			),
		);
		expect(out?.toastmaster?.visiting).toBe(true);
		expect(out?.roles[0]?.visiting).toBe(true);
		expect(out?.roles[1]).toEqual({
			label: "Timer",
			names: ["Ann Lee"],
			openCount: 0,
		});
		expect("visiting" in (out?.roles[1] ?? {})).toBe(false);
	});

	// protects=a role carrying a field OUTSIDE the allowlist (an id, an email: what
	// a loader's row might hold beyond the summary type) does not reach the
	// payload, on the toastmaster and on every role;
	// fails_when=`pickRole` copies the role whole (`{ ...r }`) instead of naming
	// the allowed fields;
	// no_claim=none beyond protects.
	it("drops a field that is not on the allowlist, on the toastmaster and on a role", () => {
		const leaky = (label: string) =>
			({
				label,
				names: ["Ann Lee"],
				openCount: 0,
				personId: "p-123",
				email: "ann@example.com",
			}) as NextMeetingSummary["roles"][number];
		const out = inRoomNextMeeting(next([leaky("Timer")], leaky("Toastmaster")));
		expect(out?.roles[0]).toEqual({
			label: "Timer",
			names: ["Ann Lee"],
			openCount: 0,
		});
		expect(out?.toastmaster).toEqual({
			label: "Toastmaster",
			names: ["Ann Lee"],
			openCount: 0,
		});
		expect(JSON.stringify(out)).not.toContain("p-123");
		expect(JSON.stringify(out)).not.toContain("ann@example.com");
	});

	it("lists `visiting` among the allowed role fields, and no id or contact", () => {
		expect([...IN_ROOM_NEXT_MEETING_ROLE_FIELDS]).toEqual([
			"label",
			"names",
			"openCount",
			"visiting",
		]);
	});
});
