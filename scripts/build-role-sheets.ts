/**
 * Generates the blank, GavelUp-branded role sheets served from
 * `public/role-sheets/*.pdf` (#310). Original content — NO Toastmasters
 * International copyrighted material. Run manually and commit the output:
 *
 *   bun run build:role-sheets
 *
 * Mirrors the server minutes-PDF pattern (src/server/minutes-pdf-logic.ts):
 * `@react-pdf/renderer` with `React.createElement` (this is a `.ts` file, so no
 * JSX). Never imported by app code.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	Document,
	Page,
	renderToBuffer,
	StyleSheet,
	Text,
	View,
} from "@react-pdf/renderer";
import { createElement as h, type ReactNode } from "react";
import { TOASTMASTERS_DISCLAIMER } from "../src/lib/brand";

const C = { ink: "#1f2933", soft: "#52606d", line: "#b8c1cc", faint: "#eef1f4" };

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
	title: { fontSize: 20, fontFamily: "Helvetica-Bold", marginTop: 2 },
	subtitle: { fontSize: 10, color: C.soft, marginTop: 2 },
	metaRow: { flexDirection: "row", gap: 18, marginTop: 14 },
	metaField: {
		flexGrow: 1,
		flexBasis: 0,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
		paddingBottom: 2,
		fontSize: 9,
		color: C.soft,
	},
	sectionTitle: {
		fontSize: 12,
		fontFamily: "Helvetica-Bold",
		marginTop: 18,
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
		height: 22,
		marginTop: 8,
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

type Col = { label: string; flex: number };

/** A header row plus one row per entry in `rows` (empty strings = blank cells). */
function table(cols: Col[], rows: string[][]): ReactNode {
	const head = h(
		View,
		{ style: s.thRow },
		cols.map((c, i) =>
			h(Text, { key: i, style: [s.th, { flexGrow: c.flex, flexBasis: 0 }] }, c.label),
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
					h(Text, { style: s.tdText }, row[i] ?? ""),
				),
			),
		),
	);
	return h(View, {}, head, ...body);
}

/** `n` blank rows of `cols` empty cells. */
function blank(n: number, cols: number): string[][] {
	return Array.from({ length: n }, () => Array.from({ length: cols }, () => ""));
}

/** `n` ruled blank lines for free-text notes. */
function lines(n: number): ReactNode[] {
	return Array.from({ length: n }, (_, i) => h(View, { key: i, style: s.blankLine }));
}

function header(title: string, subtitle: string): ReactNode {
	return h(
		View,
		{},
		h(Text, { style: s.brand }, "GAVELUP"),
		h(Text, { style: s.title }, title),
		h(Text, { style: s.subtitle }, subtitle),
		h(
			View,
			{ style: s.metaRow },
			h(Text, { style: s.metaField }, "Club:"),
			h(Text, { style: s.metaField }, "Date:"),
			h(Text, { style: s.metaField }, "Your name:"),
		),
	);
}

function sheet(title: string, subtitle: string, body: ReactNode[]): ReactNode {
	return h(
		Document,
		{},
		h(
			Page,
			{ size: "LETTER", style: s.page },
			header(title, subtitle),
			...body,
			h(Text, { style: s.footer, fixed: true }, TOASTMASTERS_DISCLAIMER),
		),
	);
}

// ---- The five sheets -------------------------------------------------------

function timer(): ReactNode {
	return sheet("Timer's log", "Time each speaker and signal green / amber / red at their windows.", [
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
					{ label: "Green (min)", flex: 1 },
					{ label: "Amber", flex: 1 },
					{ label: "Red (max)", flex: 1 },
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
				blank(12, 4),
			),
		),
	]);
}

function ahCounter(): ReactNode {
	return sheet("Ah-Counter's log", "Tally filler words and crutch phrases; report totals at the end.", [
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
				blank(12, 8),
			),
		),
	]);
}

function grammarian(): ReactNode {
	return sheet("Grammarian's log", "Introduce the Word of the Day and note memorable language.", [
		h(Text, { key: "a", style: s.sectionTitle }, "Word of the Day"),
		h(
			View,
			{ key: "b", style: s.box },
			h(Text, {}, "Word:"),
			h(View, { style: s.blankLine }),
			h(Text, { style: { marginTop: 8 } }, "Meaning / part of speech:"),
			h(View, { style: s.blankLine }),
			h(Text, { style: { marginTop: 8 } }, "Used well by:"),
			h(View, { style: s.blankLine }),
		),
		h(Text, { key: "c", style: s.sectionTitle }, "Good use of language"),
		h(View, { key: "c-lines" }, ...lines(6)),
		h(Text, { key: "d", style: s.sectionTitle }, "Language to improve"),
		h(View, { key: "d-lines" }, ...lines(6)),
	]);
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
		h(
			View,
			{ key: `${title}-w`, style: s.metaRow },
			h(Text, { style: s.metaField }, "Winner:"),
		),
	];
}

function ballotCounter(): ReactNode {
	return sheet("Ballot / Vote Counter tally", "Collect and tally the votes for each award.", [
		...award("Best Speaker"),
		...award("Best Evaluator"),
		...award("Best Table Topics"),
	]);
}

function generalEvaluator(): ReactNode {
	return sheet("General Evaluator notes", "Evaluate the meeting as a whole and lead the evaluation team.", [
		h(Text, { key: "a", style: s.sectionTitle }, "Meeting flow & timing"),
		h(View, { key: "a-lines" }, ...lines(4)),
		h(Text, { key: "b", style: s.sectionTitle }, "Evaluators (evaluate the evaluators)"),
		h(View, { key: "b-lines" }, ...lines(4)),
		h(Text, { key: "c", style: s.sectionTitle }, "Language roles (Timer / Ah-Counter / Grammarian)"),
		h(View, { key: "c-lines" }, ...lines(3)),
		h(Text, { key: "d", style: s.sectionTitle }, "Environment & Sergeant at Arms"),
		h(View, { key: "d-lines" }, ...lines(3)),
		h(Text, { key: "e", style: s.sectionTitle }, "Overall commendations"),
		h(View, { key: "e-lines" }, ...lines(3)),
		h(Text, { key: "f", style: s.sectionTitle }, "Overall recommendations"),
		h(View, { key: "f-lines" }, ...lines(3)),
	]);
}

// ---- Emit ------------------------------------------------------------------

const OUT = resolve(process.cwd(), "public", "role-sheets");
mkdirSync(OUT, { recursive: true });

const sheets: Array<[string, () => ReactNode]> = [
	["timer.pdf", timer],
	["ah-counter.pdf", ahCounter],
	["grammarian.pdf", grammarian],
	["ballot-counter.pdf", ballotCounter],
	["general-evaluator.pdf", generalEvaluator],
];

for (const [file, build] of sheets) {
	const buf = await renderToBuffer(build() as Parameters<typeof renderToBuffer>[0]);
	writeFileSync(resolve(OUT, file), buf);
	console.log(`wrote public/role-sheets/${file}`);
}
