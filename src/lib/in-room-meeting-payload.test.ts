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

	it("lists `visiting` among the allowed role fields, and no id or contact", () => {
		expect([...IN_ROOM_NEXT_MEETING_ROLE_FIELDS]).toEqual([
			"label",
			"names",
			"openCount",
			"visiting",
		]);
	});
});
