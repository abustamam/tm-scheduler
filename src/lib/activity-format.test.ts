import { describe, expect, it } from "vitest";
import { activityActionEnum } from "#/db/schema";
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
	guestName: null,
	guestLink: false,
	unlinked: false,
} satisfies Partial<ActivityEntry> as ActivityEntry;

describe("formatActivity", () => {
	// #495 added two `activity_action` enum values. `formatActivity`'s outer
	// switch has a `default: summary = entry.action` fallback, so an unhandled
	// action does not throw — it silently renders the raw enum string
	// ("club_logo_set") on the Activity page. These assert the human text, and
	// the raw-string check is what actually fails if the cases are deleted.
	it.each([
		["club_logo_set", /updated the club logo/i],
		["club_logo_removed", /removed the club logo/i],
	])("%s renders human-readable text, not the raw enum", (action, expected) => {
		const e = {
			...base,
			targetType: "club",
			action,
			actorName: "Faisal",
		} as unknown as ActivityEntry;
		const { summary } = formatActivity(e);
		expect(summary).toMatch(expected);
		expect(summary).not.toBe(action);
	});

	// Same shape as the #495 pair above, one enum value later. `logActivity`
	// writes `meeting_template_set` with `targetType: "meeting"` on every
	// conversion in BOTH directions (to a template, and back to the club's
	// standard shape), so the officer who switches a meeting reads this line.
	it("meeting_template_set renders human-readable text, not the raw enum", () => {
		const e = {
			...base,
			targetType: "meeting",
			action: "meeting_template_set",
			actorName: "Faisal",
		} as unknown as ActivityEntry;
		const { summary } = formatActivity(e);
		expect(summary).toMatch(/changed the meeting type/i);
		expect(summary).not.toBe("meeting_template_set");
	});

	// Task 8 (#agenda-templates): an officer can remove a role from a
	// meeting's own agenda editor. Without this case the `default` below
	// renders the raw enum string ("meeting_agenda_role_removed") on the
	// Activity page.
	it("meeting_agenda_role_removed renders human-readable text, not the raw enum", () => {
		const e = {
			...base,
			targetType: "meeting",
			action: "meeting_agenda_role_removed",
			actorName: "Faisal",
		} as unknown as ActivityEntry;
		const { summary } = formatActivity(e);
		expect(summary).toMatch(/removed a role/i);
		expect(summary).not.toBe("meeting_agenda_role_removed");
	});

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

	it("claim by an admin for someone else reads as an assignment", () => {
		const e = {
			...base,
			action: "claim",
			actorName: "Rasheed",
			subjectName: "Sam Chen",
		} as ActivityEntry;
		expect(formatActivity(e).actor).toBe("Rasheed");
		expect(formatActivity(e).summary).toBe("assigned Timer to Sam Chen");
	});

	it("release of someone else's role reads as a removal", () => {
		const e = {
			...base,
			action: "release",
			actorName: "Rasheed",
			fromName: "Sam Chen",
		} as ActivityEntry;
		expect(formatActivity(e).summary).toBe("removed Sam Chen from Timer");
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

	it("availability_set for yourself reads reflexively", () => {
		const e = {
			...base,
			action: "availability_set",
			actorName: "Alex",
			subjectName: "Alex",
		} as ActivityEntry;
		expect(formatActivity(e).summary).toBe("marked themselves unavailable");
	});

	it("availability_set by an officer for someone else names the member", () => {
		const e = {
			...base,
			action: "availability_set",
			actorName: "Jordan",
			subjectName: "Alex Rivera",
		} as ActivityEntry;
		expect(formatActivity(e).summary).toBe("marked Alex Rivera unavailable");
	});

	it("availability_clear by an officer for someone else names the member", () => {
		const e = {
			...base,
			action: "availability_clear",
			actorName: "Jordan",
			subjectName: "Alex Rivera",
		} as ActivityEntry;
		expect(formatActivity(e).summary).toBe(
			"marked Alex Rivera available again",
		);
	});

	it("outreach_set by an officer names the member as contacted", () => {
		const e = {
			...base,
			action: "outreach_set",
			actorName: "Jordan",
			subjectName: "Bob",
		} as ActivityEntry;
		expect(formatActivity(e).summary).toBe("marked Bob contacted");
	});

	it("outreach_clear by an officer un-marks the member as contacted", () => {
		const e = {
			...base,
			action: "outreach_clear",
			actorName: "Jordan",
			subjectName: "Bob",
		} as ActivityEntry;
		expect(formatActivity(e).summary).toBe("marked Bob not contacted");
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

	describe("plan_set", () => {
		it("reads as self-service when the subject is the actor", () => {
			const e = {
				...base,
				action: "plan_set",
				actorName: "Ana Reyes",
				subjectName: "Ana Reyes",
				status: "coming",
			} as ActivityEntry;
			expect(formatActivity(e).summary).toBe("said they're coming");
		});

		it("names the subject when an officer sets it", () => {
			const e = {
				...base,
				action: "plan_set",
				actorName: "Dev Patel",
				subjectName: "Ana Reyes",
				status: "not_coming",
			} as ActivityEntry;
			expect(formatActivity(e).summary).toBe("marked Ana Reyes as not coming");
		});

		it("renders reached_out", () => {
			const e = {
				...base,
				action: "plan_set",
				actorName: "Dev Patel",
				subjectName: "Ana Reyes",
				status: "reached_out",
			} as ActivityEntry;
			expect(formatActivity(e).summary).toBe("reached out to Ana Reyes");
		});

		it("renders a cleared plan", () => {
			const e = {
				...base,
				action: "plan_set",
				actorName: "Dev Patel",
				subjectName: "Ana Reyes",
				status: null,
			} as ActivityEntry;
			expect(formatActivity(e).summary).toBe(
				"cleared Ana Reyes's planned attendance",
			);
		});

		it("reads as self-service when clearing your own plan", () => {
			const e = {
				...base,
				action: "plan_set",
				actorName: "Ana Reyes",
				subjectName: "Ana Reyes",
				status: null,
			} as ActivityEntry;
			expect(formatActivity(e).summary).toBe(
				"cleared their planned attendance",
			);
		});

		it("reads as self-service when marking yourself not coming", () => {
			const e = {
				...base,
				action: "plan_set",
				actorName: "Ana Reyes",
				subjectName: "Ana Reyes",
				status: "not_coming",
			} as ActivityEntry;
			expect(formatActivity(e).summary).toBe("said they can't make it");
		});

		// `entry.status` is `string | null` (loadActivity casts detail with no
		// runtime validation — see activity-feed-logic.ts), so an unrecognized
		// rung (e.g. a future ladder value not yet cased here) type-checks fine
		// and must NOT fall into the null/"cleared" arm — that would say an
		// officer cleared a row they actually just updated.
		it("does not describe an unrecognized rung as a clear", () => {
			const e = {
				...base,
				action: "plan_set",
				actorName: "Dev Patel",
				subjectName: "Ana Reyes",
				status: "some_future_rung",
			} as ActivityEntry;
			expect(formatActivity(e).summary).not.toContain("cleared");
			expect(formatActivity(e).summary).toBe(
				"updated Ana Reyes's planned attendance",
			);
		});
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
			status: null,
			guestName: null,
			guestLink: false,
			unlinked: false,
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
		expect(
			formatActivity({ ...meetingBase, change: "evaluator_reordered" }).summary,
		).toBe("reordered evaluators");
		expect(
			formatActivity({ ...meetingBase, change: "role_added" }).summary,
		).toBe("added a role");
		expect(
			formatActivity({ ...meetingBase, change: "role_removed" }).summary,
		).toBe("removed a role");
		expect(
			formatActivity({ ...meetingBase, change: "template_sync" }).summary,
		).toBe("updated upcoming meetings to match the standard set");
		expect(
			formatActivity({ ...meetingBase, change: "role_disabled" }).summary,
		).toBe("disabled a role for upcoming meetings");
		expect(
			formatActivity({ ...meetingBase, change: "role_enabled" }).summary,
		).toBe("enabled a role for upcoming meetings");
		expect(formatActivity({ ...meetingBase, change: null }).summary).toBe(
			"updated the meeting",
		);
	});

	// `formatActivity`'s outer switch has a `default: summary = entry.action`
	// fallback BY DESIGN — an unknown/future action must not throw — which
	// also means `tsc` cannot flag the switch as non-exhaustive: nothing ties
	// `activityActionEnum` to the cases above. Iterating the REAL enum (rather
	// than a hand-copied list of its values) is what enrolls the next value
	// automatically instead of relying on someone to remember this file, the
	// same "derive from the source of truth" shape as
	// `public-readers-archive-gate.guard.test.ts`'s enrollment sweep.
	describe("every activity_action has a formatter", () => {
		// No waiver list: every `activity_action` value now has a case in
		// `formatActivity`. This sweep started with a `PRE_EXISTING_UNFORMATTED`
		// set covering `superadmin_viewed`/`superadmin_acted`/`vote_open`/
		// `vote_close` (found by writing this sweep in the first place, and
		// waived by name to keep that change scoped); all four gained cases and
		// the waiver was emptied rather than left standing — a waiver list born
		// with entries invites a fifth.
		const covered = activityActionEnum.enumValues;

		// If this is empty the enum itself is empty — a filter bug upstream
		// would otherwise make `it.each([])` below run zero tests and report
		// green.
		it("covers at least one action", () => {
			expect(covered.length).toBeGreaterThan(0);
		});

		it.each(
			covered,
		)("%s renders human-readable text, not the raw enum", (action) => {
			const e = {
				...base,
				action,
				actorName: "Rasheed",
			} as unknown as ActivityEntry;
			expect(formatActivity(e).summary).not.toBe(action);
		});
	});
});
