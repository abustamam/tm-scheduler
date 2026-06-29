import { describe, expect, it } from "vitest";
import type { ActivityEntry } from "#/server/activity-feed";
import { formatActivity } from "./activity-format";

const base = {
	id: "1",
	createdAt: new Date(),
	targetType: "slot",
	roleName: "Timer",
	meetingId: "m",
	meetingScheduledAt: new Date(),
	fromName: null,
	subjectName: null,
} satisfies Partial<ActivityEntry> as ActivityEntry;

describe("formatActivity", () => {
	it("claim names the role", () => {
		const e = {
			...base,
			action: "claim",
			actorName: "Faisal",
			subjectName: "Faisal",
		} as ActivityEntry;
		expect(formatActivity(e).actor).toBe("Faisal");
		expect(formatActivity(e).summary).toMatch(/claimed Timer/i);
	});

	it("reassign shows from → to", () => {
		const e = {
			...base,
			action: "reassign",
			actorName: "Rasheed",
			fromName: "Schinthia",
			subjectName: "Mahbuba",
		} as ActivityEntry;
		expect(formatActivity(e).summary).toMatch(/Schinthia.*→.*Mahbuba/);
	});

	it("release names the role", () => {
		const e = {
			...base,
			action: "release",
			actorName: "Mahbuba",
			fromName: "Mahbuba",
		} as ActivityEntry;
		expect(formatActivity(e).summary).toMatch(/released Timer/i);
	});

	it("member_add quotes the added name", () => {
		const e = {
			...base,
			action: "member_add",
			targetType: "member",
			roleName: null,
			actorName: "Mike",
			subjectName: "Mike",
		} as ActivityEntry;
		expect(formatActivity(e).summary).toMatch(/added member "Mike"/i);
	});

	it("availability_set reads as unavailable", () => {
		const e = {
			...base,
			action: "availability_set",
			targetType: "meeting",
			roleName: null,
			actorName: "Faisal",
		} as ActivityEntry;
		expect(formatActivity(e).summary).toMatch(/unavailable/i);
	});

	it("falls back to the raw action for unknown verbs", () => {
		const e = {
			...base,
			action: "meeting_edit",
			actorName: "Rasheed",
		} as ActivityEntry;
		expect(formatActivity(e).summary).toBe("meeting_edit");
		expect(formatActivity(e).actor).toBe("Rasheed");
	});

	it("defaults a missing actor to 'Someone'", () => {
		const e = {
			...base,
			action: "claim",
			actorName: null,
		} as ActivityEntry;
		expect(formatActivity(e).actor).toBe("Someone");
	});
});
