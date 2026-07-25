import { describe, expect, it } from "vitest";
import { meetingUpdateFromForm } from "./meeting-meta-form";

function form(fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	return fd;
}

const ctx = {
	meetingId: "m1",
	actorMemberId: null,
	selfMemberId: null,
	scheduledAt: "2026-07-22T19:00",
};

describe("meetingUpdateFromForm", () => {
	it("passes announcements through as `reminders`, trimming ends but keeping internal newlines", () => {
		const data = meetingUpdateFromForm(
			form({ reminders: "  Bring a guest\nRenew dues  " }),
			ctx,
		);
		expect(data.reminders).toBe("Bring a guest\nRenew dues");
	});

	it("omits reminders (undefined) when the field is blank or absent", () => {
		expect(
			meetingUpdateFromForm(form({ reminders: "   " }), ctx).reminders,
		).toBeUndefined();
		expect(meetingUpdateFromForm(form({}), ctx).reminders).toBeUndefined();
	});

	it("sends a typed meeting number as a number (#358)", () => {
		expect(
			meetingUpdateFromForm(form({ meetingNumber: " 56 " }), ctx).meetingNumber,
		).toBe(56);
	});

	it("sends null for a blank meeting number so it falls back to derived (#358)", () => {
		// Blank is meaningful here, unlike the text fields: it CLEARS the stored
		// number and hands the meeting back to automatic numbering.
		expect(
			meetingUpdateFromForm(form({ meetingNumber: "  " }), ctx).meetingNumber,
		).toBeNull();
	});

	it("omits the meeting number entirely when the field isn't rendered (#358)", () => {
		// The number input is admin-only. A self-serve TMOD's form has no such
		// field at all, and saving their theme edit must NOT wipe the club's
		// meeting number — absent (leave alone) is distinct from blank (clear).
		expect(meetingUpdateFromForm(form({}), ctx).meetingNumber).toBeUndefined();
	});

	it("carries the other meta fields and the provided scheduledAt", () => {
		const data = meetingUpdateFromForm(
			form({ theme: " New Horizons ", lengthMinutes: "75" }),
			ctx,
		);
		expect(data.theme).toBe("New Horizons");
		expect(data.lengthMinutes).toBe(75);
		expect(data.scheduledAt).toBe("2026-07-22T19:00");
		expect(data.meetingId).toBe("m1");
	});
});
