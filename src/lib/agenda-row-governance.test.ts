/**
 * Which agenda row the club's Table Topics window governs, and how that answer
 * travels (#683).
 *
 * The bug this file is the gate for: the answer used to be INFERRED at render
 * time from the row's own contents — role key plus all three marks present —
 * and the marks are a field on the agenda editor's form. So an officer who set
 * timer marks on the **Best Table Topics vote** row made it start matching. The
 * refresh pass then overwrote those marks with the club's speaking window on
 * every render, the editor replaced the row's three inputs with read-only text,
 * and the only way back was deleting the row and re-adding it. The row that
 * broke was not the row they were editing.
 *
 * Three seams have to agree about the answer and each can be wrong on its own,
 * which is why they are all here rather than one per file:
 *
 * 1. `materialiseRunOfShow` WRITES it, once, onto exactly one beat.
 * 2. `refreshTableTopicsMarks` reads it to choose whose marks to re-derive —
 *    covered in `agenda-template-rows.test.ts` beside the predicate.
 * 3. `beatTimingText` reads it to choose whose RULE the projected deck quotes,
 *    and it reads it off an `AgendaRow` two functions downstream. `AgendaRow`
 *    names the field, so the type carries it — but nothing about a TYPE stops a
 *    future projection inside `resolveAgendaRows` from dropping the value, and
 *    the symptom would be the deck quietly reverting to the graced window with
 *    every gate green. That hop is what the deck cases below drive end to end.
 */
import { describe, expect, it } from "vitest";
import { withBeatIds } from "../test/template-beat-ids";
import { materialiseRunOfShow } from "./agenda-materialise";
import type { AgendaSlot } from "./agenda-runsheet";
import { resolveAgendaRows } from "./agenda-runsheet";
import type { ClubForDeck, MeetingForDeck, Slide } from "./agenda-slides";
import type { TemplateBeatSeed, TemplateRoleRow } from "./agenda-template-rows";
import { isClubGovernable } from "./agenda-template-rows";
import { buildTemplateSlideDeck } from "./agenda-template-slides";
import { TABLE_TOPICS_ROLE_KEY } from "./table-topics-limits";

/** MCF's own rule: 1:00–2:30, so "2:31+ disqualified". Chosen because every
 *  number it produces differs from the standard 1:00–2:00 window in at least
 *  one component — a fixture at the defaults cannot tell a live derivation from
 *  a frozen one. */
const CLUB = { minSeconds: 60, maxSeconds: 150 };

const meeting: MeetingForDeck = {
	scheduledAt: new Date("2026-09-10T01:00:00Z"),
	theme: null,
	wordOfTheDay: null,
	wodDefinition: null,
	wodExample: null,
	reminders: null,
};

const club: ClubForDeck = {
	name: "MCF Toastmasters",
	logoUrl: null,
	district: null,
	clubNumber: null,
	timezone: "America/Chicago",
	meetingSchedule: null,
	tableTopicsMinSeconds: CLUB.minSeconds,
	tableTopicsMaxSeconds: CLUB.maxSeconds,
};

const ttRoleBeats = (seeds: TemplateBeatSeed[]) =>
	seeds.filter((s) => s.kind === "role" && s.roleKey === TABLE_TOPICS_ROLE_KEY);

describe("materialiseRunOfShow marks the club-governed row (#683)", () => {
	// BOTH variants: `geIntroducesFunctionaries` shifts every index after the
	// opening pair, and the governed beat is found positionally.
	for (const geIntroduces of [false, true]) {
		it(`marks exactly ONE beat (geIntroducesFunctionaries: ${geIntroduces})`, () => {
			const seeds = materialiseRunOfShow(geIntroduces, CLUB);
			const governed = seeds.filter((s) => s.clubGoverned);
			// ABSOLUTE 1. "At most one governed row per meeting" is the property the
			// backfill's tie-break also has to hold, and it is what stops the
			// refresh pass owning two rows' marks forever.
			expect(governed.length).toBe(1);
		});
	}

	it("marks the SPEAKING segment, not the vote row or the hand-off", () => {
		const seeds = materialiseRunOfShow(false, CLUB);
		const ttBeats = ttRoleBeats(seeds);
		// The premise this whole issue rests on: three role beats carry the key, so
		// the key alone identifies nothing. Stated as an assertion because if the
		// run of show ever stops emitting three, the cases below get weaker without
		// anyone noticing.
		expect(ttBeats.length).toBe(3);

		const governed = seeds.filter((s) => s.clubGoverned);
		expect(governed.length).toBe(1);
		const row = governed[0];
		// The speaking segment is the one that carries the club's window and the
		// one `applyFlex` stretches. ABSOLUTE marks: 1:00–2:30 is 1 / 1.75 / 2.5
		// minutes, which the standard 1 / 1.5 / 2 cannot be mistaken for.
		expect({
			roleKey: row?.roleKey,
			flex: row?.flex,
			markGreen: row?.markGreen,
			markYellow: row?.markYellow,
			markRed: row?.markRed,
		}).toEqual({
			roleKey: TABLE_TOPICS_ROLE_KEY,
			flex: true,
			markGreen: 1,
			markYellow: 1.75,
			markRed: 2.5,
		});
		// And the other two carry nothing — named individually, because "one row is
		// marked" would also hold if the marked one were the vote row.
		const others = ttBeats.filter((b) => b !== row);
		expect(others.length).toBe(2);
		expect(others.map((b) => b.clubGoverned)).toEqual([false, false]);
	});

	it("marks nothing outside the Table Topics role", () => {
		// The evaluation beat carries marks too (2 / 2.5 / 3), so "carries marks"
		// is not what selected the governed row.
		const seeds = materialiseRunOfShow(false, CLUB);
		const stray = seeds.filter(
			(s) => s.clubGoverned && s.roleKey !== TABLE_TOPICS_ROLE_KEY,
		);
		expect(stray).toEqual([]);
		expect(
			seeds.some((s) => s.markGreen != null && !s.clubGoverned),
			"a marked beat the club does not own must exist, or this proves nothing",
		).toBe(true);
	});

	it("marks the row even for a club that has stated NO window", () => {
		// The standard window is still the CLUB's window as far as this app is
		// concerned — `refreshTableTopicsMarks(rows, null)` resolves to it and
		// overwrites. A materialisation that skipped the marker here would leave
		// every default club's row frozen the day it was created.
		const seeds = materialiseRunOfShow(false, null);
		expect(seeds.filter((s) => s.clubGoverned).length).toBe(1);
	});
});

describe("isClubGovernable — which rows may be offered the control (#683)", () => {
	it("admits a Table Topics role row whatever its marks say", () => {
		// The un-governed row the editor has to offer the way BACK to. It carries
		// no marker and, having been un-governed, may carry any marks at all.
		expect(
			isClubGovernable({ kind: "role", roleKey: TABLE_TOPICS_ROLE_KEY }),
		).toBe(true);
	});

	it("refuses another role, a band, and a row bound to nobody", () => {
		expect(isClubGovernable({ kind: "role", roleKey: "evaluator" })).toBe(
			false,
		);
		expect(
			isClubGovernable({ kind: "section", roleKey: TABLE_TOPICS_ROLE_KEY }),
		).toBe(false);
		expect(isClubGovernable({ kind: "role", roleKey: null })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// The projected deck.
//
// `beatTimingText` decides whether a row's span is quoted as the CLUB's rule
// ("1:00–2:30", the hard cap, no grace) or as a graced qualifying window
// (±0:30 on a speech, floored at green on a Table Topics answer since #720).
// It used to decide that from `segmentFor(row.roleKey)`, which cannot tell the
// three Table Topics beats apart — so a timed vote row got the club's labelling.
//
// Driven through `resolveAgendaRows` -> `buildTemplateSlideDeck` rather than by
// calling `beatTimingText`, because the marker's whole risk is in the hop: it
// rides an `AgendaRow` the intermediate signature does not name.
// ---------------------------------------------------------------------------
describe("the projected deck quotes the club's rule on the governed row only (#683)", () => {
	const roles: TemplateRoleRow[] = [
		{
			key: TABLE_TOPICS_ROLE_KEY,
			name: "Table Topics Master",
			isSpeakerRole: false,
		},
	];
	const slots: AgendaSlot[] = [];

	/** The real materialised run of show, with an officer's own timer marks put
	 *  on the Best Table Topics VOTE row — the reachable edit that broke. */
	function deckWithTimedVoteRow() {
		const seeds = materialiseRunOfShow(false, CLUB);
		const tt = seeds.filter(
			(s) => s.kind === "role" && s.roleKey === TABLE_TOPICS_ROLE_KEY,
		);
		const vote = tt.find((s) => !s.clubGoverned && !s.handoff);
		if (!vote) throw new Error("no ungoverned Table Topics vote beat to time");
		// 0:30 / 0:45 / 1:00 — a minute to call the vote. Every component differs
		// from the club's window, so a row rendered with the club's numbers is
		// unmistakable.
		vote.markGreen = 0.5;
		vote.markYellow = 0.75;
		vote.markRed = 1;
		const seedRoles: TemplateRoleRow[] = [
			...new Set(seeds.map((s) => s.roleKey).filter((k): k is string => !!k)),
		].map((key) => ({ key, name: key, isSpeakerRole: key === "speaker" }));
		const rows = resolveAgendaRows({
			geIntroducesFunctionaries: false,
			tableTopicsLimits: CLUB,
			template: { beats: withBeatIds(seeds), roles: seedRoles },
			slots,
		});
		const deck = buildTemplateSlideDeck({ meeting, club, rows });
		const timed = deck.flatMap((s: Slide) =>
			s.kind === "templateBeat" && s.timing != null ? [s] : [],
		);
		// Matched on label AND detail. `beatSeed` gives all three Table Topics
		// beats the same `who` — that ambiguity is the bug's premise — so a
		// label-only lookup silently returns the segment's slide for the vote row
		// and this whole describe passes on the wrong slide.
		const slideFor = (row: { who: string; detail: string }) =>
			timed.find((s) => s.label === row.who && s.detail === row.detail);
		return { rows, slideFor };
	}

	it("labels the GOVERNED row with the club's hard cap", () => {
		const { rows, slideFor } = deckWithTimedVoteRow();
		const governed = rows.find((r) => r.clubGoverned === true);
		expect(governed, "the governed row must reach the rows").toBeTruthy();
		const slide = governed && slideFor(governed);
		// ABSOLUTE. The club's own span, green to red with no grace either side.
		expect(slide?.timing?.qualifies).toBe("1:00–2:30");
	});

	it("does NOT label the officer's vote row with it", () => {
		const { rows, slideFor } = deckWithTimedVoteRow();
		const vote = rows.find(
			(r) =>
				r.roleKey === TABLE_TOPICS_ROLE_KEY &&
				r.clubGoverned !== true &&
				r.marks != null,
		);
		expect(vote, "the timed vote row must reach the rows").toBeTruthy();
		const slide = vote && slideFor(vote);
		expect(slide, "the timed vote row must get a slide").toBeTruthy();
		// The PRE-FIX string, named so this cannot pass by coincidence: the club's
		// cap is what the old `segmentFor`-only test produced here, and the
		// officer's own marks are what it produced it FROM.
		expect(slide?.timing?.qualifies).not.toBe("1:00–2:30");
		// 0:30 / 1:00 graced as a Table Topics answer: floored at green (#720),
		// +0:30 at the top.
		expect(slide?.timing?.qualifies).toBe("0:30–1:30");
		// And its own marks are still the officer's, all the way to the wall.
		expect({
			green: slide?.timing?.green,
			red: slide?.timing?.red,
		}).toEqual({ green: "0:30", red: "1:00" });
	});

	it("falls back to the graced window when the club has stated nothing", () => {
		// `hasTableTopicsLimits` is the other half of `ownRule`, and it is unchanged
		// — a governed row at a club with no rule of its own still gets a derived
		// window rather than its marks quoted as a cap (#720).
		const seeds = materialiseRunOfShow(false, null);
		const seedRoles: TemplateRoleRow[] = [
			...new Set(seeds.map((s) => s.roleKey).filter((k): k is string => !!k)),
		].map((key) => ({ key, name: key, isSpeakerRole: key === "speaker" }));
		const rows = resolveAgendaRows({
			geIntroducesFunctionaries: false,
			tableTopicsLimits: null,
			template: { beats: withBeatIds(seeds), roles: seedRoles },
			slots,
		});
		const deck = buildTemplateSlideDeck({
			meeting,
			club: {
				...club,
				tableTopicsMinSeconds: null,
				tableTopicsMaxSeconds: null,
			},
			rows,
		});
		const governed = rows.find((r) => r.clubGoverned === true);
		const slide = deck.flatMap((s: Slide) =>
			s.kind === "templateBeat" &&
			s.label === governed?.who &&
			s.detail === governed?.detail
				? [s]
				: [],
		)[0];
		// The standard 1:00–2:00 marks, floored at green and graced at the top.
		expect(slide?.timing?.qualifies).toBe("1:00–2:30");
	});

	it("keeps the marker on the rows `resolveAgendaRows` hands over", () => {
		// The type-level seam: `resolveAgendaRows` declares `AgendaRow[]`, which
		// does not name `clubGoverned`, so nothing the compiler checks proves the
		// flag arrives. Rebuilding rows anywhere in that pipeline would drop it
		// silently and the deck would quietly stop quoting the club's rule.
		const seeds = materialiseRunOfShow(false, CLUB);
		const rows = resolveAgendaRows({
			geIntroducesFunctionaries: false,
			tableTopicsLimits: CLUB,
			template: {
				beats: withBeatIds(seeds.filter((s) => s.clubGoverned)),
				roles,
			},
			slots,
		});
		expect(rows.map((r) => r.clubGoverned)).toEqual([true]);
	});
});
