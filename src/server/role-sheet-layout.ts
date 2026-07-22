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
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { createElement as h, type ReactNode } from "react";
import type { RoleSheetKey } from "../data/role-sheets";
import { TOASTMASTERS_DISCLAIMER } from "../lib/brand";

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
	/** Formatted meeting date, shown in the header "Date:" field. */
	date: string;
	/**
	 * Ordered, display-ready speaker labels (assignee name, optionally with the
	 * speech title). Pre-fills the first column of the sheets that have a speaker
	 * table (Timer, Ah-Counter); blank rows remain for unfilled slots.
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
	// Signal colors, mirroring the Timer's green / amber / red cards.
	green: "#1b7f3b",
	amber: "#b45309",
	red: "#c0392b",
};

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
		marginTop: 4,
		marginBottom: 6,
	},
	subtitle: { fontSize: 10, color: C.soft },
	metaRow: { flexDirection: "row", gap: 18, marginTop: 14 },
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
		marginTop: 14,
		marginBottom: 6,
	},
	note: { fontSize: 9, color: C.soft, marginBottom: 6 },
	thRow: {
		flexDirection: "row",
		borderTopWidth: 1,
		borderColor: C.ink,
		backgroundColor: C.faint,
	},
	th: {
		fontSize: 9,
		fontFamily: "Helvetica-Bold",
		padding: 5,
		borderRightWidth: 1,
		borderColor: C.line,
	},
	tr: { flexDirection: "row" },
	td: {
		minHeight: 22,
		padding: 5,
		borderBottomWidth: 1,
		borderRightWidth: 1,
		borderColor: C.line,
	},
	tdText: { fontSize: 9 },
	blankLine: {
		borderBottomWidth: 1,
		borderColor: C.line,
		height: 20,
		marginTop: 6,
	},
	box: { borderWidth: 1, borderColor: C.line, padding: 10, marginTop: 8 },
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

/** A header meta field: `label` with an optional filled `value`, else a blank
 *  underline to write on. */
function metaField(label: string, value?: string): ReactNode {
	return value
		? h(
				Text,
				{ style: s.metaField },
				`${label} `,
				h(Text, { style: s.metaValue }, value),
			)
		: h(Text, { style: s.metaField }, label);
}

function header(
	title: string,
	subtitle: string,
	fill?: RoleSheetFill,
): ReactNode {
	return h(
		View,
		{},
		h(Text, { style: s.brand }, "GAVELUP"),
		h(Text, { style: s.title }, title),
		h(Text, { style: s.subtitle }, subtitle),
		h(
			View,
			{ style: s.metaRow },
			metaField("Club:", fill?.club),
			metaField("Date:", fill?.date),
			// The role-taker always writes their own name.
			metaField("Your name:"),
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

function timer(fill?: RoleSheetFill): ReactNode {
	return sheet(
		"Timer's log",
		"Time each speaker and signal green / amber / red at their windows.",
		[
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
						{ label: "Amber", flex: 1, color: C.amber },
						{ label: "Red (max)", flex: 1, color: C.red },
					],
					[
						["Ice Breaker", "4:00", "5:00", "6:00"],
						["Prepared speech", "5:00", "6:00", "7:00"],
						["Evaluation", "2:00", "2:30", "3:00"],
						["Table Topics", "1:00", "1:30", "2:00"],
					],
				),
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
					filledRows(fill?.speakers ?? [], 12, 4),
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
			h(
				View,
				{ key: "a" },
				table(
					[
						{ label: "Speaker", flex: 2 },
						{ label: "Um / Ah", flex: 1 },
						{ label: "So", flex: 1 },
						{ label: "Like", flex: 1 },
						{ label: "And / But", flex: 1 },
						{ label: "You know", flex: 1 },
						{ label: "Other", flex: 1 },
						{ label: "Total", flex: 1 },
					],
					filledRows(fill?.speakers ?? [], 12, 8),
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
			h(Text, { key: "a", style: s.sectionTitle }, "Meeting flow & timing"),
			h(View, { key: "a-lines" }, ...lines(3)),
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
			h(View, { key: "d-lines" }, ...lines(3)),
			h(Text, { key: "e", style: s.sectionTitle }, "Overall commendations"),
			h(View, { key: "e-lines" }, ...lines(3)),
			h(Text, { key: "f", style: s.sectionTitle }, "Overall recommendations"),
			h(View, { key: "f-lines" }, ...lines(3)),
		],
		fill,
	);
}

const BUILDERS: Record<RoleSheetKey, (fill?: RoleSheetFill) => ReactNode> = {
	timer,
	"ah-counter": ahCounter,
	grammarian,
	"ballot-counter": ballotCounter,
	"general-evaluator": generalEvaluator,
};

/**
 * Build the react-pdf `Document` for a role sheet. With `fill`, the header and
 * speaker rows are pre-filled; without it, the blank template is produced.
 */
export function buildRoleSheetDoc(
	key: RoleSheetKey,
	fill?: RoleSheetFill,
): ReactNode {
	return BUILDERS[key](fill);
}
