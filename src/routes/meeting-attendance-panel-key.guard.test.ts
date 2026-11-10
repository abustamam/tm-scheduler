import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The panel's chip filter is plain state; a new meeting resets it only because
// the route remounts the panel per meeting id (#1581). A component test cannot
// see the route, so this reads it.
describe("meeting route remounts the attendance panel per meeting (#1581)", () => {
	it("<MeetingAttendancePanel> carries key={meeting.id}", () => {
		// protects=filter reset on meeting change; fails_when=the key is dropped
		// or moved off the meeting id; no_claim=that the panel resets at runtime.
		const src = readFileSync(
			new URL("./club.$clubId.meeting.$meetingId.tsx", import.meta.url),
			"utf8",
		);
		const open = src.match(/<MeetingAttendancePanel\b[^>]*?(?=\broster=)/s);
		expect(open).not.toBeNull();
		expect(open?.[0]).toMatch(/\bkey=\{meeting\.id\}/);
	});
});
