/**
 * Render smoke tests for the shared role-sheet layout (#310, #311). Guarantees
 * every sheet renders to a valid PDF both blank (the static-template path) and
 * pre-filled (the meeting-aware path), and that the fill path tolerates more
 * speakers than the table has pre-drawn rows. This module has no #/db import, so
 * it renders directly without a database.
 */
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";
import { ROLE_SHEETS } from "#/data/role-sheets";
import type { AgendaSlot } from "#/lib/agenda-runsheet";
import {
	buildRunOfShow,
	EVALUATION_MARKS,
	EVALUATION_TIMING_ASK,
	expandRunSheet,
	TABLE_TOPICS_MARKS,
} from "#/lib/agenda-runsheet";
import { formatTimingClock } from "#/lib/timing-window";
import {
	buildRoleSheetDoc,
	type RoleSheetFill,
	type RoleSheetKey,
	roleSheetByKey,
	SHEET_SCRIPTS,
	standardTimingRows,
} from "./role-sheet-layout";

const fill: RoleSheetFill = {
	club: "Harborlight Toastmasters",
	date: "Jul 22",
	speakers: ['Alice — "My Icebreaker"', "Bob", "Cara"],
	wod: { word: "ebullient", note: "cheerful and full of energy" },
};

async function isPdf(doc: ReturnType<typeof buildRoleSheetDoc>) {
	const buf = await renderToBuffer(doc as Parameters<typeof renderToBuffer>[0]);
	return {
		ok: buf.subarray(0, 5).toString("latin1") === "%PDF-",
		size: buf.length,
	};
}

describe("role-sheet layout (#311)", () => {
	for (const { key } of ROLE_SHEETS) {
		it(`renders "${key}" blank as a valid PDF`, async () => {
			const { ok, size } = await isPdf(buildRoleSheetDoc(key));
			expect(ok).toBe(true);
			expect(size).toBeGreaterThan(500);
		});

		it(`renders "${key}" pre-filled as a valid PDF`, async () => {
			const { ok, size } = await isPdf(buildRoleSheetDoc(key, fill));
			expect(ok).toBe(true);
			expect(size).toBeGreaterThan(500);
		});
	}

	it("tolerates more speakers than the table has pre-drawn rows", async () => {
		const many: RoleSheetFill = {
			...fill,
			speakers: Array.from({ length: 30 }, (_, i) => `Speaker ${i + 1}`),
		};
		const { ok } = await isPdf(buildRoleSheetDoc("timer", many));
		expect(ok).toBe(true);
	});

	it("resolves known keys and rejects unknown ones", () => {
		expect(roleSheetByKey("timer")?.title).toBe("Timer's log");
		expect(roleSheetByKey("nope")).toBeUndefined();
	});
});

// #507 — the Timer's sheet is the surface that shipped saying "Amber" while the
// live layout said "Yellow", because every test asserted `standardTimingRows()`
// DATA and none asserted the printed words. Walk the doc tree for them.
describe("Timer sheet prints yellow, never amber (#507)", () => {
	/** Every string in a react-pdf element tree. */
	function textOf(node: unknown): string[] {
		if (node == null || node === false) return [];
		if (typeof node === "string") return [node];
		if (Array.isArray(node)) return node.flatMap(textOf);
		const el = node as { props?: { children?: unknown } };
		return el.props ? textOf(el.props.children) : [];
	}

	const words = textOf(buildRoleSheetDoc("timer")).join(" | ");

	it("uses yellow in the column header and the instruction", () => {
		expect(words).toContain("Yellow");
		expect(words).toContain("green / yellow / red");
	});

	it("says amber nowhere", () => {
		expect(words.toLowerCase()).not.toContain("amber");
	});
});

// #507 — the agenda now prints the same windows as coloured marks, so the two
// surfaces hold the same numbers in two places. Pin them together: whoever
// changes one gets a failure naming the other, instead of a Timer signalling at
// 2:30 while the agenda beside them prints something else.
describe("agenda marks agree with the Timer sheet's published windows (#507)", () => {
	const rows = standardTimingRows();
	const published = (assignment: string) =>
		rows.find((r) => r[0] === assignment);

	it("evaluation", () => {
		expect(published("Evaluation")?.slice(1, 4)).toEqual([
			formatTimingClock(EVALUATION_MARKS.green),
			formatTimingClock(EVALUATION_MARKS.yellow),
			formatTimingClock(EVALUATION_MARKS.red),
		]);
	});

	it("table topics", () => {
		expect(published("Table Topics")?.slice(1, 4)).toEqual([
			formatTimingClock(TABLE_TOPICS_MARKS.green),
			formatTimingClock(TABLE_TOPICS_MARKS.yellow),
			formatTimingClock(TABLE_TOPICS_MARKS.red),
		]);
	});
});

// #357 — the Timer needs the qualifying window, not just the signal times.
describe("Timer sheet standard timing windows (#357)", () => {
	const rows = standardTimingRows();

	it("keeps the published green/yellow/red times, deriving yellow as the midpoint", () => {
		expect(rows).toContainEqual([
			"Prepared speech",
			"5:00",
			"6:00",
			"7:00",
			"4:30–7:30",
		]);
		expect(rows).toContainEqual([
			"Evaluation",
			"2:00",
			"2:30",
			"3:00",
			"1:30–3:30",
		]);
	});

	it("never prints a negative lower bound on a short assignment", () => {
		expect(rows).toContainEqual([
			"Table Topics",
			"1:00",
			"1:30",
			"2:00",
			"0:30–2:30",
		]);
	});
});

// ---------------------------------------------------------------------------
// #509 — every sheet carries a script its holder can read aloud, and the
// Ah-Counter stops being handed a list of the booked speakers.
//
// The existing suites above are SMOKE tests: "renders as a valid PDF, size >
// 500". Every one of them passes with the script block deleted, which is why
// these walk the element tree for the actual words — the same lesson #507 paid
// for when five PDFs shipped saying "Amber" past a green suite.
// ---------------------------------------------------------------------------
describe("role sheets carry a spoken script (#509)", () => {
	/** Every string in a react-pdf element tree. */
	function textOf(node: unknown): string[] {
		if (node == null || node === false) return [];
		if (typeof node === "string") return [node];
		if (Array.isArray(node)) return node.flatMap(textOf);
		const el = node as { props?: { children?: unknown } };
		return el.props ? textOf(el.props.children) : [];
	}
	const wordsOf = (key: RoleSheetKey, f?: RoleSheetFill) =>
		textOf(buildRoleSheetDoc(key, f)).join(" | ");

	for (const { key } of ROLE_SHEETS) {
		it(`"${key}" prints a What to say block with every one of its cues`, () => {
			const words = wordsOf(key);
			expect(words).toContain("What to say");
			const cues = SHEET_SCRIPTS[key];
			// A sheet with no cues would pass the "What to say" check vacuously.
			expect(cues.length).toBeGreaterThan(0);
			for (const c of cues) {
				expect(words).toContain(c.when);
				expect(words).toContain(c.say);
			}
		});
	}

	// The script is read ALOUD off a sheet that also prints the numbers as a
	// table. Transcribing them into the prose would let one page contradict
	// itself, which is the failure #357 removed from the columns.
	it("derives the Timer's spoken times from the published windows, never transcribing them", () => {
		const words = wordsOf("timer");
		for (const assignment of ["Table Topics", "Evaluation"]) {
			const row = standardTimingRows().find((r) => r[0] === assignment);
			expect(row).toBeDefined();
			const [, green, yellow, red] = row as string[];
			expect(words).toContain(
				`green at ${green}, yellow at ${yellow}, red at ${red}`,
			);
		}
	});

	// #508 put these cues on the printed agenda. The sheet in the holder's hand
	// has to say the same thing, or one person is told two different things.
	// #508 put these cues on the printed agenda. The sheet in the holder's hand
	// has to say the same thing, or one person is told two different things.
	//
	// These read the REAL run sheet. The first version compared `SHEET_SCRIPTS`
	// to hardcoded literals — two copies of the same English, one surface checked
	// against itself — and review caught it by rewording the agenda cue and
	// watching all 41 tests stay green. Beats are located STRUCTURALLY (by the
	// gate they set, by their marks) rather than by matching their prose, so the
	// lookup itself cannot go stale when the wording changes.
	describe("agrees with the agenda cues it answers (#508)", () => {
		const template = buildRunOfShow({ geIntroducesFunctionaries: false });

		it("speaks the same evaluation-timing ask the agenda prints", () => {
			// The only beat carrying `alsoRequiresAnyOf` is the evaluation-timing
			// cue — a structural handle, so this does not break on a reword.
			const beat = template.filter((b) => b.alsoRequiresAnyOf != null);
			expect(beat).toHaveLength(1);
			expect(beat[0].detail).toContain(EVALUATION_TIMING_ASK);

			// The GE's sheet and the agenda row read the SAME exported constant, so a
			// reword moves both together or fails to compile.
			const ge = SHEET_SCRIPTS["general-evaluator"].map((c) => c.say).join(" ");
			expect(ge).toContain(EVALUATION_TIMING_ASK);

			// The Timer answers that ask. Its cue is deliberately merged (it also
			// covers the Table Topics Master's ask), so it carries the shared verb
			// phrase rather than the whole constant.
			const timerWhen = SHEET_SCRIPTS.timer.map((c) => c.when).join(" | ");
			expect(timerWhen).toContain("explain the timing");
			expect(SHEET_SCRIPTS.timer.map((c) => c.say).join(" | ")).toContain(
				"For each evaluation:",
			);
		});

		it("has the Timer ready for the Table Topics ask the agenda makes", () => {
			// The flex segment carrying the Table Topics marks — again structural.
			const [segment] = template.filter(
				(b) =>
					b.kind === "role" &&
					b.flex === true &&
					b.marks === TABLE_TOPICS_MARKS,
			);
			expect(segment).toBeDefined();
			expect(segment.detail).toContain("to explain the timing");

			const says = SHEET_SCRIPTS.timer.map((c) => c.say).join(" | ");
			expect(says).toContain("For Table Topics:");
			expect(says).toContain("For each evaluation:");
		});

		it("has the Grammarian give the Word of the Day where the agenda says", () => {
			// Expand against a real club so this reads the RESOLVED row, tokens and
			// fallbacks included, not the template string.
			const club: AgendaSlot[] = [
				{
					id: "tm",
					roleKey: "toastmaster_of_the_day",
					roleName: "Toastmaster of the Day",
					category: "leadership",
					assigneeName: "Faisal",
				},
				{
					id: "gr",
					roleKey: "grammarian",
					roleName: "Grammarian",
					category: "functionary",
					assigneeName: "Gina",
				},
			].map((x) => ({
				isSpeakerRole: false,
				slotIndex: 0,
				speechTitle: null,
				projectLevel: null,
				minMinutes: null,
				maxMinutes: null,
				evaluatesSlotId: null,
				evaluates: null,
				...x,
			})) as AgendaSlot[];
			const intro = expandRunSheet(club).find((r) =>
				r.detail.includes("; each explains their role"),
			);
			expect(intro?.detail).toContain("Word of the Day");

			const [first] = SHEET_SCRIPTS.grammarian;
			expect(first.when).toContain("Word of the Day");
			expect(first.say).toContain("Word of the Day");
		});
	});
});

describe("the Ah-Counter is not handed the booked speakers (#509)", () => {
	function textOf(node: unknown): string[] {
		if (node == null || node === false) return [];
		if (typeof node === "string") return [node];
		if (Array.isArray(node)) return node.flatMap(textOf);
		const el = node as { props?: { children?: unknown } };
		return el.props ? textOf(el.props.children) : [];
	}
	const named = (key: RoleSheetKey) =>
		textOf(buildRoleSheetDoc(key, fill)).join(" | ");

	it("prints none of the speaker names, even when the fill carries them", () => {
		const words = named("ah-counter");
		for (const speaker of fill.speakers) expect(words).not.toContain(speaker);
	});

	it("says plainly that it covers everyone who speaks", () => {
		expect(named("ah-counter")).toContain("not just the prepared speakers");
	});

	it("asks 'Who spoke', not 'Speaker'", () => {
		const words = named("ah-counter");
		expect(words).toContain("Who spoke");
	});

	// The other half of the decision: the Timer's log DOES keep its pre-fill,
	// because those rows are assignments with booked times, not an audit of who
	// talked. Without this, "drop the pre-fill" could be over-applied and no test
	// would notice.
	it("leaves the Timer's log pre-filled", () => {
		const words = named("timer");
		for (const speaker of fill.speakers) expect(words).toContain(speaker);
	});
});

// ---------------------------------------------------------------------------
// Page count. These are HANDHELD sheets — one page each is the product, not a
// detail. Adding the "What to say" block (#509) silently pushed three of the
// five onto a second page, and nothing caught it: the smoke tests above assert
// "valid PDF, size > 500", which a two-page PDF satisfies comfortably. It took
// rendering them and counting by hand to notice.
//
// Reads the page tree's `/Count`, so it measures the real rendered output
// rather than anything the layout claims about itself. Related: #502 wants this
// same harness for the printed agenda, which has the same blind spot.
// ---------------------------------------------------------------------------
describe("every role sheet fits on one page", () => {
	async function pageCount(
		doc: ReturnType<typeof buildRoleSheetDoc>,
	): Promise<number> {
		const buf = await renderToBuffer(
			doc as Parameters<typeof renderToBuffer>[0],
		);
		const m = buf.toString("latin1").match(/\/Count\s+(\d+)/);
		if (m == null) throw new Error("no /Count in the PDF page tree");
		return Number(m[1]);
	}

	// Fills chosen for the values that are USER DATA and therefore unbounded.
	// The first version of this suite ran only the narrow `fill` above (24-char
	// club) and reported green while a 34-character club name — "Sunrise
	// Speakers Toastmasters Club", an ordinary length — already put the Timer's
	// sheet on two pages. A one-page guarantee tested at one width is not a
	// guarantee.
	const FILLS: { label: string; fill?: RoleSheetFill }[] = [
		{ label: "blank template", fill: undefined },
		{ label: "typical fill", fill },
		{
			label: "long club name",
			fill: { ...fill, club: "Sunrise Speakers Toastmasters Club" },
		},
		{
			label: "absurd club name",
			fill: { ...fill, club: "C".repeat(80) },
		},
		{
			label: "four speakers with speech titles",
			fill: {
				...fill,
				speakers: [
					'Alice — "My Icebreaker"',
					'Bob — "Why We Run"',
					'Cara — "The Long Road Home"',
					'Dev — "Ten Minutes"',
				],
			},
		},
		{
			// Every unbounded field at once, which is the case no single-variable
			// fixture catches.
			label: "everything at once",
			fill: {
				club: "C".repeat(80),
				date: "Wednesday, July 22, 2026",
				speakers: [
					'Alice — "My Icebreaker"',
					'Bob — "Why We Run"',
					'Cara — "The Long Road Home"',
					'Dev — "Ten Minutes"',
				],
				wod: {
					word: "ebullient",
					note: "cheerful and full of energy, used well by three speakers today",
				},
			},
		},
	];

	for (const { key } of ROLE_SHEETS) {
		for (const { label, fill: f } of FILLS) {
			it(`"${key}" is one page — ${label}`, async () => {
				expect(await pageCount(buildRoleSheetDoc(key, f))).toBe(1);
			});
		}
	}
});
