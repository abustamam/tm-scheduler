import { describe, expect, it } from "vitest";
import { withBeatIds } from "../test/template-beat-ids";
import type { AgendaSlot } from "./agenda-runsheet";
import { resolveAgendaRows } from "./agenda-runsheet";
import {
	buildSlideDeck,
	type ClubForDeck,
	type MeetingForDeck,
} from "./agenda-slides";
import { buildTemplateSlideDeck } from "./agenda-template-slides";
import { CONTEST_TEMPLATE } from "./contest-template";
import { remapSlideIndex } from "./slide-remap";

const meeting: MeetingForDeck = {
	scheduledAt: new Date("2026-06-25T23:45:00Z"),
	theme: null,
	wordOfTheDay: null,
	wodDefinition: null,
	wodExample: null,
	reminders: null,
	tableTopicsNotes: null,
};
const club: ClubForDeck = {
	name: "MCF",
	clubNumber: null,
	district: null,
	timezone: "America/Chicago",
	meetingSchedule: null,
	logoUrl: null,
	tableTopicsMinSeconds: null,
	tableTopicsMaxSeconds: null,
};

function slot(over: Partial<AgendaSlot>): AgendaSlot {
	return {
		id: "s",
		roleName: "Timer",
		category: "functionary",
		isSpeakerRole: false,
		slotIndex: 0,
		assigneeName: null,
		speechTitle: null,
		projectLevel: null,
		minMinutes: null,
		maxMinutes: null,
		evaluatesSlotId: null,
		evaluates: null,
		...over,
	};
}
const speaker = (id: string, i: number, name: string) =>
	slot({
		id,
		roleName: "Speaker",
		roleKey: "speaker",
		category: "speaker",
		isSpeakerRole: true,
		slotIndex: i,
		assigneeName: name,
		minMinutes: 5,
		maxMinutes: 7,
	});
const evaluator = (id: string, i: number, name: string, of: string) =>
	slot({
		id,
		roleName: "Evaluator",
		roleKey: "evaluator",
		category: "speaker",
		isSpeakerRole: true,
		slotIndex: i,
		assigneeName: name,
		evaluatesSlotId: of,
	});

const standard = (slots: AgendaSlot[]) =>
	buildSlideDeck({
		meeting,
		club,
		slots,
		geIntroducesFunctionaries: false,
		ballotUrl: null,
	});

const STANDARD_SLOTS = [
	slot({
		id: "tm",
		roleName: "Toastmaster of the Day",
		roleKey: "toastmaster",
		assigneeName: "Tess",
	}),
	slot({
		id: "ge",
		roleName: "General Evaluator",
		roleKey: "general_evaluator",
		assigneeName: "Gus",
	}),
	speaker("sp1", 0, "Xavier"),
	speaker("sp2", 1, "Yara"),
	evaluator("ev1", 0, "Eve", "sp1"),
	evaluator("ev2", 1, "Eli", "sp2"),
];

const contestSlots = (): AgendaSlot[] => [
	slot({
		id: "c0",
		roleName: "Prepared Speech Contestant",
		roleKey: "contestant_prepared",
		category: "speaker",
		isSpeakerRole: true,
		slotIndex: 0,
		assigneeName: "Ann",
		minMinutes: 5,
		maxMinutes: 7,
	}),
	slot({
		id: "c1",
		roleName: "Prepared Speech Contestant",
		roleKey: "contestant_prepared",
		category: "speaker",
		isSpeakerRole: true,
		slotIndex: 1,
		assigneeName: "Bo",
		minMinutes: 5,
		maxMinutes: 7,
	}),
];
const templated = (slots: AgendaSlot[]) =>
	buildTemplateSlideDeck({
		meeting,
		club,
		slots,
		rows: resolveAgendaRows({
			geIntroducesFunctionaries: false,
			tableTopicsLimits: null,
			template: {
				beats: withBeatIds(CONTEST_TEMPLATE.beats),
				roles: CONTEST_TEMPLATE.roles,
			},
			slots,
		}),
	});

const keysOf = (deck: { key?: string }[]) => deck.map((s) => s.key);

describe("slide keys (#1637)", () => {
	// protects=every slide has an identity and none collides, on both builders;
	// fails_when=a builder skips assignSlideKeys or de-duplication breaks;
	// no_claim=nothing about which key a given slide gets.
	it("are present and unique in a standard and a templated deck", () => {
		for (const deck of [standard(STANDARD_SLOTS), templated(contestSlots())]) {
			const keys = keysOf(deck);
			expect(keys.every((k) => typeof k === "string" && k !== "")).toBe(true);
			expect(new Set(keys).size).toBe(keys.length);
		}
	});

	// protects=a speech or evaluation keeps its identity when a role changes
	// hands; fails_when=the key is built from the person's name or the index;
	// no_claim=nothing about slots appearing or vanishing.
	it("per-slot slides carry the slot id, not the name or position", () => {
		const keys = keysOf(standard(STANDARD_SLOTS));
		expect(keys).toContain("speech:sp1");
		expect(keys).toContain("speech:sp2");
		expect(keys).toContain("evaluation:ev2");
		expect(keys.join("|")).not.toMatch(/Xavier|Yara|Tess/);
		const renamed = STANDARD_SLOTS.map((s) =>
			s.id === "sp2" ? { ...s, assigneeName: "Zed" } : s,
		);
		expect(keysOf(standard(renamed))).toEqual(keys);
	});

	// protects=removing an earlier speaker leaves the later one's key unchanged
	// (so the presenter stays on that person); fails_when=keys renumber;
	// no_claim=nothing about the presenter state itself.
	it("a later speaker's key survives an earlier one's removal", () => {
		const without = STANDARD_SLOTS.filter(
			(s) => s.id !== "sp1" && s.id !== "ev1",
		);
		expect(keysOf(standard(without))).toContain("speech:sp2");
	});

	// protects=a repeated hand-off target is still unique; fails_when=the second
	// occurrence is not numbered; no_claim=which slides repeat in a real deck.
	it("numbers a repeated base key #2, #3 in deck order", () => {
		const deck = templated(contestSlots());
		const keys = keysOf(deck);
		const dupBases = keys.filter((k) => k?.includes("#"));
		expect(dupBases.length).toBeGreaterThan(0);
		for (const k of dupBases) {
			const base = (k as string).split("#")[0];
			expect(keys).toContain(base);
		}
		// The contest's two contestants key by slot, not by a renumbering index.
		expect(keys.some((k) => k?.endsWith("c0"))).toBe(true);
		expect(keys.some((k) => k?.endsWith("c1"))).toBe(true);
	});

	// protects=a templated deck's per-slot beats are keyed by the slot's id;
	// fails_when=the key falls back to the role key or label;
	// no_claim=nothing about beats with no slot.
	it("a templated per-slot beat key carries row.slotId", () => {
		const keys = keysOf(templated(contestSlots()));
		expect(keys).toContain("templateBeat:c0");
		expect(keys).toContain("templateBeat:c1");
	});

	// protects=the presenter stays on the same person's slide when an earlier
	// contestant is removed from a templated deck; fails_when=keys are index
	// based or the remap is by position; no_claim=nothing about the UI.
	it("a templated deck keeps the presenter on the same contestant after an earlier one is removed", () => {
		const before = keysOf(templated(contestSlots())) as string[];
		const at = before.indexOf("templateBeat:c1");
		expect(at).toBeGreaterThan(-1);
		const after = keysOf(
			templated(contestSlots().filter((s) => s.id !== "c0")),
		) as string[];
		const landed = remapSlideIndex(before, after, at);
		expect(after[landed]).toBe("templateBeat:c1");
		expect(landed).not.toBe(at);
	});

	// protects=a hand-off key survives an earlier same-target hand-off dropping
	// when its introducer is unassigned; fails_when=hand-off keys go back to
	// `#n` order; no_claim=nothing about which hand-offs a club shows.
	it("a later hand-off to the same target keeps its slide when an earlier introducer is unassigned", () => {
		const slots = [
			...STANDARD_SLOTS.map((s) =>
				s.id === "tm" ? { ...s, roleKey: "toastmaster_of_the_day" } : s,
			),
			slot({
				id: "ttm",
				roleName: "Table Topics Master",
				roleKey: "table_topics_master",
				assigneeName: "Tam",
			}),
			slot({
				id: "tmr",
				roleName: "Timer",
				roleKey: "timer",
				assigneeName: "Tim",
			}),
		];
		const build = (ss: AgendaSlot[]) =>
			buildSlideDeck({
				meeting,
				club,
				slots: ss,
				geIntroducesFunctionaries: true,
				ballotUrl: null,
			});
		const before = build(slots);
		const geHandoffs = before.filter(
			(s) => s.kind === "handoff" && s.to === "the General Evaluator",
		);
		expect(geHandoffs.length).toBe(2);
		const lateKey = geHandoffs[1].key as string;
		const prevKeys = keysOf(before) as string[];

		// The Toastmaster's slot is removed: the early hand-off (from the TM) drops,
		// the later one (from the Table Topics Master) stays.
		const after = build(slots.filter((s) => s.id !== "tm"));
		const nextKeys = keysOf(after) as string[];
		expect(
			after.filter(
				(s) => s.kind === "handoff" && s.to === "the General Evaluator",
			).length,
		).toBe(1);
		const landed = remapSlideIndex(
			prevKeys,
			nextKeys,
			prevKeys.indexOf(lateKey),
		);
		expect(nextKeys[landed]).toBe(lateKey);
	});
});
