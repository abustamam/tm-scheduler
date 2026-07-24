import { describe, expect, it } from "vitest";
import {
	isMeetingLocked,
	lockedViewer,
	meetingDatePassed,
	meetingDateReached,
	resolveMeetingViewer,
} from "./meeting-lifecycle";
import { meetingViewer } from "./meeting-viewer";

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
			meetingViewer({
				currentMemberId: "m1",
				canManage: false,
				isTmod: true,
				isGrammarian: false,
				isEditableWindow: true,
			}),
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

describe("resolveMeetingViewer", () => {
	const tz = "America/New_York";
	const now = new Date("2026-07-10T12:00:00Z");
	const future = "2026-07-15T18:00:00Z";
	const past = "2026-07-05T18:00:00Z";
	const common = {
		timezone: tz,
		currentMemberId: "m1" as string | null,
		isTmod: false,
		isGrammarian: false,
		now,
	};

	it("admin on a future meeting: full management, editable meta", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "scheduled",
			scheduledAt: future,
			canManage: true,
			isSignedIn: true,
		});
		expect(v.canManage).toBe(true);
		expect(v.canAssign).toBe(true);
		expect(v.canEditMeetingMeta).toBe(true);
	});

	it("admin keeps editing a past-but-open meeting (not locked-wrapped)", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "scheduled",
			scheduledAt: past,
			canManage: true,
			isSignedIn: true,
		});
		expect(v.canManage).toBe(true);
		expect(v.canAssign).toBe(true);
		expect(v.canEditMeetingMeta).toBe(true);
	});

	it("admin on a completed (locked) meeting is read-only", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "completed",
			scheduledAt: past,
			canManage: true,
			isSignedIn: true,
		});
		expect(v.canManage).toBe(false);
		expect(v.canAssign).toBe(false);
		expect(v.canClaim).toBe(false);
	});

	it("signed-in member on a future meeting can claim + take over", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "scheduled",
			scheduledAt: future,
			canManage: false,
			isSignedIn: true,
		});
		expect(v.canManage).toBe(false);
		expect(v.canClaim).toBe(true);
		expect(v.canTakeOver).toBe(true);
		expect(v.canToggleAvailability).toBe(true);
	});

	it("member on a past meeting freezes read-only (over)", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "scheduled",
			scheduledAt: past,
			canManage: false,
			isSignedIn: true,
		});
		expect(v.canClaim).toBe(false);
		expect(v.canToggleAvailability).toBe(false);
	});

	it("anon on a future meeting can claim but not take over", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "scheduled",
			scheduledAt: future,
			canManage: false,
			isSignedIn: false,
		});
		expect(v.canClaim).toBe(true);
		expect(v.canTakeOver).toBe(false);
	});

	it("anon on a past meeting freezes read-only", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "scheduled",
			scheduledAt: past,
			canManage: false,
			isSignedIn: false,
		});
		expect(v.canClaim).toBe(false);
	});
});
