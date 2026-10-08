import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	canSeeMeetingReadiness,
	type MeetingReadiness,
	meetingReadiness,
	type ReadinessItem,
	type ReadinessSlot,
	showsMeetingReadiness,
} from "#/lib/meeting-readiness";
import { dutiesForRole } from "#/lib/role-duties";

type MeetingFields = Parameters<typeof meetingReadiness>[0]["meeting"];

const FILLED_MEETING: MeetingFields = {
	theme: "Beginnings",
	wordOfTheDay: "ephemeral",
	tableTopicsNotes: "Ask about firsts",
};
const EMPTY_MEETING: MeetingFields = {
	theme: null,
	wordOfTheDay: null,
	tableTopicsNotes: null,
};

let seq = 0;
function slot(overrides: Partial<ReadinessSlot> = {}): ReadinessSlot {
	seq += 1;
	return {
		id: `slot-${seq}`,
		roleName: "Ah-Counter",
		roleKey: null,
		slotIndex: 0,
		slotsUnordered: false,
		status: "confirmed",
		assigneeName: "Pat",
		speechTitle: null,
		...overrides,
	};
}

const tmod = (o: Partial<ReadinessSlot> = {}) =>
	slot({
		roleName: "Toastmaster of the Day",
		roleKey: "toastmaster_of_the_day",
		...o,
	});
const grammarian = (o: Partial<ReadinessSlot> = {}) =>
	slot({ roleName: "Grammarian", roleKey: "grammarian", ...o });
const topicsMaster = (o: Partial<ReadinessSlot> = {}) =>
	slot({
		roleName: "Table Topics Master",
		roleKey: "table_topics_master",
		...o,
	});
const speaker = (o: Partial<ReadinessSlot> = {}) =>
	slot({
		roleName: "Speaker",
		roleKey: "speaker",
		speechTitle: "My Ice Breaker",
		...o,
	});
const timer = (o: Partial<ReadinessSlot> = {}) =>
	slot({ roleName: "Timer", roleKey: "timer", ...o });

const item = (r: MeetingReadiness, id: ReadinessItem["id"]) =>
	r.items.find((i) => i.id === id);

describe("meetingReadiness (#963)", () => {
	it("returns the items in the spec's order, each with its counts", () => {
		const r = meetingReadiness({
			meeting: FILLED_MEETING,
			slots: [
				tmod(),
				grammarian(),
				topicsMaster(),
				speaker({ slotIndex: 0 }),
				speaker({ slotIndex: 1 }),
			],
		});
		expect(r.items.map((i) => i.id)).toEqual([
			"roles_filled",
			"roles_confirmed",
			"meeting_theme",
			"word_of_the_day",
			"table_topics",
			"speech_details",
		]);
		expect(r.items.map((i) => i.label)).toEqual([
			"Roles filled",
			"Roles confirmed",
			"Theme set",
			"Word of the Day set",
			"Table Topics set",
			"Speech details added",
		]);
		expect(r.items.map((i) => [i.doneCount, i.total])).toEqual([
			[5, 5],
			[5, 5],
			[1, 1],
			[1, 1],
			[1, 1],
			[2, 2],
		]);
		expect(r.ready).toBe(true);
		expect(r.items.every((i) => i.done && i.gaps.length === 0)).toBe(true);
	});

	it("an open slot is a roles_filled gap with a null holder, and not a roles_confirmed one", () => {
		const open = slot({
			roleName: "Ah-Counter",
			status: "open",
			assigneeName: null,
		});
		const r = meetingReadiness({
			meeting: EMPTY_MEETING,
			slots: [open, slot({ roleName: "Evaluator", status: "confirmed" })],
		});
		const filled = item(r, "roles_filled");
		expect(filled?.total).toBe(2);
		expect(filled?.doneCount).toBe(1);
		expect(filled?.done).toBe(false);
		expect(filled?.gaps).toEqual([
			{ slotId: open.id, slotLabel: "Ah-Counter", holderName: null },
		]);
		// An open slot is not "held", so it is outside the confirmed denominator.
		expect(item(r, "roles_confirmed")?.total).toBe(1);
		expect(item(r, "roles_confirmed")?.gaps).toEqual([]);
	});

	it("a claimed slot is a roles_confirmed gap naming its holder; a confirmed slot is neither", () => {
		const claimed = slot({ status: "claimed", assigneeName: "Sam" });
		const confirmed = slot({
			roleName: "Evaluator",
			status: "confirmed",
			assigneeName: "Lee",
		});
		const r = meetingReadiness({
			meeting: EMPTY_MEETING,
			slots: [claimed, confirmed],
		});
		expect(item(r, "roles_filled")?.gaps).toEqual([]);
		expect(item(r, "roles_confirmed")?.total).toBe(2);
		expect(item(r, "roles_confirmed")?.doneCount).toBe(1);
		expect(item(r, "roles_confirmed")?.gaps).toEqual([
			{ slotId: claimed.id, slotLabel: "Ah-Counter", holderName: "Sam" },
		]);
		expect(r.ready).toBe(false);
	});

	it("a whitespace theme and a speech title isRealSpeechTitle rejects are NOT done, as /me says", () => {
		const blankTitle = speaker({ slotIndex: 0, speechTitle: "TBA" });
		const spaceTitle = speaker({ slotIndex: 1, speechTitle: "   " });
		const nullTitle = speaker({ slotIndex: 2, speechTitle: null });
		const real = speaker({ slotIndex: 3, speechTitle: "Real title" });
		const r = meetingReadiness({
			meeting: { ...FILLED_MEETING, theme: "  " },
			slots: [tmod(), blankTitle, spaceTitle, nullTitle, real],
		});
		expect(item(r, "meeting_theme")?.done).toBe(false);
		expect(item(r, "meeting_theme")?.gaps.map((g) => g.slotLabel)).toEqual([
			"Toastmaster of the Day",
		]);
		const speech = item(r, "speech_details");
		expect(speech?.total).toBe(4);
		expect(speech?.doneCount).toBe(1);
		expect(speech?.gaps.map((g) => g.slotId)).toEqual([
			blankTitle.id,
			spaceTitle.id,
			nullTitle.id,
		]);
	});

	it("never reports the Timer's timing duty: no `timing` item, and the meeting can be ready", () => {
		const r = meetingReadiness({
			meeting: FILLED_MEETING,
			slots: [timer(), tmod()],
		});
		expect(r.items.map((i) => i.id)).not.toContain("timing");
		expect(r.items.map((i) => i.id)).toEqual([
			"roles_filled",
			"roles_confirmed",
			"meeting_theme",
		]);
		// The Timer slot does own a duty; it is the view that declines it.
		expect(dutiesForRole(timer()).map((d) => d.id)).toEqual(["timing"]);
		expect(r.ready).toBe(true);
	});

	it("two slots owning table_topics make ONE item with total 1, naming the first owner", () => {
		const first = topicsMaster({ assigneeName: "Ada" });
		const second = topicsMaster({ slotIndex: 1, assigneeName: "Bo" });
		const r = meetingReadiness({
			meeting: EMPTY_MEETING,
			slots: [first, second],
		});
		const topics = r.items.filter((i) => i.id === "table_topics");
		expect(topics).toHaveLength(1);
		expect(topics[0]?.total).toBe(1);
		expect(topics[0]?.doneCount).toBe(0);
		expect(topics[0]?.gaps).toEqual([
			{
				slotId: first.id,
				slotLabel: "Table Topics Master 1",
				holderName: "Ada",
			},
		]);
		// Once set, it is done and never double counted.
		const done = meetingReadiness({
			meeting: FILLED_MEETING,
			slots: [first, second],
		});
		expect(item(done, "table_topics")?.doneCount).toBe(1);
		expect(item(done, "table_topics")?.total).toBe(1);
	});

	it("omits an item with nothing to measure instead of showing it as done", () => {
		const r = meetingReadiness({
			meeting: EMPTY_MEETING,
			slots: [slot({ status: "open", assigneeName: null })],
		});
		// No TMOD, Grammarian, Table Topics Master or speaker slot: no duty items.
		expect(r.items.map((i) => i.id)).toEqual(["roles_filled"]);
		// All open: no held slot to confirm, so no roles_confirmed line either.
		expect(item(r, "roles_confirmed")).toBeUndefined();
		expect(item(r, "word_of_the_day")).toBeUndefined();
	});

	it("a duty applies to an open slot too, and its gap holder is null", () => {
		const openGrammarian = grammarian({ status: "open", assigneeName: null });
		const r = meetingReadiness({
			meeting: EMPTY_MEETING,
			slots: [openGrammarian],
		});
		expect(item(r, "word_of_the_day")?.gaps).toEqual([
			{ slotId: openGrammarian.id, slotLabel: "Grammarian", holderName: null },
		]);
	});

	it("keeps the input order and never sorts", () => {
		const a = slot({ roleName: "Zebra", status: "open", assigneeName: null });
		const b = slot({ roleName: "Alpha", status: "open", assigneeName: null });
		const c = slot({ roleName: "Mid", status: "open", assigneeName: null });
		const r = meetingReadiness({ meeting: EMPTY_MEETING, slots: [a, b, c] });
		expect(item(r, "roles_filled")?.gaps.map((g) => g.slotId)).toEqual([
			a.id,
			b.id,
			c.id,
		]);
	});

	it("labels a repeated role with its number, counted over the whole input", () => {
		const s1 = speaker({
			slotIndex: 0,
			speechTitle: "TBA",
			assigneeName: "Pat",
		});
		const s2 = speaker({
			slotIndex: 1,
			speechTitle: "TBA",
			assigneeName: "Kim",
		});
		const r = meetingReadiness({ meeting: FILLED_MEETING, slots: [s1, s2] });
		expect(item(r, "speech_details")?.gaps).toEqual([
			{ slotId: s1.id, slotLabel: "Speaker 1", holderName: "Pat" },
			{ slotId: s2.id, slotLabel: "Speaker 2", holderName: "Kim" },
		]);
	});

	it("gives an unordered role a label with no number, the same as the agenda (#624)", () => {
		const contestants = [0, 1, 2].map((i) =>
			slot({
				roleName: "Contestant",
				roleKey: "contestant_prepared",
				slotIndex: i,
				slotsUnordered: true,
				speechTitle: "TBA",
				assigneeName: `C${i}`,
			}),
		);
		const r = meetingReadiness({
			meeting: EMPTY_MEETING,
			slots: contestants,
		});
		expect(item(r, "speech_details")?.gaps.map((g) => g.slotLabel)).toEqual([
			"Contestant",
			"Contestant",
			"Contestant",
		]);
	});

	it("a guest holder's gap carries the display name and nothing else", () => {
		const guestHeld = slot({
			status: "claimed",
			assigneeName: "Gina Guest",
		});
		const r = meetingReadiness({ meeting: EMPTY_MEETING, slots: [guestHeld] });
		const gap = item(r, "roles_confirmed")?.gaps[0];
		expect(gap).toEqual({
			slotId: guestHeld.id,
			slotLabel: "Ah-Counter",
			holderName: "Gina Guest",
		});
		expect(Object.keys(gap ?? {}).sort()).toEqual([
			"holderName",
			"slotId",
			"slotLabel",
		]);
	});

	it("is not ready while any included item is not done, and ready only when all are", () => {
		const base = [tmod(), speaker()];
		expect(
			meetingReadiness({ meeting: FILLED_MEETING, slots: base }).ready,
		).toBe(true);
		expect(
			meetingReadiness({
				meeting: { ...FILLED_MEETING, theme: null },
				slots: base,
			}).ready,
		).toBe(false);
		expect(
			meetingReadiness({
				meeting: FILLED_MEETING,
				slots: [...base, slot({ status: "claimed" })],
			}).ready,
		).toBe(false);
	});

	it("a meeting with no slots is vacuously ready, with no items", () => {
		const r = meetingReadiness({ meeting: EMPTY_MEETING, slots: [] });
		expect(r).toEqual({ ready: true, items: [] });
	});
});

describe("meetingReadiness agrees with /me's dutiesForRole (#963)", () => {
	// The panel and a role holder's own checklist read the same registry, so for
	// each duty-owning role the SAME context must give the same answer in both.
	const cases: {
		name: string;
		build: () => ReadinessSlot;
		itemId: ReadinessItem["id"];
		ctxDone: {
			meeting: MeetingFields;
			speechTitle: string | null;
		};
		ctxNotDone: {
			meeting: MeetingFields;
			speechTitle: string | null;
		};
	}[] = [
		{
			name: "Toastmaster of the Day",
			build: () => tmod(),
			itemId: "meeting_theme",
			ctxDone: { meeting: FILLED_MEETING, speechTitle: null },
			ctxNotDone: {
				meeting: { ...FILLED_MEETING, theme: " \t " },
				speechTitle: null,
			},
		},
		{
			name: "Grammarian",
			build: () => grammarian(),
			itemId: "word_of_the_day",
			ctxDone: { meeting: FILLED_MEETING, speechTitle: null },
			ctxNotDone: {
				meeting: { ...FILLED_MEETING, wordOfTheDay: null },
				speechTitle: null,
			},
		},
		{
			name: "Table Topics Master",
			build: () => topicsMaster(),
			itemId: "table_topics",
			ctxDone: { meeting: FILLED_MEETING, speechTitle: null },
			ctxNotDone: {
				meeting: { ...FILLED_MEETING, tableTopicsNotes: "" },
				speechTitle: null,
			},
		},
		{
			name: "Speaker",
			build: () => speaker(),
			itemId: "speech_details",
			ctxDone: { meeting: FILLED_MEETING, speechTitle: "A real title" },
			ctxNotDone: { meeting: FILLED_MEETING, speechTitle: "TBA" },
		},
	];

	for (const c of cases) {
		it(`${c.name}: the panel item is done exactly when the role's own duty is`, () => {
			for (const [label, ctx] of [
				["done", c.ctxDone],
				["not done", c.ctxNotDone],
			] as const) {
				const s = { ...c.build(), speechTitle: ctx.speechTitle };
				const duty = dutiesForRole(s)[0];
				expect(duty, `${c.name} owns a duty`).toBeDefined();
				const meId = duty?.done({
					theme: ctx.meeting.theme,
					wordOfTheDay: ctx.meeting.wordOfTheDay,
					tableTopicsNotes: ctx.meeting.tableTopicsNotes,
					speechTitle: ctx.speechTitle,
				});
				const panel = item(
					meetingReadiness({ meeting: ctx.meeting, slots: [s] }),
					c.itemId,
				);
				expect(panel?.done, `${c.name} ${label}`).toBe(meId);
			}
			// Non-vacuity: the two contexts really do disagree, so the loop above
			// compared a true and a false rather than the same answer twice.
			const outcomes = [c.ctxDone, c.ctxNotDone].map(
				(ctx) =>
					item(
						meetingReadiness({
							meeting: ctx.meeting,
							slots: [{ ...c.build(), speechTitle: ctx.speechTitle }],
						}),
						c.itemId,
					)?.done,
			);
			expect(outcomes).toEqual([true, false]);
		});
	}
});

describe("showsMeetingReadiness (#963)", () => {
	// 2026-10-10 is a Saturday; 23:00 UTC is 19:00 that evening in New York.
	const scheduledAt = new Date("2026-10-10T23:00:00Z");
	const timezone = "America/New_York";

	it("is true for a scheduled meeting in the future", () => {
		expect(
			showsMeetingReadiness({
				status: "scheduled",
				scheduledAt,
				timezone,
				now: new Date("2026-10-03T12:00:00Z"),
			}),
		).toBe(true);
	});

	it("is true on the meeting's own club-local day, even after its start time", () => {
		expect(
			showsMeetingReadiness({
				status: "scheduled",
				scheduledAt,
				timezone,
				now: new Date("2026-10-11T02:00:00Z"), // 22:00 on the 10th in New York
			}),
		).toBe(true);
	});

	it("is false for a scheduled meeting whose club-local date has passed", () => {
		expect(
			showsMeetingReadiness({
				status: "scheduled",
				scheduledAt,
				timezone,
				now: new Date("2026-10-11T12:00:00Z"),
			}),
		).toBe(false);
	});

	it("is false for cancelled and completed meetings, whatever the date", () => {
		const now = new Date("2026-10-03T12:00:00Z");
		for (const status of ["cancelled", "completed"]) {
			expect(
				showsMeetingReadiness({ status, scheduledAt, timezone, now }),
			).toBe(false);
		}
	});

	it("reads the club's timezone, not UTC, for the day boundary", () => {
		// 03:00 UTC on the 11th is still the 10th in Los Angeles (20:00), and
		// already the 11th in Tokyo (12:00).
		const now = new Date("2026-10-11T03:00:00Z");
		const la = "America/Los_Angeles";
		// 03:00 on the 10th in LA, but 19:00 on the 10th in Tokyo.
		const laScheduled = new Date("2026-10-10T10:00:00Z");
		expect(
			showsMeetingReadiness({
				status: "scheduled",
				scheduledAt: laScheduled,
				timezone: la,
				now,
			}),
		).toBe(true);
		expect(
			showsMeetingReadiness({
				status: "scheduled",
				scheduledAt: laScheduled,
				timezone: "Asia/Tokyo",
				now,
			}),
		).toBe(false);
	});
});

describe("canSeeMeetingReadiness (#963 AC 8)", () => {
	const table: [boolean, boolean, boolean, boolean][] = [
		// canManage, previewAsMember, isTmod, result
		[true, false, false, true],
		[true, true, false, false],
		[true, true, true, true],
		[false, false, true, true],
		[false, false, false, false],
	];
	for (const [canManage, previewAsMember, isTmod, result] of table) {
		it(`canManage=${canManage} previewAsMember=${previewAsMember} isTmod=${isTmod} -> ${result}`, () => {
			expect(
				canSeeMeetingReadiness({ canManage, previewAsMember, isTmod }),
			).toBe(result);
		});
	}

	it("covers every combination of the three flags the same way as the table", () => {
		for (const canManage of [true, false]) {
			for (const previewAsMember of [true, false]) {
				for (const isTmod of [true, false]) {
					expect(
						canSeeMeetingReadiness({ canManage, previewAsMember, isTmod }),
					).toBe((canManage && !previewAsMember) || isTmod);
				}
			}
		}
	});
});

describe("meeting-readiness stays db-free (#963)", () => {
	// The panel runs in the browser; a module that reaches the database layer
	// cannot be imported by a client route (the driver drags `Buffer` in and
	// white-screens the page). An OFFENDER-list check, so it reads the raw file:
	// a comment can only make it fail, never pass.
	it("imports only other src/lib modules", () => {
		const source = readFileSync("src/lib/meeting-readiness.ts", "utf8");
		const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
			(m) => m[1],
		);
		expect(specifiers.sort()).toEqual([
			"#/lib/agenda",
			"#/lib/meeting-lifecycle",
			"#/lib/role-duties",
		]);
	});

	it("never defaults a clock: showsMeetingReadiness gets its `now` from the caller", () => {
		const source = readFileSync("src/lib/meeting-readiness.ts", "utf8");
		expect(source).not.toMatch(/new Date\(\)|Date\.now\(\)/);
	});
});
