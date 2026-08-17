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
import { WOD_LIMITS } from "#/lib/wod-limits";
import {
	buildRoleSheetDoc,
	capFill,
	RENDER_CAPS,
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

// The club logo shipped on this sheet with NO coverage: deleting the whole
// `fill?.logoDataUri ? Image : null` branch from header() left all 22 tests in
// this file green, because every one of them asserts either DATA or "is it a
// PDF" — the same blind spot #507 above was written for. These assert the
// rendered element tree.
describe("club logo on the role sheet (#496)", () => {
	/** Every element in a react-pdf tree, flattened. */
	function nodesOf(node: unknown): { props?: Record<string, unknown> }[] {
		if (node == null || node === false || typeof node === "string") return [];
		if (Array.isArray(node)) return node.flatMap(nodesOf);
		const el = node as { props?: Record<string, unknown> };
		if (!el.props) return [];
		return [el, ...nodesOf(el.props.children)];
	}

	const LOGO = "data:image/png;base64,AAAA";

	function nodes(withFill?: RoleSheetFill) {
		return nodesOf(buildRoleSheetDoc("timer", withFill));
	}

	function imageSources(withFill?: RoleSheetFill) {
		return nodes(withFill)
			.map((n) => n.props?.src)
			.filter((src): src is string => typeof src === "string");
	}

	function plates(withFill?: RoleSheetFill) {
		return nodes(withFill).filter((n) => {
			const style = n.props?.style as { backgroundColor?: string } | undefined;
			return style?.backgroundColor === "#fff";
		});
	}

	it("renders the club's logo when the fill carries one", () => {
		expect(imageSources({ ...fill, logoDataUri: LOGO })).toContain(LOGO);
	});

	it("renders no image at all when the fill has no logo", () => {
		expect(imageSources(fill)).toHaveLength(0);
		expect(imageSources()).toHaveLength(0);
	});

	it("backs the logo with a light plate, and only when there is a logo", () => {
		expect(plates({ ...fill, logoDataUri: LOGO })).toHaveLength(1);
		expect(plates(fill)).toHaveLength(0);
	});

	it("still renders a valid PDF with a logo present", async () => {
		const { ok } = await isPdf(
			buildRoleSheetDoc("timer", { ...fill, logoDataUri: LOGO }),
		);
		expect(ok).toBe(true);
	});

	// #496 AC5: "Page counts unchanged on the WOD poster and role sheets, with
	// and without a logo — counted from rendered PDF output, not eyeballed."
	// `isPdf` above only checks the %PDF- magic bytes, so a logo that pushed the
	// header tall enough to spill onto page 2 would still read as "a valid PDF".
	// This repo has shipped exactly that failure before: a missing print reset
	// added a blank second page and got past 6 test files, typecheck, lint and
	// two reviews, because print CSS has no gate here. Count the pages.
	async function pageCount(doc: ReturnType<typeof buildRoleSheetDoc>) {
		const buf = await renderToBuffer(
			doc as Parameters<typeof renderToBuffer>[0],
		);
		// Page objects are `/Type /Page`; the tree root is `/Type /Pages`, so the
		// negative lookahead is what keeps this from counting the container.
		return (buf.toString("latin1").match(/\/Type\s*\/Page(?![s])/g) ?? [])
			.length;
	}

	for (const { key } of ROLE_SHEETS) {
		it(`"${key}" stays one page whether or not the club has a logo`, async () => {
			const without = await pageCount(buildRoleSheetDoc(key, fill));
			const withLogo = await pageCount(
				buildRoleSheetDoc(key, { ...fill, logoDataUri: LOGO }),
			);
			expect(without).toBe(1);
			expect(withLogo).toBe(without);
		});
	}
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

	/**
	 * The double-clutch column and the sentence that explains it (#587).
	 *
	 * BOTH, in one test, because either alone is the bug. A column headed
	 * "Double clutch" with nothing defining it is a column a first-time
	 * Ah-Counter leaves blank — the term is opaque to anyone who has not held the
	 * role, which is exactly who picks this sheet up. A definition with no column
	 * has nowhere to write the tally.
	 */
	it("gives the Ah-Counter a double-clutch column and says what one is", () => {
		const words = named("ah-counter");
		expect(words).toContain("Double clutch");
		expect(words).toContain('A "double clutch" is a restart');
		// The spoken cue names it too, so the sheet and the words read off it
		// agree — the pairing `SHEET_SCRIPTS` exists to keep (#509). It used to
		// say "repeated words", gesturing at the thing without naming it.
		expect(words).toContain("double clutches");
		expect(words).not.toContain("and for repeated words");
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
			// The speaker COUNT axis, added after the adversarial pass found the
			// original matrix stopped at four and the sheet spilled at five. The
			// driver is not label width — five single-letter names spilled it too —
			// it is that a filled cell is taller than a blank one.
			label: "ten speakers with speech titles",
			fill: {
				...fill,
				speakers: Array.from(
					{ length: 10 },
					(_, i) => `Speaker ${i + 1} — "A Speech Title"`,
				),
			},
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
			// Every unbounded field at once, PLUS the club logo #496 added to these
			// sheets. Landing #496 and #509 in either order leaves this cross-product
			// untested by both sides: #496's logo tests use a three-speaker fixture,
			// and #509's hostile fills carried no logo. The combination spilled the
			// Timer's sheet, and neither suite saw it.
			//
			// EIGHT speakers here, not ten, and that is the honest bound: the logo
			// costs roughly two log rows of headroom, and past eight the rows come
			// from the speakers themselves so no blank-row budget can absorb them.
			// Eight booked prepared speeches is already past any real meeting; the
			// ten-speaker fill below still pins the no-logo case.
			label: "everything at once, with a club logo",
			fill: {
				club: "C".repeat(80),
				date: "Wednesday, July 22, 2026",
				logoDataUri:
					"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
				speakers: Array.from(
					{ length: 8 },
					(_, i) => `Speaker ${i + 1} — "A Speech Title"`,
				),
				wod: {
					word: "ebullient",
					note: "cheerful and full of energy, used well by three speakers today",
				},
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

// ---------------------------------------------------------------------------
// The header's three meta fields (#509 review). Two separate decisions live in
// `metaField`, and the page-count suite above sees only one of them.
//
// The one-line clamp IS covered there — dropping `maxLines`/`textOverflow`
// spills the Timer's and the Ballot Counter's sheets onto a second page, and
// that suite fails. The `flex` WEIGHTS are not: reverting them to equal thirds
// leaves all 61 tests green, because an equal-thirds header is still one line
// tall. What changes is where the ellipsis lands — a 34-character club name
// truncating mid-name instead of printing in full — and nothing could see it.
//
// So these read the header structurally. The rendered PDF is no help: react-pdf
// subsets its fonts and encodes glyph ids, so the club name is not recoverable
// from the buffer as text, and truncation is invisible to a byte search.
// ---------------------------------------------------------------------------
describe("role-sheet header meta fields (#509)", () => {
	interface MetaField {
		label: string;
		flexGrow: unknown;
		maxLines: unknown;
		textOverflow: unknown;
	}

	/**
	 * The three header fields, in printed order. Identified by the SHAPE
	 * `metaField` gives them — a style ARRAY whose override carries `maxLines` —
	 * rather than by their label text, so the lookup survives a reworded label.
	 */
	function metaFields(node: unknown): MetaField[] {
		if (node == null || typeof node !== "object") return [];
		if (Array.isArray(node)) return node.flatMap(metaFields);
		const el = node as { props?: { style?: unknown; children?: unknown } };
		if (el.props == null) return [];
		const style = el.props.style;
		const override = Array.isArray(style)
			? (style.find(
					(x) => x != null && typeof x === "object" && "maxLines" in x,
				) as Record<string, unknown> | undefined)
			: undefined;
		const here: MetaField[] =
			override == null
				? []
				: [
						{
							// The label is the field's first string child ("Club: "); a
							// filled field's value is a nested Text after it.
							label: (Array.isArray(el.props.children)
								? el.props.children.find((c) => typeof c === "string")
								: el.props.children) as string,
							flexGrow: override.flexGrow,
							maxLines: override.maxLines,
							textOverflow: override.textOverflow,
						},
					];
		return [...here, ...metaFields(el.props.children)];
	}

	const fields = metaFields(buildRoleSheetDoc("timer", fill));

	it("clamps every header field to a single line", () => {
		// The half the page-count suite already enforces, stated where a reader
		// looking at the header can see it. A wrapped field adds a line, and one
		// line spills the densest sheets.
		expect(fields).toHaveLength(3);
		for (const f of fields) {
			expect(f.maxLines).toBe(1);
			expect(f.textOverflow).toBe("ellipsis");
		}
	});

	it("gives the club name the most room and the date the least", () => {
		// Once every field is clamped to one line, the flex weights decide which
		// text survives to the ellipsis. The club name is much the longest of the
		// three and is USER DATA; the date is generated by us and short.
		const [club, date, yourName] = fields;
		expect(club.label).toContain("Club");
		expect(date.label).toContain("Date");
		expect(yourName.label).toContain("Your name");
		expect(Number(club.flexGrow)).toBeGreaterThan(Number(yourName.flexGrow));
		expect(Number(yourName.flexGrow)).toBeGreaterThan(Number(date.flexGrow));
	});
});

// ---------------------------------------------------------------------------
// #519 — the public role-sheet PDF route renders user text synchronously inside
// the single Node process, so an unbounded value is the whole server stopped,
// not a slow download. Measured on the pre-cap layout: a 50,000-character
// Word-of-the-Day note took 3,596ms against an 87ms baseline, and 500 speaker
// rows took 2,059ms.
//
// These assert the OBSERVABLE the cap controls — what actually reaches the
// document — rather than wall-clock time, which would be flaky on CI and would
// pass for the wrong reason on a fast machine.
// ---------------------------------------------------------------------------
describe("render caps bound what a public request can make us lay out (#519)", () => {
	function textOf(node: unknown): string[] {
		if (node == null || node === false) return [];
		if (typeof node === "string") return [node];
		if (Array.isArray(node)) return node.flatMap(textOf);
		const el = node as { props?: { children?: unknown } };
		return el.props ? textOf(el.props.children) : [];
	}
	const hostile = (over: Partial<RoleSheetFill> = {}): RoleSheetFill => ({
		club: "Harborlight Toastmasters",
		date: "Jul 22",
		speakers: [],
		...over,
	});

	it("truncates a Word-of-the-Day note far beyond the cap", () => {
		const note = "a".repeat(50_000);
		const words = textOf(
			buildRoleSheetDoc("grammarian", hostile({ wod: { word: "x", note } })),
		).join(" | ");
		expect(words).not.toContain(note);
		// The longest single string in the doc is bounded, not merely "shorter".
		const longest = Math.max(
			...textOf(
				buildRoleSheetDoc("grammarian", hostile({ wod: { word: "x", note } })),
			).map((t) => t.length),
		);
		expect(longest).toBeLessThanOrEqual(RENDER_CAPS.note);
	});

	it("caps the number of pre-filled log rows", () => {
		const many = Array.from({ length: 5_000 }, (_, i) => `Speaker ${i}`);
		const capped = capFill(hostile({ speakers: many }));
		expect(capped.speakers).toHaveLength(RENDER_CAPS.speakerRows);
		// The survivors are the FIRST 24 of the input, in order — a Timer reading
		// the log needs the meeting's own order, so a `.slice(-24)` regression
		// that kept the TAIL has to fail here. Pin both ends.
		expect(capped.speakers[0]).toBe("Speaker 0");
		expect(capped.speakers.at(-1)).toBe("Speaker 7");
	});

	it("costs time proportional to the CAP, not to the input", () => {
		// The one assertion here that is about WALL CLOCK, and deliberately so:
		// the defect it guards has no other observable. `cap` used to spread the
		// whole string (`[...value]`) BEFORE deciding to truncate, so an 8MB
		// speech title cost 473ms and tens of MB of heap to produce a 160-char
		// output — the same DoS this file exists to stop, moved inside the fix.
		// `speeches.title` is unbounded and written by PUBLIC no-session paths
		// (`claimSlot`, `updateSpeakerDetails`), so it is reachable.
		//
		// The margin makes it non-flaky: 8MB now takes ~2ms, the bug took ~473ms,
		// and the threshold sits at 150ms — 75x headroom under the fix, 3x under
		// the bug.
		const huge = "a".repeat(8_000_000);
		const started = performance.now();
		const capped = capFill({
			club: "c",
			date: "d",
			speakers: Array.from({ length: 8 }, () => huge),
		} as RoleSheetFill);
		const elapsed = performance.now() - started;
		expect(capped.speakers[0].length).toBe(RENDER_CAPS.speakerLabel);
		expect(elapsed).toBeLessThan(150);
	});

	it("keeps the row cap inside the one-page guarantee, logo included", () => {
		// The cap exists to bound cost, but it must not permit a shape that breaks
		// the one-page promise. A club logo (#496) costs about two rows, so the
		// binding case is WITH a logo — measured: 8 holds one page, 9 spills.
		// Two earlier values (24, then 10) were set without this case and both
		// were wrong. Assert the relationship, not just the number.
		expect(RENDER_CAPS.speakerRows).toBeLessThanOrEqual(8);
	});

	it("caps a single absurd speaker label", () => {
		const [label] = capFill(
			hostile({ speakers: [`Ann — "${"z".repeat(50_000)}"`] }),
		).speakers;
		expect(label.length).toBeLessThanOrEqual(RENDER_CAPS.speakerLabel);
	});

	it("caps the club name and the date", () => {
		const capped = capFill(
			hostile({ club: "c".repeat(50_000), date: "d".repeat(50_000) }),
		);
		expect(capped.club.length).toBeLessThanOrEqual(RENDER_CAPS.club);
		expect(capped.date.length).toBeLessThanOrEqual(RENDER_CAPS.date);
	});

	it("caps the Word of the Day itself, not only its note", () => {
		// Every other WOD assertion here passes `word: "x"` and pushes the hostile
		// payload through `note`, so `word: fill.wod.word` — the cap deleted from
		// the word alone — left the FULL suite green (3,023 tests, verified by
		// mutation). The word is not the harmless half: `metaField` clamps it to
		// one line so it costs no PAGES, but react-pdf still measures every glyph
		// synchronously, which is the cost #519 is about. It is also the field the
		// public Grammarian edit path (#296) writes, and the only WOD value that
		// reaches this document by any route other than the note.
		const capped = capFill(
			hostile({ wod: { word: "w".repeat(50_000), note: "fine" } }),
		);
		expect(capped.wod?.word.length).toBeLessThanOrEqual(RENDER_CAPS.word);
		expect(capped.wod?.note).toBe("fine");
	});

	it("truncates on a code-point boundary, never mid-surrogate-pair", () => {
		// `cap` slices `[...value]`, not `value.slice()`, and the reason is stated
		// in its doc comment — a UTF-16 slice through an astral character emits a
		// LONE SURROGATE, which react-pdf renders as a tombstone. Nothing asserted
		// it: swapping `[...value]` for `value.split("")` left the full suite
		// green. Reachable through a speaker label, since member names and speech
		// titles carry no write-side cap and emoji in a speech title are ordinary.
		//
		// The fixture has to put the cut INSIDE a pair or it proves nothing: `cap`
		// keeps `max - 1` units and appends "…", so the ASCII run is two short of
		// the cap and the emoji run starts exactly on the unit a UTF-16 slice would
		// bisect. A first attempt padded to the full cap, which lands the cut in
		// the ASCII prefix — both implementations agree there, and the mutation
		// survived.
		const label = `${"a".repeat(RENDER_CAPS.speakerLabel - 2)}${"🎤".repeat(20)}`;
		const [capped] = capFill(hostile({ speakers: [label] })).speakers;
		// No unpaired surrogate anywhere in the result.
		expect(capped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
		expect(capped).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
		// ...and the cap is still measured in code points, so an emoji-heavy label
		// is bounded by the same count a plain one is.
		expect([...capped].length).toBeLessThanOrEqual(RENDER_CAPS.speakerLabel);
	});

	it("leaves realistic values completely untouched", () => {
		// The bound is only useful if it never fires in practice. These are
		// realistic values — a little above the largest on record (longest club
		// name 20, longest note 50) and comfortably inside every cap.
		const real = hostile({
			club: "Mission City Flyers Toastmasters",
			date: "Wednesday, July 22, 2026",
			speakers: ['Alice — "My Icebreaker"', "Bob", "Cara"],
			wod: {
				word: "Cumbersomeness",
				note: "clumsy or unwieldy; used well by three speakers today",
			},
		});
		expect(capFill(real)).toEqual(real);
	});

	it("accounts for every field of the fill, so a new one cannot slip in uncapped", () => {
		// `capFill` spreads `...fill` and then overrides four keys, so a FIFTH key
		// added to `RoleSheetFill` later reaches react-pdf uncapped and nothing
		// else in this file notices — every other assertion is written against the
		// fields that exist today. This is the canary. `Required<RoleSheetFill>`
		// makes `tsc` demand the new key here, and the key comparison then forces
		// whoever added it to classify it rather than default to "unbounded".
		//
		// `logoDataUri` is exempt on purpose: it is bounded upstream by
		// `isDecodeSafe`/`MAX_LOGO_DIMENSION`, a pixel bound rather than a string
		// one, and truncating base64 here would only corrupt a valid image.
		const CAPPED = ["club", "date", "speakers", "wod"];
		const BOUNDED_ELSEWHERE = ["logoDataUri"];
		const every: Required<RoleSheetFill> = {
			club: "Harborlight Toastmasters",
			date: "Jul 22",
			logoDataUri: null,
			speakers: ["Ann"],
			wod: { word: "Cumbersomeness", note: "clumsy or unwieldy" },
		};
		expect(Object.keys(capFill(every)).sort()).toEqual(
			[...CAPPED, ...BOUNDED_ELSEWHERE].sort(),
		);
	});

	it("never mutates the caller's fill", () => {
		// The route reuses the fill to build the download filename after rendering.
		const original = hostile({
			club: "c".repeat(50_000),
			speakers: ["A", "B"],
		});
		const snapshot = { ...original, speakers: [...original.speakers] };
		capFill(original);
		expect(original).toEqual(snapshot);
	});

	it("applies through buildRoleSheetDoc, so every caller is bounded", () => {
		// Not just the public route — `scripts/build-role-sheets.ts` renders through
		// the same entry point, and a future caller will too.
		const note = "q".repeat(50_000);
		const words = textOf(
			buildRoleSheetDoc("grammarian", hostile({ wod: { word: "w", note } })),
		).join(" ");
		expect(words).not.toContain(note);
	});

	it("keeps every cap at a value that actually bounds the layout cost", () => {
		// EVERY other assertion in this describe is stated relative to
		// `RENDER_CAPS` itself — `toHaveLength(RENDER_CAPS.speakerRows)`,
		// `<= RENDER_CAPS.club` — so all of them pass for ANY cap value. Setting
		// `speakerRows: 5_000` leaves all 90 tests in this file green (verified by
		// mutation) while one public request costs 129,433ms of blocked event
		// loop; `club`/`date`/`speakerLabel` at 5_000_000 are green too. A test
		// that only proves "capFill applies RENDER_CAPS" cannot see the number
		// being wrong, and the number is the whole fix.
		//
		// Absolute ceilings instead, generous enough that no realistic value or
		// future tweak trips them (~4x the shipped caps; the longest club name on
		// record is 20 characters and no meeting has more than 3 speakers), and
		// tight enough to stay on the flat part of the cost curve. Measured on the
		// shipped layout: 24 rows of 160-character labels renders in 146ms against
		// a 23ms baseline; 500 rows takes 2,087ms.
		expect(RENDER_CAPS.club).toBeLessThanOrEqual(500);
		expect(RENDER_CAPS.date).toBeLessThanOrEqual(240);
		expect(RENDER_CAPS.speakerLabel).toBeLessThanOrEqual(640);
		expect(RENDER_CAPS.speakerRows).toBeLessThanOrEqual(60);
		// The two WOD caps are pinned by `wod-limits.test.ts`, which they derive
		// from; restate them here so deriving them from something else later is
		// still bounded at this end.
		expect(RENDER_CAPS.word).toBeLessThanOrEqual(240);
		expect(RENDER_CAPS.note).toBeLessThanOrEqual(2_000);
	});

	it("keeps the write cap inside the render cap, so nothing valid is elided", () => {
		// Both halves read `#/lib/wod-limits`, so this cannot drift — the assertion
		// documents the invariant and fails loudly if someone splits them again.
		expect(WOD_LIMITS.word).toBeLessThanOrEqual(RENDER_CAPS.word);
		expect(WOD_LIMITS.definition).toBeLessThanOrEqual(RENDER_CAPS.note);
	});
});
