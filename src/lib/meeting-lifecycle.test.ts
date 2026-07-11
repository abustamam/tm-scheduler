import { describe, expect, it } from "vitest";
import {
	isMeetingLocked,
	lockedViewer,
	meetingDatePassed,
	meetingDateReached,
} from "./meeting-lifecycle";
import { selfAssertedViewer } from "./meeting-viewer";

describe("isMeetingLocked", () => {
	it("is true only for a completed meeting", () => {
		expect(isMeetingLocked("completed")).toBe(true);
		expect(isMeetingLocked("scheduled")).toBe(false);
	});
});

describe("meetingDatePassed", () => {
	const tz = "America/New_York";
	const now = new Date("2026-07-10T12:00:00Z");

	it("is true for a meeting whose date is strictly before today", () => {
		expect(meetingDatePassed("2026-07-09T18:00:00Z", tz, now)).toBe(true);
	});

	it("is false on the meeting day itself (still editable that day)", () => {
		expect(meetingDatePassed("2026-07-10T23:00:00Z", tz, now)).toBe(false);
	});

	it("is false for a future meeting", () => {
		expect(meetingDatePassed("2026-07-11T18:00:00Z", tz, now)).toBe(false);
	});

	it("differs from meetingDateReached, which includes today", () => {
		const todayMeeting = "2026-07-10T15:00:00Z";
		expect(meetingDateReached(todayMeeting, tz, now)).toBe(true);
		expect(meetingDatePassed(todayMeeting, tz, now)).toBe(false);
	});
});

describe("lockedViewer", () => {
	it("denies every mutation capability, including claim and own-release", () => {
		const locked = lockedViewer(
			selfAssertedViewer({ memberId: "m1", isTmod: true }),
		);
		expect(locked.currentMemberId).toBe("m1");
		expect(locked.canManage).toBe(false);
		expect(locked.canAssign).toBe(false);
		expect(locked.canManageSpeakers).toBe(false);
		expect(locked.canToggleAvailability).toBe(false);
		expect(locked.canTakeOver).toBe(false);
		expect(locked.canEditOwnSpeech).toBe(false);
		expect(locked.canClaim).toBe(false);
		expect(locked.canReleaseOwn).toBe(false);
	});
});
