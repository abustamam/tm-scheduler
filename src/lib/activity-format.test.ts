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
			action: "some_future_action",
			actorName: "Rasheed",
		} as ActivityEntry;
		expect(formatActivity(e).summary).toBe("some_future_action");
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

	it("member_edit / member_merge / member_remove read sensibly", () => {
		const mk = (action: string) =>
			({
				...base,
				action,
				targetType: "member",
				roleName: null,
				actorName: "Rasheed",
			}) as ActivityEntry;
		expect(formatActivity(mk("member_edit")).summary).toMatch(
			/updated.*details/i,
		);
		expect(formatActivity(mk("member_merge")).summary).toMatch(/merged/i);
		expect(formatActivity(mk("member_remove")).summary).toMatch(/removed/i);
	});

	it("formats meeting_edit variants from detail.change", () => {
		const meetingBase = {
			id: "1",
			action: "meeting_edit",
			createdAt: new Date(),
			actorName: "Rasheed",
			targetType: "meeting" as const,
			roleName: null,
			meetingId: "m",
			meetingScheduledAt: null,
			subjectName: null,
			fromName: null,
			change: null,
		} satisfies ActivityEntry;
		expect(
			formatActivity({ ...meetingBase, change: "speaker_added" }).summary,
		).toBe("added a speaker");
		expect(
			formatActivity({ ...meetingBase, change: "speaker_removed" }).summary,
		).toBe("removed a speaker");
		expect(
			formatActivity({ ...meetingBase, change: "speaker_reordered" }).summary,
		).toBe("reordered speakers");
		expect(formatActivity({ ...meetingBase, change: null }).summary).toBe(
			"updated the meeting",
		);
	});
});
