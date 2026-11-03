/**
 * The Toastmaster's script builder (#1480).
 *
 * Every test carries its card: `protects=…; fails_when=…; no_claim=…`.
 */
import { describe, expect, it } from "vitest";
import { sheetScripts } from "#/server/role-sheet-layout";
import { withBeatIds } from "#/test/template-beat-ids";
import { materialiseRunOfShow } from "./agenda-materialise";
import {
	type AgendaSlot,
	applyFlex,
	buildRunOfShow,
	expandRunSheet,
	resolveAgendaRows,
} from "./agenda-runsheet";
import type { TemplateRoleRow } from "./agenda-template-rows";
import { buildTimeline } from "./agenda-timing";
import {
	buildToastmasterScript,
	evaluatorAskFor,
	MISSING_TITLE_NOTE,
	type ScriptLine,
	scriptSignInRedirect,
} from "./toastmaster-script";

function slot(
	id: string,
	roleKey: string,
	roleName: string,
	assigneeName: string | null,
	over: Partial<AgendaSlot> = {},
): AgendaSlot {
	return {
		id,
		roleKey,
		roleName,
		category: "leadership",
		isSpeakerRole: false,
		slotIndex: 0,
		assigneeName,
		speechTitle: null,
		projectLevel: null,
		minMinutes: null,
		maxMinutes: null,
		evaluatesSlotId: null,
		evaluates: null,
		...over,
	};
}

const speaker = (i: number, name: string | null, title: string | null) =>
	slot(`sp${i}`, "speaker", "Speaker", name, {
		isSpeakerRole: true,
		category: "speaker",
		slotIndex: i,
		minMinutes: 5,
		maxMinutes: 7,
		speechTitle: title,
	});

const evaluator = (
	i: number,
	name: string | null,
	evaluates: string | null,
	roleName = "Evaluator",
) =>
	slot(`ev${i}`, "evaluator", roleName, name, {
		isSpeakerRole: true,
		category: "evaluator",
		slotIndex: i,
		evaluatesSlotId: evaluates,
	});

function club(
	titles: (string | null)[] = ["Rise", "Fall"],
	evaluatorRoleName = "Evaluator",
): AgendaSlot[] {
	return [
		slot("sa", "sergeant_at_arms", "Sergeant-at-Arms", "Sam"),
		slot("pr", "president", "President", "Pat"),
		slot("tm", "toastmaster_of_the_day", "Toastmaster of the Day", "Tia"),
		slot("ge", "general_evaluator", "General Evaluator", "Gil"),
		slot("tt", "table_topics_master", "Table Topics Master", "Tom"),
		...titles.map((t, i) => speaker(i, ["Ann", "Bea", "Cy"][i] ?? "Dee", t)),
		...titles.map((_, i) =>
			evaluator(i, `Eval${i}`, `sp${i}`, evaluatorRoleName),
		),
		slot("ti", "timer", "Timer", "Tim", { category: "functionary" }),
		slot("gr", "grammarian", "Grammarian", "Gra", { category: "functionary" }),
		slot("ah", "ah_counter", "Ah-Counter", "Ahh", { category: "functionary" }),
	];
}

const ROLES: TemplateRoleRow[] = [
	{ key: "sergeant_at_arms", name: "Sergeant-at-Arms", isSpeakerRole: false },
	{ key: "president", name: "President", isSpeakerRole: false },
	{
		key: "toastmaster_of_the_day",
		name: "Toastmaster of the Day",
		isSpeakerRole: false,
	},
	{ key: "general_evaluator", name: "General Evaluator", isSpeakerRole: false },
	{
		key: "table_topics_master",
		name: "Table Topics Master",
		isSpeakerRole: false,
	},
	{ key: "speaker", name: "Speaker", isSpeakerRole: true },
	{ key: "evaluator", name: "Evaluator", isSpeakerRole: true },
	{ key: "timer", name: "Timer", isSpeakerRole: false },
	{ key: "grammarian", name: "Grammarian", isSpeakerRole: false },
	{ key: "ah_counter", name: "Ah-Counter", isSpeakerRole: false },
];

const STARTS = new Date("2026-09-08T18:30:00Z");
const TZ = "UTC";

/** The printed agenda's rows: flexed, then timed, exactly as print does. */
function timed(rows: ReturnType<typeof expandRunSheet>) {
	return buildTimeline(applyFlex(rows, 60).rows, STARTS, TZ);
}

function codeRows(slots: AgendaSlot[], ge = false) {
	return timed(
		expandRunSheet(slots, buildRunOfShow({ geIntroducesFunctionaries: ge })),
	);
}

function script(
	slots: AgendaSlot[],
	introductions: Record<string, string> | null = null,
	ge = false,
): ScriptLine[] {
	return buildToastmasterScript({
		rows: codeRows(slots, ge),
		slots,
		introductions,
	});
}

const kinds = (lines: ScriptLine[]) => lines.map((l) => l.kind);
const speeches = (lines: ScriptLine[]) =>
	lines.filter((l) => l.kind === "speech");

describe("buildToastmasterScript", () => {
	// protects=AC1: one mine line per Toastmaster row in agenda order, one speech
	//   line per speech with both names, others between, times from the print rows.
	// fails_when=a Toastmaster row is dropped or reordered, a speech row is not
	//   found, or a time is computed instead of read off the row.
	// no_claim=wording of any `detail`.
	it("a standard meeting: mine lines, one speech per speaker, others between", () => {
		const slots = club();
		const rows = codeRows(slots);
		const lines = buildToastmasterScript({ rows, slots, introductions: null });

		const tmRows = rows.filter(
			(r) =>
				r.roleKey === "toastmaster_of_the_day" &&
				// The per-speech preamble folds into its speech.
				!r.detail.startsWith("Introduces the Evaluator"),
		);
		const mine = lines.filter((l) => l.kind === "mine");
		expect(mine.map((l) => l.detail)).toEqual(tmRows.map((r) => r.detail));
		expect(mine.map((l) => l.time)).toEqual(tmRows.map((r) => r.time));

		const sp = speeches(lines);
		expect(sp.map((l) => l.kind === "speech" && l.speaker)).toEqual([
			"Ann",
			"Bea",
		]);
		expect(sp.map((l) => l.kind === "speech" && l.evaluator)).toEqual([
			"Eval0",
			"Eval1",
		]);
		const speechRows = rows.filter((r) => r.slotId?.startsWith("sp"));
		expect(sp.map((l) => l.time)).toEqual(speechRows.map((r) => r.time));
		expect(sp.map((l) => l.minutes)).toEqual(speechRows.map((r) => r.minutes));
		expect(kinds(lines)).toContain("others");
		// Agenda order: the first speech comes after the opening mine lines.
		expect(kinds(lines).indexOf("speech")).toBeGreaterThan(0);
	});

	// protects=AC6a: a run of non-Toastmaster rows is one line, first row's time,
	//   summed minutes, and the next mine line names the LAST row's holder.
	// fails_when=the run splits per role, minutes are not summed, or backCue names
	//   the first holder.
	// no_claim=the wording of any `detail`, or that the route feeds these rows (the route guard covers that).
	it("collapses Table Topics then the General Evaluator into one others line", () => {
		const slots = club();
		const rows = codeRows(slots);
		const lines = buildToastmasterScript({ rows, slots, introductions: null });
		const idx = lines.findIndex(
			(l) => l.kind === "others" && l.summary.startsWith("Table Topics Master"),
		);
		const run = lines[idx];
		expect(run?.kind).toBe("others");
		if (run?.kind !== "others") return;
		const ttRow = rows.find((r) => r.roleLabel === "Table Topics Master");
		expect(run.time).toBe(ttRow?.time);
		expect(run.summary).toMatch(
			/^Table Topics Master: Tom runs it \(~\d+ min\)$/,
		);
		// Every row from Table Topics to the Toastmaster's closing is in the run.
		const from = rows.indexOf(ttRow as (typeof rows)[number]);
		let to = from;
		while (rows[to]?.roleKey !== "toastmaster_of_the_day") to += 1;
		const slice = rows.slice(from, to);
		expect(run.minutes).toBe(slice.reduce((n, r) => n + r.minutes, 0));
		expect(slice.some((r) => r.holder === "Gil")).toBe(true);
		const next = lines[idx + 1];
		expect(next?.kind).toBe("mine");
		expect(next?.kind === "mine" && next.backCue).toBe(
			`You're back when ${slice[slice.length - 1]?.holder} hands back.`,
		);
		// Pinned to the fixture: the General Evaluator is the run's last holder.
		expect(next?.kind === "mine" && next.backCue).toBe(
			"You're back when Gil hands back.",
		);
		expect(
			lines.filter((l) => l.kind === "mine" && l.backCue !== null),
		).toHaveLength(
			lines.filter(
				(l, i) => l.kind === "mine" && lines[i - 1]?.kind === "others",
			).length,
		);
	});

	// protects=AC3: with the GE variant the functionary introduction is the
	//   General Evaluator's, so it is an others line and not the Toastmaster's.
	// fails_when=the builder reads English instead of the row's owner.
	// no_claim=the wording of any `detail`, or that the route feeds these rows (the route guard covers that).
	it("a GE-variant club: the functionary introduction is an others line", () => {
		const slots = club();
		const std = script(slots, null, false);
		const ge = script(slots, null, true);
		const intro = (l: ScriptLine) =>
			l.kind === "mine" && /Timer, Grammarian/.test(l.detail);
		expect(std.some(intro)).toBe(true);
		expect(ge.some(intro)).toBe(false);
		expect(
			ge.some(
				(l) => l.kind === "others" && l.summary.startsWith("General Evaluator"),
			),
		).toBe(true);
	});

	// protects=AC4: the introduction wins for a member; the fallback otherwise.
	// fails_when=members-only is reported for a member, or say ignores the text.
	// no_claim=the wording of any `detail`, or that the route feeds these rows (the route guard covers that).
	it("shows the introduction when there is one, the title line when not", () => {
		const slots = club();
		const withIntro = speeches(script(slots, { sp0: "Meet Ann, who climbs." }));
		const first = withIntro[0];
		expect(first?.kind === "speech" && first.say).toBe("Meet Ann, who climbs.");
		expect(first?.kind === "speech" && first.introduction).toBe("shown");
		const second = withIntro[1];
		expect(second?.kind === "speech" && second.say).toBe(
			"Fall – Bea – Bea – Fall",
		);
		expect(second?.kind === "speech" && second.introduction).toBe("none");
	});

	// protects=AC4/AC5: a null `introductions` is a non-member; their say is the
	//   fallback whatever exists.
	// fails_when=members-only reads as "none" or "shown".
	// no_claim=the wording of any `detail`, or that the route feeds these rows (the route guard covers that).
	it("flags members-only for a null introductions map", () => {
		const first = speeches(script(club(), null))[0];
		expect(first?.kind === "speech" && first.introduction).toBe("members-only");
		expect(first?.kind === "speech" && first.say).toBe(
			"Rise – Ann – Ann – Rise",
		);
	});

	// protects=AC6: no title -> "Introduce {speaker}." and the note outside it;
	//   an introduction with no title keeps the note.
	// fails_when=the note is dropped when an introduction exists, or is put in say.
	// no_claim=the wording of any `detail`, or that the route feeds these rows (the route guard covers that).
	it("no title: the plain line plus a prep note, and the note survives an introduction", () => {
		const slots = club([null, null]);
		const plain = speeches(script(slots, {}))[0];
		expect(plain?.kind === "speech" && plain.say).toBe("Introduce Ann.");
		expect(plain?.kind === "speech" && plain.prepNote).toBe(MISSING_TITLE_NOTE);
		const intro = speeches(script(slots, { sp0: "About Ann." }))[0];
		expect(intro?.kind === "speech" && intro.say).toBe("About Ann.");
		expect(intro?.kind === "speech" && intro.prepNote).toBe(MISSING_TITLE_NOTE);
		expect(intro?.kind === "speech" && intro.say).not.toContain("Ask them");
	});

	// protects=AC7: the ask names the person and never the role title, so a club
	//   that renamed Evaluator is not shown the canonical one.
	// fails_when=the ask is built from a role name.
	// no_claim=the wording of any `detail`, or that the route feeds these rows (the route guard covers that).
	it("a renamed Evaluator role: the ask carries the name and no role title", () => {
		const slots = club(["Rise"], "Critic");
		const first = speeches(script(slots, null))[0];
		if (first?.kind !== "speech") throw new Error("no speech");
		expect(first.evaluatorAsk).toContain("Eval0");
		expect(first.evaluatorAsk).not.toMatch(/Critic|Evaluator/);
	});

	// protects=the ask stays the sheet's sentence (#508/#509): only the
	//   name replaces "our Evaluator, named on your agenda".
	// fails_when=either copy of the wording changes without the other.
	// no_claim=the wording of any `detail`, or that the route feeds these rows (the route guard covers that).
	it("the evaluator ask equals the PDF sheet's line with the name substituted", () => {
		const sheet = sheetScripts().toastmaster.find((c) =>
			c.when.startsWith("Before each prepared speech"),
		);
		expect(sheet).toBeDefined();
		expect(evaluatorAskFor("Jo")).toBe(
			sheet?.say.replace("our Evaluator, named on your agenda", "Jo"),
		);
	});

	// protects=no evaluator linked, and two linked.
	// fails_when=a null evaluator still yields an ask, or only the first is named.
	// no_claim=the wording of any `detail`, or that the route feeds these rows (the route guard covers that).
	it("lists two linked evaluators and omits the ask for none", () => {
		const slots = club(["Rise"]);
		slots.push(evaluator(9, "Extra", "sp0"));
		const two = speeches(script(slots))[0];
		expect(two?.kind === "speech" && two.evaluator).toBe("Eval0 and Extra");
		const none = speeches(
			script(slots.filter((s) => s.evaluatesSlotId == null)),
		)[0];
		expect(none?.kind === "speech" && none.evaluator).toBeNull();
		expect(none?.kind === "speech" && none.evaluatorAsk).toBeNull();
	});

	// protects=a guest speaker gets the same line shape as a member: the evaluator
	//   ask and the say are carried, and the guest marker the agenda prints is
	//   the only difference.
	// fails_when=guest handling is lost (the speech row skipped, the evaluator ask
	//   or say dropped, or the marker not read off the row).
	// no_claim=how the marker is worded; only that it is the agenda's.
	it("treats a guest speaker like a member", () => {
		const asPerson = (guest: boolean): AgendaSlot[] =>
			club(["Rise"]).map((s) =>
				s.id === "sp0"
					? { ...s, assigneeName: "Gus", assigneeIsGuest: guest }
					: s,
			);
		const member = speeches(script(asPerson(false)))[0];
		const guest = speeches(script(asPerson(true)))[0];
		expect(member?.kind).toBe("speech");
		expect(guest?.kind).toBe("speech");
		if (member?.kind !== "speech" || guest?.kind !== "speech") return;
		expect(guest.speaker).toBe("Gus · Guest");
		expect(guest.say).not.toContain("Guest");
		expect(guest.say).toContain("Gus");
		expect(guest.evaluatorAsk).toBe(member.evaluatorAsk);
		expect(guest.evaluatorAsk).toContain("Eval0");
		expect(guest).toEqual({
			...member,
			speaker: "Gus · Guest",
			say: member.say,
		});
	});

	// protects=the spoken name comes from the slot's bare name: a visiting-
	//   Toastmaster guest keeps "(V)" on `speaker` but not in `say`.
	// fails_when=`say` is built from the rendered `speaker` text.
	// no_claim=the wording of the marker.
	it("a visiting-Toastmaster guest: the marker stays on speaker, not in say", () => {
		const slots = club(["Rise"]).map((s) =>
			s.id === "sp0"
				? {
						...s,
						assigneeName: "Vic",
						assigneeIsGuest: true,
						assigneeIsVisitingToastmaster: true,
					}
				: s,
		);
		const line = speeches(script(slots))[0];
		if (line?.kind !== "speech") throw new Error("no speech line");
		expect(line.speaker).toBe("Vic (V)");
		expect(line.say).toBe("Rise \u2013 Vic \u2013 Vic \u2013 Rise");
	});

	// protects=a MEMBER whose own name contains " (V)" or " \u00b7 Guest" is read
	//   aloud in full: the name is never parsed back out of the rendered text.
	// fails_when=`say` strips a marker-shaped substring from the display string.
	// no_claim=how such a name is displayed.
	it("a member whose own name looks like a marker keeps it in say", () => {
		for (const name of ["Ann (V)", "Bo \u00b7 Guest"]) {
			const slots = club(["Rise"]).map((s) =>
				s.id === "sp0" ? { ...s, assigneeName: name } : s,
			);
			const line = speeches(script(slots))[0];
			if (line?.kind !== "speech") throw new Error("no speech line");
			expect(line.say).toBe(`Rise \u2013 ${name} \u2013 ${name} \u2013 Rise`);
		}
	});

	// protects=AC2: the stored (materialised) agenda, resolved as the route does
	//   (section bands included), yields the same lines.
	// fails_when=the builder depends on something only the code path carries, or
	//   a section band reads as a run ("OPENING runs it").
	// no_claim=a club's own template beyond the seed.
	it("gives identical lines from the code path and the materialised path", () => {
		const slots = club(["Rise", null]);
		const fromCode = script(slots, { sp0: "Hello." });
		const seeds = withBeatIds(materialiseRunOfShow(false, null));
		// What the route calls, so the section filtering is the product's own.
		const stored = timed(
			resolveAgendaRows({
				geIntroducesFunctionaries: false,
				tableTopicsLimits: null,
				template: { beats: seeds, roles: ROLES },
				slots,
			}),
		);
		const fromStored = buildToastmasterScript({
			rows: stored,
			slots,
			introductions: { sp0: "Hello." },
		});
		expect(fromStored).toEqual(fromCode);
	});
});

describe("scriptSignInRedirect", () => {
	const base = { clubId: "c", meetingKey: "m" };

	// protects=the Sign in link is offered to a signed-out visitor only: a signed-in
	//   non-member (hasSession true, no club shell) gets the note without it, and
	//   a member (no note) gets neither.
	// fails_when=the link is keyed on the club shell / authCtx instead of the
	//   session, or shows when there is no note.
	// no_claim=that the route passes the parent's hasSession (the route guard's
	//   wiring test reads the source for that).
	it("links only a signed-out visitor who sees the note", () => {
		expect(
			scriptSignInRedirect({
				...base,
				showMembersOnlyNote: true,
				hasSession: false,
			}),
		).toBe("/club/c/meeting/m/me/script");
		expect(
			scriptSignInRedirect({
				...base,
				showMembersOnlyNote: true,
				hasSession: true,
			}),
		).toBeNull();
		expect(
			scriptSignInRedirect({
				...base,
				showMembersOnlyNote: false,
				hasSession: false,
			}),
		).toBeNull();
	});
});
