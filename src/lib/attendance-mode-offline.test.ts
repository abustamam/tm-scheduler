/**
 * In person / online (#1049) through the offline write path: the queued op,
 * its optimistic projection (`deriveMinutes`, via the roll seams), and the
 * drain that replays it. Pure — no db, no React.
 */
import { describe, expect, it, vi } from "vitest";
import type { MinutesData } from "#/server/minutes-logic";
import { deriveMinutes } from "./derive-minutes";
import { dispatchOp, type MinutesServerFns } from "./drain-minutes";
import type { MinutesOp } from "./offline-minutes-queue";
import { deriveRollAttendance, deriveRollGuests } from "./roll-attendance";
import { buildRollPanel } from "./roll-panel";

let seq = 0;
function meta() {
	seq += 1;
	return { opId: `mode-op-${seq}`, queuedAt: 5000 + seq };
}

function makeSnapshot(): MinutesData {
	return {
		actionItems: { open: [], resolved: [], openTotal: 0, resolvedTotal: 0 },
		meetingId: "meeting-1",
		clubId: "club-1",
		members: [
			{ memberId: "m-abe", name: "Abe", status: null, hasRole: false },
			// Present with a mode recorded.
			{
				memberId: "m-bea",
				name: "Bea",
				status: "present",
				mode: "in_person",
				hasRole: false,
			},
			// Present from before #1049: no `mode` key at all.
			{ memberId: "m-cy", name: "Cy", status: "present", hasRole: false },
		],
		guests: [
			// Listed only because they hold a role: no attendance row, no mode.
			{ guestId: "g-rose", name: "Rose", fromRole: true },
		],
		tableTopicsSpeakers: [],
		awards: [
			{
				category: "best_speaker",
				memberId: null,
				guestId: null,
				name: null,
				isGuest: false,
			},
			{
				category: "best_evaluator",
				memberId: null,
				guestId: null,
				name: null,
				isGuest: false,
			},
			{
				category: "best_table_topics",
				memberId: null,
				guestId: null,
				name: null,
				isGuest: false,
			},
		],
		awardEligible: {
			best_speaker: { memberIds: [], guestIds: [] },
			best_evaluator: { memberIds: [], guestIds: [] },
			best_table_topics: { memberIds: [], guestIds: [] },
		},
		counts: { present: 2, absent: 0, excused: 0, unmarked: 1, guests: 1 },
	};
}

const member = (d: MinutesData, id: string) =>
	d.members.find((m) => m.memberId === id);

describe("deriveMinutes — mode (#1049)", () => {
	it("an offline-queued toggle replays: present + online moves the mode", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "setAttendance",
				...meta(),
				memberId: "m-bea",
				status: "present",
				mode: "online",
			},
		]);
		expect(member(d, "m-bea")).toMatchObject({
			status: "present",
			mode: "online",
		});
	});

	it("a first Present with the default records that mode", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "setAttendance",
				...meta(),
				memberId: "m-abe",
				status: "present",
				mode: "online",
			},
		]);
		expect(member(d, "m-abe")).toMatchObject({
			status: "present",
			mode: "online",
		});
	});

	it("present → absent clears the mode (decision 4)", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{ type: "setAttendance", ...meta(), memberId: "m-bea", status: "absent" },
		]);
		expect(member(d, "m-bea")?.status).toBe("absent");
		expect(member(d, "m-bea")?.mode ?? null).toBeNull();
	});

	it("present → excused clears it too", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "setAttendance",
				...meta(),
				memberId: "m-bea",
				status: "excused",
			},
		]);
		expect(member(d, "m-bea")?.mode ?? null).toBeNull();
	});

	it("a present op with NO mode (queued before #1049) leaves the mode alone", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "setAttendance",
				...meta(),
				memberId: "m-bea",
				status: "present",
			},
		]);
		expect(member(d, "m-bea")?.mode).toBe("in_person");
	});

	it("never invents a mode for a NULL-mode row", () => {
		const d = deriveMinutes(makeSnapshot(), []);
		expect(member(d, "m-cy")?.mode).toBeUndefined();
	});

	it("a guest toggle on a role-only guest records the mode and an explicit row (decision 3)", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "addGuest",
				...meta(),
				guestId: "g-rose",
				name: "Rose",
				mode: "online",
			},
		]);
		expect(d.guests).toEqual([
			{ guestId: "g-rose", name: "Rose", fromRole: false, mode: "online" },
		]);
	});

	it("a mode-less addGuest on an already-listed guest leaves its mode alone", () => {
		const snap = makeSnapshot();
		snap.guests = [
			{ guestId: "g-rose", name: "Rose", fromRole: false, mode: "online" },
		];
		const d = deriveMinutes(snap, [
			{ type: "addGuest", ...meta(), guestId: "g-rose", name: "Rose" },
		]);
		expect(d.guests[0]?.mode).toBe("online");
	});

	it("a new guest added with a mode carries it", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "addGuest",
				...meta(),
				guestId: "g-new",
				name: "Ned",
				newGuest: { name: "Ned" },
				mode: "in_person",
			},
		]);
		expect(d.guests.find((g) => g.guestId === "g-new")?.mode).toBe("in_person");
	});
});

describe("roll seams carry the projected mode (#1049)", () => {
	it("an offline toggle reaches the roll panel's row and counts line", () => {
		const queue: MinutesOp[] = [
			{
				type: "setAttendance",
				...meta(),
				memberId: "m-bea",
				status: "present",
				mode: "online",
			},
		];
		const input = {
			online: false,
			minutes: null,
			snapshot: makeSnapshot(),
			queue,
		};
		const attendance = deriveRollAttendance(input);
		expect(attendance).toContainEqual({
			memberId: "m-bea",
			status: "present",
			mode: "online",
		});
		// Cy (present, no mode) carries no mode key — not a guessed one.
		expect(attendance.find((a) => a.memberId === "m-cy")).toEqual({
			memberId: "m-cy",
			status: "present",
		});
		const panel = buildRollPanel({
			roster: [
				{ id: "m-abe", name: "Abe", phone: null, email: null },
				{ id: "m-bea", name: "Bea", phone: null, email: null },
				{ id: "m-cy", name: "Cy", phone: null, email: null },
			],
			attendance,
			plan: [],
			roleByMemberId: {},
		});
		expect(panel.rows.find((r) => r.id === "m-bea")?.mode).toBe("online");
		expect(panel.rows.find((r) => r.id === "m-cy")?.mode).toBeNull();
		expect(panel.modeSplit).toEqual({ inPerson: 0, online: 1, unrecorded: 1 });
		expect(panel.countsLine).toBe(
			"2 present (1 online, 1 not recorded) · 1 unmarked",
		);

		const guests = deriveRollGuests({
			...input,
			queue: [
				{
					type: "addGuest",
					...meta(),
					guestId: "g-rose",
					name: "Rose",
					mode: "in_person",
				},
			],
		});
		expect(guests?.[0]).toMatchObject({ fromRole: false, mode: "in_person" });
	});
});

describe("buildRollPanel counts line (#1049)", () => {
	const roster = [
		{ id: "a", name: "A", phone: null, email: null },
		{ id: "b", name: "B", phone: null, email: null },
		{ id: "c", name: "C", phone: null, email: null },
	];

	it("reads exactly as before when no mode is recorded", () => {
		const { countsLine } = buildRollPanel({
			roster,
			attendance: [
				{ memberId: "a", status: "present" },
				{ memberId: "b", status: "present" },
			],
			plan: [],
			roleByMemberId: {},
		});
		expect(countsLine).toBe("2 present · 1 unmarked");
	});

	it("puts Easy-Speak's split inside the present segment", () => {
		const { countsLine } = buildRollPanel({
			roster,
			attendance: [
				{ memberId: "a", status: "present", mode: "in_person" },
				{ memberId: "b", status: "present", mode: "in_person" },
				{ memberId: "c", status: "present", mode: "online" },
			],
			plan: [],
			roleByMemberId: {},
		});
		expect(countsLine).toBe("3 present (2 + 1 online)");
	});

	it("never shows a mode on a row that is not present", () => {
		const { rows, modeSplit } = buildRollPanel({
			roster,
			// A stale mode on an absent row (the server clears it; a stale payload
			// might not have) must not render or count.
			attendance: [{ memberId: "a", status: "absent", mode: "online" }],
			plan: [],
			roleByMemberId: {},
		});
		expect(rows.find((r) => r.id === "a")?.mode).toBeNull();
		expect(modeSplit).toEqual({ inPerson: 0, online: 0, unrecorded: 0 });
	});
});

describe("dispatchOp — mode (#1049)", () => {
	function fakeFns(): MinutesServerFns {
		return {
			setAttendance: vi.fn().mockResolvedValue({ ok: true }),
			addGuest: vi.fn().mockResolvedValue({ ok: true }),
			removeGuest: vi.fn().mockResolvedValue({ ok: true }),
			addTableTopics: vi.fn().mockResolvedValue({ ok: true }),
			removeTableTopics: vi.fn().mockResolvedValue({ ok: true }),
			moveTableTopics: vi.fn().mockResolvedValue({ ok: true }),
			setAward: vi.fn().mockResolvedValue({ ok: true }),
			clearAward: vi.fn().mockResolvedValue({ ok: true }),
		};
	}

	it("forwards a queued toggle's mode to setAttendance", async () => {
		const fns = fakeFns();
		await dispatchOp(
			{
				type: "setAttendance",
				...meta(),
				memberId: "m-bea",
				status: "present",
				mode: "online",
			},
			"meeting-1",
			fns,
		);
		expect(fns.setAttendance).toHaveBeenCalledWith({
			data: {
				meetingId: "meeting-1",
				memberId: "m-bea",
				status: "present",
				mode: "online",
			},
		});
	});

	it("sends NO mode key for an op queued before #1049", async () => {
		const fns = fakeFns();
		await dispatchOp(
			{
				type: "setAttendance",
				...meta(),
				memberId: "m-bea",
				status: "present",
			},
			"meeting-1",
			fns,
		);
		const arg = vi.mocked(fns.setAttendance).mock.calls[0]?.[0];
		expect(arg?.data).not.toHaveProperty("mode");
	});

	it("forwards a guest toggle's mode on both addGuest paths", async () => {
		const fns = fakeFns();
		await dispatchOp(
			{
				type: "addGuest",
				...meta(),
				guestId: "g-rose",
				name: "Rose",
				mode: "online",
			},
			"meeting-1",
			fns,
		);
		await dispatchOp(
			{
				type: "addGuest",
				...meta(),
				guestId: "g-new",
				name: "Ned",
				newGuest: { name: "Ned" },
				mode: "in_person",
			},
			"meeting-1",
			fns,
		);
		expect(fns.addGuest).toHaveBeenNthCalledWith(1, {
			data: { meetingId: "meeting-1", guestId: "g-rose", mode: "online" },
		});
		expect(fns.addGuest).toHaveBeenNthCalledWith(2, {
			data: {
				meetingId: "meeting-1",
				id: "g-new",
				newGuest: { name: "Ned" },
				mode: "in_person",
			},
		});
	});
});
