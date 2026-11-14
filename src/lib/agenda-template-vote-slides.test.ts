/**
 * Vote slides on a TEMPLATED deck (#1635). A beat marked with an
 * `awardCategory` projects the matching vote slide with the ballot QR; an
 * unmarked beat (every contest beat) projects none.
 */
import { describe, expect, it } from "vitest";
import { awardCategoryEnum } from "#/db/schema";
import { materialiseRunOfShow } from "#/lib/agenda-materialise";
import type { AgendaSlot } from "#/lib/agenda-runsheet";
import { resolveAgendaRows } from "#/lib/agenda-runsheet";
import type { ClubForDeck, MeetingForDeck, Slide } from "#/lib/agenda-slides";
import { buildTemplateSlideDeck } from "#/lib/agenda-template-slides";
import { AWARD_CATEGORIES } from "#/lib/award-categories";
import { CONTEST_TEMPLATE } from "#/lib/contest-template";
import { withBeatIds } from "#/test/template-beat-ids";

const meeting: MeetingForDeck = {
	scheduledAt: new Date("2026-09-10T01:00:00Z"),
	theme: null,
	wordOfTheDay: null,
	wodDefinition: null,
	wodExample: null,
	reminders: null,
	tableTopicsNotes: null,
};
const club: ClubForDeck = {
	name: "Club",
	logoUrl: null,
	clubNumber: "1",
	district: "D1",
	timezone: "America/Chicago",
	meetingSchedule: "Thursdays",
	tableTopicsMinSeconds: null,
	tableTopicsMaxSeconds: null,
};

const BALLOT = "https://example.test/ballot/abc";

function slot(
	roleKey: string,
	roleName: string,
	i: number,
	name: string | null,
	over: Partial<AgendaSlot> = {},
): AgendaSlot {
	return {
		id: `${roleKey}-${i}`,
		roleName,
		roleKey,
		category: "leadership",
		isSpeakerRole: roleKey === "speaker",
		slotIndex: i,
		assigneeName: name,
		speechTitle: null,
		projectLevel: null,
		minMinutes: null,
		maxMinutes: null,
		evaluatesSlotId: null,
		evaluates: null,
		...over,
	};
}

const slots: AgendaSlot[] = [
	slot("toastmaster_of_the_day", "Toastmaster of the Day", 0, "Tess"),
	slot("table_topics_master", "Table Topics Master", 0, "Tom"),
	slot("general_evaluator", "General Evaluator", 0, "Gina"),
	slot("timer", "Timer", 0, "Tim"),
	slot("speaker", "Speaker", 0, "Sam", { minMinutes: 5, maxMinutes: 7 }),
	slot("speaker", "Speaker", 1, "Sue", { minMinutes: 5, maxMinutes: 7 }),
	slot("evaluator", "Evaluator", 0, "Eve"),
];

const roles = [
	["toastmaster_of_the_day", "Toastmaster of the Day", false],
	["table_topics_master", "Table Topics Master", false],
	["general_evaluator", "General Evaluator", false],
	["timer", "Timer", false],
	["speaker", "Speaker", true],
	["evaluator", "Evaluator", false],
].map(([key, name, isSpeakerRole]) => ({
	key: key as string,
	name: name as string,
	isSpeakerRole: isSpeakerRole as boolean,
}));

function standardDeck(
	over: {
		ballotUrl?: string | null;
		stripCategory?: boolean;
		/** The slots the DECK sees; the rows are always resolved from the full set. */
		deckSlots?: AgendaSlot[];
	} = {},
): Slide[] {
	const seeds = materialiseRunOfShow(false, null).map((s) =>
		over.stripCategory ? { ...s, awardCategory: null } : s,
	);
	const rows = resolveAgendaRows({
		geIntroducesFunctionaries: false,
		tableTopicsLimits: null,
		template: { beats: withBeatIds(seeds), roles },
		slots,
	});
	return buildTemplateSlideDeck({
		meeting,
		club,
		rows,
		slots: over.deckSlots ?? slots,
		ballotUrl: over.ballotUrl === undefined ? BALLOT : over.ballotUrl,
	});
}

describe("AWARD_CATEGORIES", () => {
	it("is exactly the award_category enum's values, in order", () => {
		expect([...awardCategoryEnum.enumValues]).toEqual([...AWARD_CATEGORIES]);
	});
});

describe("materialiseRunOfShow marks the three vote beats (#1635)", () => {
	it("sets award_category on exactly the vote beats, null elsewhere", () => {
		const marked = materialiseRunOfShow(false, null)
			.filter((s) => s.awardCategory != null)
			.map((s) => [s.roleKey, s.awardCategory]);
		expect(marked).toEqual([
			["toastmaster_of_the_day", "best_speaker"],
			["table_topics_master", "best_table_topics"],
			["general_evaluator", "best_evaluator"],
		]);
		expect(
			materialiseRunOfShow(true, null).filter((s) => s.awardCategory != null),
		).toHaveLength(3);
	});

	it("marks the contest template's beats null, explicitly", () => {
		for (const b of CONTEST_TEMPLATE.beats) expect(b.awardCategory).toBeNull();
	});
});

describe("buildTemplateSlideDeck vote slides (#1635)", () => {
	it("projects the three vote slides with the ballot QR URL and nominees", () => {
		const votes = standardDeck().filter((s) => s.kind.startsWith("vote"));
		expect(votes.map((s) => s.kind)).toEqual([
			"voteSpeaker",
			"voteTableTopics",
			"voteEvaluator",
		]);
		for (const v of votes) {
			if (
				v.kind !== "voteSpeaker" &&
				v.kind !== "voteTableTopics" &&
				v.kind !== "voteEvaluator"
			)
				throw new Error("not a vote");
			expect(v.ballotUrl).toBe(BALLOT);
			expect(v.hasTimer).toBe(true);
		}
		const [speaker, tt, evaluator] = votes;
		if (speaker?.kind !== "voteSpeaker") throw new Error("speaker");
		expect(speaker.names).toEqual(["Sam", "Sue"]);
		expect(speaker.caller?.name).toBe("Tess");
		if (tt?.kind !== "voteTableTopics") throw new Error("tt");
		expect(tt.caller?.name).toBe("Tom");
		if (evaluator?.kind !== "voteEvaluator") throw new Error("eval");
		expect(evaluator.names).toEqual(["Eve"]);
		expect(evaluator.caller?.name).toBe("Gina");
	});

	it("shows the vote slide with no QR when digital voting is off (#770)", () => {
		const votes = standardDeck({ ballotUrl: null }).filter((s) =>
			s.kind.startsWith("vote"),
		);
		expect(votes).toHaveLength(3);
		for (const v of votes) {
			expect((v as { ballotUrl: string | null }).ballotUrl).toBeNull();
		}
	});

	it("does not duplicate the vote as a plain beat slide", () => {
		const text = standardDeck()
			.filter((s) => s.kind === "templateBeat")
			.map((s) => (s.kind === "templateBeat" ? (s.detail ?? "") : ""));
		expect(text.some((d) => d.includes("calls for votes"))).toBe(false);
	});

	it("an unmarked template (today's saved rows) projects no vote slides", () => {
		const kinds = standardDeck({ stripCategory: true }).map((s) => s.kind);
		expect(kinds.some((k) => k.startsWith("vote"))).toBe(false);
	});

	it("projects no vote slide for a segment that did not happen", () => {
		// Only the leaders and the Timer: no live speaker, no evaluator.
		const leaders = slots.filter(
			(s) => s.roleKey !== "speaker" && s.roleKey !== "evaluator",
		);
		expect(
			standardDeck({ deckSlots: leaders })
				.map((s) => s.kind)
				.filter((k) => k.startsWith("vote")),
		).toEqual(["voteTableTopics"]);
		// An open speech slot is not a live speaker (#1484).
		const openSpeaker = slots.map((s) =>
			s.roleKey === "speaker" ? { ...s, assigneeName: null } : s,
		);
		expect(
			standardDeck({ deckSlots: openSpeaker })
				.map((s) => s.kind)
				.filter((k) => k.startsWith("vote")),
		).not.toContain("voteSpeaker");
		// No Table Topics Master: no Table Topics vote.
		const noTt = slots.filter((s) => s.roleKey !== "table_topics_master");
		expect(
			standardDeck({ deckSlots: noTt })
				.map((s) => s.kind)
				.filter((k) => k.startsWith("vote")),
		).toEqual(["voteSpeaker", "voteEvaluator"]);
		expect(
			standardDeck({ deckSlots: [] })
				.map((s) => s.kind)
				.filter((k) => k.startsWith("vote")),
		).toEqual([]);
	});

	it("names the caller from a legacy slot with a null roleKey, by role name", () => {
		const legacy = slots.map((s) =>
			s.roleKey === "toastmaster_of_the_day" ? { ...s, roleKey: null } : s,
		);
		const speaker = standardDeck({ deckSlots: legacy }).find(
			(s) => s.kind === "voteSpeaker",
		);
		if (speaker?.kind !== "voteSpeaker") throw new Error("speaker");
		expect(speaker.caller?.name).toBe("Tess");
	});

	it("a contest projects no vote slide even when a ballot URL is passed", () => {
		const contestSlots = [
			slot("contestant_prepared", "Prepared Speech Contestant", 0, "Ada", {
				isSpeakerRole: true,
				category: "speaker",
				minMinutes: 5,
				maxMinutes: 7,
			}),
		];
		const rows = resolveAgendaRows({
			geIntroducesFunctionaries: false,
			tableTopicsLimits: null,
			template: {
				beats: withBeatIds(CONTEST_TEMPLATE.beats),
				roles: CONTEST_TEMPLATE.roles,
			},
			slots: contestSlots,
		});
		const deck = buildTemplateSlideDeck({
			meeting,
			club,
			rows,
			slots: contestSlots,
			ballotUrl: BALLOT,
		});
		expect(deck.some((s) => s.kind.startsWith("vote"))).toBe(false);
	});
});
