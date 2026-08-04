/**
 * Shared `@react-pdf/renderer` layout for the club role sheets (#310, #311).
 * ONE source of truth for both the blank static sheets (built offline by
 * `scripts/build-role-sheets.ts` → `public/role-sheets/*.pdf`) and the
 * meeting-aware, server-rendered sheets pre-filled with a meeting's club, date,
 * and speakers (`role-sheets-pdf-logic.ts`). Passing no `fill` yields the blank
 * template; passing a `RoleSheetFill` pre-fills the header + speaker rows so the
 * blank and filled variants stay visually identical apart from the filled cells.
 *
 * Original content — NO Toastmasters International copyrighted material. Uses
 * `React.createElement` (not JSX) so this stays a `.ts` module, matching the
 * server minutes-PDF pattern (`minutes-pdf-logic.ts`). This module has NO `#/db`
 * import and is never imported by a client route (only the offline script and
 * the server-only render logic import it), so react-pdf never reaches the
 * browser bundle.
 */
import {
	Document,
	Image,
	Page,
	StyleSheet,
	Text,
	View,
} from "@react-pdf/renderer";
import { createElement as h, type ReactNode } from "react";
import type { RoleSheetKey } from "../data/role-sheets";
import { EVALUATION_TIMING_ASK } from "../lib/agenda-runsheet";
import { TOASTMASTERS_DISCLAIMER } from "../lib/brand";
import {
	formatTimingClock,
	graceSentence,
	qualifyingWindow,
} from "../lib/timing-window";
import { WOD_LIMITS } from "../lib/wod-limits";

// Re-export the client-safe registry so `scripts/build-role-sheets.ts` (which
// renders every sheet) can pull the list + builder from one import.
export {
	ROLE_SHEETS,
	type RoleSheetInfo,
	type RoleSheetKey,
	roleSheetByKey,
} from "../data/role-sheets";

/** Per-meeting context used to pre-fill a sheet. Absent ⇒ blank template. */
export interface RoleSheetFill {
	/** Club name, shown in the header "Club:" field. */
	club: string;
	/**
	 * The club's own logo as a base64 data URI, or absent.
	 *
	 * A data URI rather than the public `/api/club/:id/logo` URL because
	 * `@react-pdf/renderer` runs server-side here and would have to make a real
	 * HTTP request back into this app to resolve one — the bytes are already in
	 * the database this process is talking to.
	 */
	logoDataUri?: string | null;
	/** Formatted meeting date, shown in the header "Date:" field. */
	date: string;
	/**
	 * Ordered, display-ready speaker labels (assignee name, optionally with the
	 * speech title). Pre-fills the first column of the **Timer's** log only;
	 * blank rows remain for unfilled slots.
	 *
	 * The Ah-Counter's sheet used to take these too and no longer does (#509):
	 * that role listens to everyone who takes the floor, so a pre-printed list of
	 * the three booked speakers described the wrong job. The Timer's rows are
	 * assignments with booked times to compare against, which is a different
	 * thing, so they keep the fill.
	 */
	speakers: string[];
	/** The meeting's Word of the Day, pre-filled on the Grammarian's sheet. */
	wod?: { word: string; note?: string };
}

const C = {
	ink: "#1f2933",
	soft: "#52606d",
	line: "#b8c1cc",
	faint: "#eef1f4",
	// Signal colors, mirroring the Timer's green / yellow / red cards.
	green: "#1b7f3b",
	yellow: "#b45309",
	red: "#c0392b",
};

// PAGE BUDGET. Several values below (title/metaRow/sectionTitle/note margins,
// `th`/`td` padding, `td.minHeight`, `blankLine` height) were tightened in #509
// because the "What to say" block pushed three of the five sheets onto a second
// page. They are load-bearing, not cosmetic: relaxing one can silently spill a
// sheet. The constraint is pinned by "every role sheet fits on one page" in
// role-sheet-layout.test.ts — a different file, which is why it is restated here.
const s = StyleSheet.create({
	page: {
		paddingTop: 40,
		paddingBottom: 54,
		paddingHorizontal: 44,
		fontSize: 10,
		fontFamily: "Helvetica",
		color: C.ink,
		lineHeight: 1.35,
	},
	brand: {
		fontSize: 10,
		fontFamily: "Helvetica-Bold",
		color: C.soft,
		letterSpacing: 2,
	},
	// Explicit lineHeight so the 20pt title's descenders sit inside its box and
	// don't collide with the subtitle; marginBottom owns the title→subtitle gap.
	title: {
		fontSize: 20,
		fontFamily: "Helvetica-Bold",
		lineHeight: 1.3,
		marginTop: 2,
		marginBottom: 4,
	},
	subtitle: { fontSize: 10, color: C.soft },
	metaRow: { flexDirection: "row", gap: 18, marginTop: 10 },
	wodRow: { flexDirection: "row", gap: 18 },
	winnerRow: { flexDirection: "row", gap: 18, marginTop: 6 },
	metaField: {
		flexGrow: 1,
		flexBasis: 0,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
		paddingBottom: 2,
		fontSize: 9,
		color: C.soft,
	},
	// The filled value inside a meta field ("Harborlight" after "Club:").
	metaValue: { color: C.ink, fontFamily: "Helvetica-Bold" },
	sectionTitle: {
		fontSize: 12,
		fontFamily: "Helvetica-Bold",
		marginTop: 8,
		marginBottom: 4,
	},
	note: { fontSize: 9, color: C.soft, marginBottom: 4 },
	thRow: {
		flexDirection: "row",
		borderTopWidth: 1,
		borderColor: C.ink,
		backgroundColor: C.faint,
	},
	th: {
		fontSize: 9,
		fontFamily: "Helvetica-Bold",
		padding: 4,
		borderRightWidth: 1,
		borderColor: C.line,
	},
	tr: { flexDirection: "row" },
	td: {
		minHeight: 18,
		padding: 4,
		borderBottomWidth: 1,
		borderRightWidth: 1,
		borderColor: C.line,
	},
	tdText: { fontSize: 9 },
	blankLine: {
		borderBottomWidth: 1,
		borderColor: C.line,
		height: 17,
		marginTop: 5,
	},
	box: { borderWidth: 1, borderColor: C.line, padding: 10, marginTop: 8 },
	// The "What to say" block (#509). A left rule rather than a full border, so it
	// reads as speech pulled out of the page rather than another field to fill in
	// — every other bordered box on these sheets is somewhere you WRITE.
	scriptBox: {
		borderLeftWidth: 3,
		borderLeftColor: C.line,
		paddingLeft: 10,
		marginTop: 2,
		marginBottom: 2,
	},
	/** The moment a line belongs to: "When you are introduced". */
	cueWhen: {
		fontSize: 8.5,
		fontFamily: "Helvetica-Bold",
		color: C.soft,
		marginTop: 4,
	},
	/** The words to read aloud. Italic is the signal that this IS the speech. */
	cueSay: { fontSize: 9, fontFamily: "Helvetica-Oblique", marginTop: 0.5 },
	footer: {
		position: "absolute",
		left: 44,
		right: 44,
		bottom: 26,
		fontSize: 7,
		color: C.soft,
		borderTopWidth: 1,
		borderTopColor: C.line,
		paddingTop: 6,
	},
});

type Col = { label: string; flex: number; color?: string };

/** A header row plus one row per entry in `rows` (empty strings = blank cells).
 *  A column's optional `color` tints both its header label and its cell text. */
function table(cols: Col[], rows: string[][]): ReactNode {
	const head = h(
		View,
		{ style: s.thRow },
		cols.map((c, i) =>
			h(
				Text,
				{
					key: i,
					style: [
						s.th,
						{ flexGrow: c.flex, flexBasis: 0, color: c.color ?? C.ink },
					],
				},
				c.label,
			),
		),
	);
	const body = rows.map((row, r) =>
		h(
			View,
			{ key: r, style: s.tr },
			cols.map((c, i) =>
				h(
					View,
					{ key: i, style: [s.td, { flexGrow: c.flex, flexBasis: 0 }] },
					h(
						Text,
						{ style: [s.tdText, { color: c.color ?? C.ink }] },
						row[i] ?? "",
					),
				),
			),
		),
	);
	return h(View, {}, head, ...body);
}

/** `n` blank rows of `cols` empty cells. */
function blank(n: number, cols: number): string[][] {
	return Array.from({ length: n }, () =>
		Array.from({ length: cols }, () => ""),
	);
}

/**
 * Pre-fill the first column of a `cols`-wide table with `firstCol` values, then
 * pad with blank rows so at least `min` rows are always present (leaving room to
 * hand-write additional entries). If there are more values than `min`, every
 * value still gets a row.
 */
function filledRows(firstCol: string[], min: number, cols: number): string[][] {
	const rows = firstCol.map((v) => [
		v,
		...Array.from({ length: cols - 1 }, () => ""),
	]);
	const pad = Math.max(0, min - rows.length);
	return [...rows, ...blank(pad, cols)];
}

/** `n` ruled blank lines for free-text notes. */
function lines(n: number): ReactNode[] {
	return Array.from({ length: n }, (_, i) =>
		h(View, { key: i, style: s.blankLine }),
	);
}

/** One scripted moment: when it happens, and the words to read (#509). */
export interface ScriptCue {
	/** The moment — "When you are introduced". */
	when: string;
	/** The words, written to be read aloud verbatim by someone who has never
	 *  held the role. */
	say: string;
}

/**
 * The "What to say" block (#509).
 *
 * These sheets were logs: a grid to tally into, with no wording for the moment
 * the holder is handed the floor. That asks a first-timer — the person most
 * likely to be holding a functionary sheet — to already know the words.
 *
 * The lines are ORIGINAL, like everything else here: no Toastmasters
 * International material (see the module header). They are deliberately plain
 * and short, because they are meant to be read aloud by someone nervous, and
 * they say what the printed agenda's cue says, so the run sheet and the sheet in
 * the holder's hand never give one person two different instructions — the
 * cross-surface agreement #509 asked for and `role-sheet-layout.test.ts` pins.
 */
function script(cues: ScriptCue[]): ReactNode[] {
	return [
		h(Text, { key: "script-t", style: s.sectionTitle }, "What to say"),
		h(
			View,
			{ key: "script-b", style: s.scriptBox },
			...cues.flatMap((c, i) => [
				h(Text, { key: `w${i}`, style: s.cueWhen }, c.when),
				h(Text, { key: `s${i}`, style: s.cueSay }, `“${c.say}”`),
			]),
		),
	];
}

/**
 * A header meta field: `label` with an optional filled `value`, else a blank
 * underline to write on.
 *
 * `flex` exists because the three header fields hold very different amounts of
 * text and equal thirds made the widest one wrap (review finding). A club named
 * "Sunrise Speakers Toastmasters Club" — 34 characters, an ordinary length —
 * took a second line, and that one line was enough to push the Timer's sheet
 * onto a second page. The club name gets the room; the date needs almost none.
 */
function metaField(label: string, value?: string, flex = 1): ReactNode {
	// Two separate jobs, and only one of them is a guarantee.
	//
	// `maxLines`/`textOverflow` make the header's HEIGHT independent of what the
	// club is called. A wrapped header adds one line, and one line is enough to
	// push the Timer's sheet — the densest of the five — onto a second page.
	// This half is pinned by "every role sheet fits on one page"; removing it
	// fails that suite on the long-club-name fills.
	//
	// `flex` only decides how much text fits BEFORE the ellipsis, so the club
	// name (much the longest of the three fields) prints in full for realistic
	// names instead of truncating at an equal third. Legibility, not page count:
	// reverting it leaves the page-count suite green, so it is deliberately not
	// claimed as load-bearing.
	//
	// NOTE: both are STYLE properties in react-pdf, not props. The first attempt
	// passed them as props, which silently does nothing and measured as no change
	// at all.
	const style = [
		s.metaField,
		{ flexGrow: flex, maxLines: 1, textOverflow: "ellipsis" as const },
	];
	return value
		? h(Text, { style }, `${label} `, h(Text, { style: s.metaValue }, value))
		: h(Text, { style }, label);
}

function header(
	title: string,
	subtitle: string,
	fill?: RoleSheetFill,
): ReactNode {
	return h(
		View,
		{},
		// Brand line as a row so the club's own logo can sit opposite the product
		// name rather than stacking and pushing the form fields down — these
		// sheets are one page by design.
		h(
			View,
			{
				style: {
					flexDirection: "row",
					alignItems: "center",
					justifyContent: "space-between",
				},
			},
			h(Text, { style: s.brand }, "GAVELUP"),
			// Same light plate the HTML surfaces put behind the logo (see
			// `club-logo.tsx`), so the treatment is identical everywhere a club's
			// image appears. This page is white, so here it is invisible — it is
			// kept for consistency rather than effect, and so that a future dark
			// header on this sheet does not silently swallow a dark logo.
			fill?.logoDataUri
				? h(
						View,
						{
							style: {
								backgroundColor: "#fff",
								borderRadius: 3,
								padding: 3,
							},
						},
						h(Image, {
							src: fill.logoDataUri,
							style: { height: 26, maxWidth: 110, objectFit: "contain" },
						}),
					)
				: null,
		),
		h(Text, { style: s.title }, title),
		h(Text, { style: s.subtitle }, subtitle),
		h(
			View,
			{ style: s.metaRow },
			metaField("Club:", fill?.club, 1.7),
			metaField("Date:", fill?.date, 0.7),
			// The role-taker always writes their own name.
			metaField("Your name:", undefined, 1.1),
		),
	);
}

function sheet(
	title: string,
	subtitle: string,
	body: ReactNode[],
	fill?: RoleSheetFill,
): ReactNode {
	return h(
		Document,
		{},
		h(
			Page,
			{ size: "LETTER", style: s.page },
			header(title, subtitle, fill),
			...body,
			h(Text, { style: s.footer, fixed: true }, TOASTMASTERS_DISCLAIMER),
		),
	);
}

// ---- The five sheets -------------------------------------------------------

/**
 * The standard assignment windows printed on the Timer's sheet, held as MINUTES
 * so every printed column is derived rather than transcribed (#357): yellow is
 * the midpoint, and the qualifying window is the 30-second grace either side.
 */
const STANDARD_TIMING_WINDOWS: {
	assignment: string;
	min: number;
	max: number;
}[] = [
	{ assignment: "Ice Breaker", min: 4, max: 6 },
	{ assignment: "Prepared speech", min: 5, max: 7 },
	{ assignment: "Evaluation", min: 2, max: 3 },
	{ assignment: "Table Topics", min: 1, max: 2 },
];

/** The Timer sheet's "Standard timing windows" table rows, as printed:
 *  assignment · green · yellow · red · qualifying window. */
export function standardTimingRows(): string[][] {
	return STANDARD_TIMING_WINDOWS.map(({ assignment, min, max }) => [
		assignment,
		formatTimingClock(min),
		formatTimingClock((min + max) / 2),
		formatTimingClock(max),
		qualifyingWindow(min, max)?.range ?? "",
	]);
}

function timer(fill?: RoleSheetFill): ReactNode {
	return sheet(
		"Timer's log",
		"Time each speaker and signal green / yellow / red at their windows.",
		[
			...script(SHEET_SCRIPTS.timer),
			h(Text, { key: "a", style: s.sectionTitle }, "Standard timing windows"),
			h(
				Text,
				{ key: "b", style: s.note },
				"Confirm each speaker's assigned time before the meeting — projects vary.",
			),
			h(
				View,
				{ key: "c" },
				table(
					[
						{ label: "Assignment", flex: 2 },
						{ label: "Green (min)", flex: 1, color: C.green },
						{ label: "Yellow", flex: 1, color: C.yellow },
						{ label: "Red (max)", flex: 1, color: C.red },
						{ label: "Qualifies", flex: 1.6 },
					],
					standardTimingRows(),
				),
			),
			h(
				Text,
				{ key: "c-grace", style: [s.note, { marginTop: 6 }] },
				`${graceSentence(null)} Outside that window the speech is disqualified from the vote — call it out in your report.`,
			),
			h(Text, { key: "d", style: s.sectionTitle }, "Timing log"),
			h(
				View,
				{ key: "e" },
				table(
					[
						{ label: "Speaker / role", flex: 3 },
						{ label: "Assigned time", flex: 2 },
						{ label: "Actual time", flex: 2 },
						{ label: "Color", flex: 1 },
					],
					// TEN rows, not the twelve this had before #509 (review finding).
					// A FILLED cell is ~2pt taller than a blank one (its line box
					// exceeds `td.minHeight`), so every pre-filled speaker eats
					// headroom, and the script block left almost none: five prepared
					// speakers — an ordinary meeting — spilled the sheet onto a second
					// page. Two fewer blank rows buys back enough for ten filled ones.
					// Rows are the right thing to spend: they are the cheapest part of
					// this sheet, and the Timer writes the rest of the meeting's items
					// in as they happen anyway.
					filledRows(fill?.speakers ?? [], 10, 4),
				),
			),
		],
		fill,
	);
}

function ahCounter(fill?: RoleSheetFill): ReactNode {
	return sheet(
		"Ah-Counter's log",
		"Tally filler words and crutch phrases; report totals at the end.",
		[
			...script(SHEET_SCRIPTS["ah-counter"]),
			// Deliberately NOT pre-filled with the booked speakers (#509), and the
			// only sheet where that changed. The Ah-Counter listens to EVERYONE who
			// takes the floor — Table Topics respondents, evaluators, the Toastmaster,
			// the other functionaries — so three printed names invited three rows of
			// tallies and quietly excluded most of the meeting. Blank rows and a
			// column that says "Who spoke" ask the right question instead.
			//
			// The Timer's log keeps its pre-fill: those rows are ASSIGNMENTS with
			// booked times to compare against, not an audit of who talked.
			h(
				Text,
				{ key: "a-note", style: s.note },
				"Everyone who speaks, not just the prepared speakers — Table Topics, evaluations, and your fellow functionaries all count.",
			),
			h(
				View,
				{ key: "a" },
				table(
					[
						{ label: "Who spoke", flex: 2 },
						{ label: "Um / Ah", flex: 1 },
						{ label: "So", flex: 1 },
						{ label: "Like", flex: 1 },
						{ label: "And / But", flex: 1 },
						{ label: "You know", flex: 1 },
						{ label: "Other", flex: 1 },
						{ label: "Total", flex: 1 },
					],
					blank(12, 8),
				),
			),
		],
		fill,
	);
}

function grammarian(fill?: RoleSheetFill): ReactNode {
	return sheet(
		"Grammarian's log",
		"Introduce the Word of the Day and note memorable language.",
		[
			...script(SHEET_SCRIPTS.grammarian),
			h(Text, { key: "a", style: s.sectionTitle }, "Word of the Day"),
			h(
				View,
				{ key: "b", style: s.box },
				h(
					View,
					{ style: s.wodRow },
					metaField("Word:", fill?.wod?.word),
					metaField("Part of speech:"),
				),
				h(
					Text,
					{ style: { marginTop: 12, fontSize: 9, color: C.soft } },
					fill?.wod?.note
						? h(
								Text,
								{},
								"Meaning / how it was used: ",
								h(Text, { style: s.metaValue }, fill.wod.note),
							)
						: "Meaning / how it was used:",
				),
				h(View, { style: s.blankLine }),
			),
			h(Text, { key: "c", style: s.sectionTitle }, "Good use of language"),
			h(View, { key: "c-lines" }, ...lines(5)),
			h(Text, { key: "d", style: s.sectionTitle }, "Language to improve"),
			h(View, { key: "d-lines" }, ...lines(5)),
		],
		fill,
	);
}

function award(title: string): ReactNode[] {
	return [
		h(Text, { key: `${title}-t`, style: s.sectionTitle }, title),
		h(
			View,
			{ key: `${title}-g` },
			table(
				[
					{ label: "Nominee", flex: 3 },
					{ label: "Tally", flex: 2 },
					{ label: "Total", flex: 1 },
				],
				blank(5, 3),
			),
		),
		h(View, { key: `${title}-w`, style: s.winnerRow }, metaField("Winner:")),
	];
}

function ballotCounter(fill?: RoleSheetFill): ReactNode {
	return sheet(
		"Ballot / Vote Counter tally",
		"Collect and tally the votes for each award.",
		[
			...script(SHEET_SCRIPTS["ballot-counter"]),
			...award("Best Speaker"),
			...award("Best Evaluator"),
			...award("Best Table Topics"),
		],
		fill,
	);
}

function generalEvaluator(fill?: RoleSheetFill): ReactNode {
	return sheet(
		"General Evaluator notes",
		"Evaluate the meeting as a whole and lead the evaluation team.",
		[
			...script(SHEET_SCRIPTS["general-evaluator"]),
			h(Text, { key: "a", style: s.sectionTitle }, "Meeting flow & timing"),
			h(View, { key: "a-lines" }, ...lines(2)),
			h(
				Text,
				{ key: "b", style: s.sectionTitle },
				"Evaluators (evaluate the evaluators)",
			),
			h(View, { key: "b-lines" }, ...lines(3)),
			h(
				Text,
				{ key: "d", style: s.sectionTitle },
				"Environment & Sergeant at Arms",
			),
			h(View, { key: "d-lines" }, ...lines(2)),
			h(Text, { key: "e", style: s.sectionTitle }, "Overall commendations"),
			h(View, { key: "e-lines" }, ...lines(3)),
			h(Text, { key: "f", style: s.sectionTitle }, "Overall recommendations"),
			h(View, { key: "f-lines" }, ...lines(3)),
		],
		fill,
	);
}

/**
 * "green at 2:00, yellow at 2:30, red at 3:00" for a standard assignment.
 *
 * DERIVED from `STANDARD_TIMING_WINDOWS`, never transcribed — the same rule
 * #357 set for the printed columns, and it matters more here: the Timer reads
 * these numbers aloud while the table stating them sits on the same sheet, so a
 * transcribed copy would have one page contradicting itself. Throws on an
 * unknown assignment rather than defaulting, because a silent miss would put an
 * invented time in someone's mouth.
 */
function signalSentence(assignment: string): string {
	const w = STANDARD_TIMING_WINDOWS.find((x) => x.assignment === assignment);
	if (w == null)
		throw new Error(`role-sheet script: no standard window for ${assignment}`);
	return `green at ${formatTimingClock(w.min)}, yellow at ${formatTimingClock(
		(w.min + w.max) / 2,
	)}, red at ${formatTimingClock(w.max)}`;
}

/**
 * What each sheet's holder says, and when (#509).
 *
 * Exported so the tests can pin each line against the agenda cue it has to
 * agree with (#508). The pairs are the point: a Timer told one thing by the run
 * sheet and another by the paper in their hand is worse off than one told
 * nothing.
 */
export const SHEET_SCRIPTS: Record<RoleSheetKey, ScriptCue[]> = {
	timer: [
		{
			when: "When you are introduced with the other functionaries",
			say: "I'm your Timer. I show a green card at your minimum time, yellow at the midpoint, and red at your maximum. When you see red, please begin to close.",
		},
		{
			// One cue, not two. #508 has the Table Topics Master and the General
			// Evaluator each ask this at their own segment, but the Timer is looking
			// at ONE sheet in the moment and wants one place to read from — and the
			// merged form is what kept this sheet to a single page.
			when: "When the Table Topics Master or the General Evaluator asks you to explain the timing",
			say: `For Table Topics: ${signalSentence("Table Topics")}. For each evaluation: ${signalSentence("Evaluation")}.`,
		},
		{
			when: "When you are called for your report",
			say: "Here are the times. Anyone outside their qualifying window is not eligible for the vote.",
		},
	],
	"ah-counter": [
		{
			when: "When you are introduced with the other functionaries",
			say: "I'm your Ah-Counter. I listen for filler words — um, ah, so, like, you know — and for repeated words, from everyone who speaks today, not just our prepared speakers.",
		},
		{
			when: "When you are called for your report",
			say: "Here is what I counted. This is not a criticism — a pause is stronger than a filler, and noticing them is how we lose them.",
		},
	],
	grammarian: [
		{
			when: "When you are introduced, this is your moment to give the Word of the Day",
			say: "I'm your Grammarian. Our Word of the Day is on the board — please use it when you speak today. I'll also be listening for language worth repeating.",
		},
		{
			when: "When you are called for your report",
			say: "Here is who used the Word of the Day, and some of the language that stood out.",
		},
	],
	"ballot-counter": [
		{
			when: "When you are introduced with the other functionaries",
			say: "I'm your Ballot Counter. I'll collect your ballots after each voting segment — please write clearly, and hand them to me rather than calling out a name.",
		},
		{
			when: "When you hand the results back",
			say: "The results are counted and sealed. I'll pass them to the Toastmaster for the awards.",
		},
	],
	"general-evaluator": [
		{
			when: "When you take the room for the evaluation segment",
			say: "Thank you. I'm your General Evaluator. I lead the evaluation team, and at the end I'll evaluate the meeting as a whole.",
		},
		{
			when: "When you introduce the speech evaluators",
			// Same string the printed agenda puts in this officer's row — see
			// `EVALUATION_TIMING_ASK`. Not a copy of it.
			say: `Our evaluators will each give a spoken evaluation. Timer, would you ${EVALUATION_TIMING_ASK}?`,
		},
		{
			when: "When you call for the functionary reports",
			say: "Now the reports from our functionaries.",
		},
		{
			when: "When you give the overall evaluation",
			say: "Here is how the meeting ran overall — what worked, and one thing we can each take into next time.",
		},
	],
};

const BUILDERS: Record<RoleSheetKey, (fill?: RoleSheetFill) => ReactNode> = {
	timer,
	"ah-counter": ahCounter,
	grammarian,
	"ballot-counter": ballotCounter,
	"general-evaluator": generalEvaluator,
};

/**
 * Hard caps on the user-controlled values this layout renders (#519).
 *
 * `renderRoleSheetPdf` is reached by an UNAUTHENTICATED public GET that renders
 * a PDF per request (`no-store`), inside the one Node process that serves
 * everything else (ADR-0007). react-pdf lays out synchronously, so an oversized
 * value is not a slow response — it is the event loop, and therefore the whole
 * server, stopped. Measured on the pre-cap layout: a 50,000-character
 * Word-of-the-Day note took 3,596ms against an 87ms baseline, and 500 speaker
 * rows took 2,059ms.
 *
 * The caps are ~10x the largest value in real data (the longest `wod_definition`
 * on record is 50 characters, the longest club name 20, and no meeting has more
 * than 3 speaker slots), so nothing a club would actually type is truncated.
 *
 * `logoDataUri` is deliberately NOT capped here — it is bounded upstream by
 * `isDecodeSafe`/`MAX_LOGO_DIMENSION` in `role-sheets-pdf-logic.ts`, which is a
 * pixel bound rather than a string one. After this fix the logo decode is the
 * dominant per-request cost on this route (~130-160ms, re-decoded every time
 * because the route is `no-store`), so it is the next thing to look at if this
 * endpoint ever needs a lower floor.
 *
 * This is the SECOND of two layers and the load-bearing one, mirroring
 * `isDecodeSafe` on the logo path: schema `.max()` stops new oversized values
 * being stored, and this stops rows that predate the cap — including any an
 * importer, a migration, or a future write path puts there. Truncating is the
 * right failure, exactly as dropping an undecodable logo is: a sheet with an
 * elided note still prints, and the Timer still gets their log.
 */
export const RENDER_CAPS = {
	/** Club name. The header clamps to one line anyway; this bounds the string. */
	club: 120,
	/** Formatted date. Ours, not user input — capped defensively. */
	date: 60,
	// The two WOD fields read the SAME constant the write schema validates
	// against (`#/lib/wod-limits`), so a value the schema accepts can never be
	// silently elided when printed, and the two halves of this defence cannot
	// drift apart the way two hand-kept numbers would.
	word: WOD_LIMITS.word,
	note: WOD_LIMITS.definition,
	/** One `Name — "Speech title"` label. */
	speakerLabel: 160,
	/**
	 * Pre-filled log rows — EIGHT, the largest value that holds the one-page
	 * guarantee in BOTH the logo and no-logo cases.
	 *
	 * Chosen against that guarantee, not just against cost. `filledRows` pads to
	 * 10 but does not truncate, so each pre-filled speaker past the fold adds a
	 * row. Measured on the Timer's sheet, which is the densest of the five:
	 *
	 *   speakers   no logo   with logo
	 *      8         1 page    1 page
	 *      9         1 page    2 pages   <- the club logo (#496) costs ~2 rows
	 *     10         1 page    2 pages
	 *
	 * Two earlier values were wrong for the same reason, each caught one review
	 * later: 24 (chosen for cost alone) and 10 (chosen against the no-logo
	 * measurement only). The logo is not an edge case — it is a shipped feature
	 * any club can turn on, so the bound has to hold with it present.
	 *
	 * No meeting on record books more than 3 prepared speakers, so 8 is still
	 * ~2.7x the observed maximum; beyond it the Timer writes the remaining items
	 * in as they happen, which is how the log already works.
	 */
	speakerRows: 8,
} as const;

/**
 * Truncate with an ellipsis, or return the value unchanged when it fits.
 *
 * Slices by CODE POINT, not UTF-16 code unit: `"…".slice()` on a string whose
 * emoji straddles the cut emits a lone surrogate, which react-pdf renders as a
 * tombstone glyph. Reachable through a speaker label, since speech titles and
 * member names carry no write-side length cap.
 */
function cap(value: string, max: number): string {
	const points = [...value];
	return points.length <= max ? value : `${points.slice(0, max - 1).join("")}…`;
}

/**
 * Apply `RENDER_CAPS` to a fill. Pure — the caller's object is never mutated,
 * because the fill is shared with the response's filename builder.
 */
export function capFill(fill: RoleSheetFill): RoleSheetFill {
	return {
		...fill,
		club: cap(fill.club, RENDER_CAPS.club),
		date: cap(fill.date, RENDER_CAPS.date),
		speakers: fill.speakers
			.slice(0, RENDER_CAPS.speakerRows)
			.map((s) => cap(s, RENDER_CAPS.speakerLabel)),
		wod: fill.wod && {
			word: cap(fill.wod.word, RENDER_CAPS.word),
			note:
				fill.wod.note == null
					? undefined
					: cap(fill.wod.note, RENDER_CAPS.note),
		},
	};
}

/**
 * Build the react-pdf `Document` for a role sheet. With `fill`, the header and
 * speaker rows are pre-filled; without it, the blank template is produced.
 *
 * Any caller that passes a `fill` gets it capped here, so the bound lives at the
 * single entry point rather than on whichever path someone remembered to guard.
 * `scripts/build-role-sheets.ts` passes no fill at all (the blank template), so
 * `capFill` correctly never runs there and the committed PDFs are unaffected.
 */
export function buildRoleSheetDoc(
	key: RoleSheetKey,
	fill?: RoleSheetFill,
): ReactNode {
	return BUILDERS[key](fill && capFill(fill));
}
