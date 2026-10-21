// src/components/agenda/meeting-agenda-print.tsx
//
// Faithful React port of the four designed layouts in
// templates/meeting-agenda/MeetingAgenda.dc.html (editorial + grid = one page,
// spacious + timing = two pages). Everything is data-driven from the meeting's
// slots, officers, and run-of-show. The club's district, mission, and
// meeting-schedule are optional free-text profile fields: each renders in its
// designated slot when set and is omitted gracefully (no empty label) when not.
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import {
	type RosterEntry,
	rosterGridPositions,
	VISITING_TOASTMASTER_LEGEND,
} from "#/lib/agenda";
import { groupByPresenter } from "#/lib/agenda-groups";
import type { AgendaLayout } from "#/lib/agenda-layouts";
import { paginate, unitsOf } from "#/lib/agenda-paginate";
import { RUN_NARRATIVE_TYPE } from "#/lib/agenda-print-type";
import { introducedSuffix } from "#/lib/agenda-runsheet";
import type { TimelineRow } from "#/lib/agenda-timing";
import { announcementLines } from "#/lib/announcement-lines";
import {
	firstQualifyingWindow,
	formatTimingClock,
	graceNote,
	graceSentence,
} from "#/lib/timing-window";
import { ClubLogo } from "./club-logo";
import {
	DarkFooter,
	FitPage,
	FOOTER_QR_CAPTION_LINES,
	FOOTER_QR_PX,
	FOREST,
	GREEN,
	HAIR,
	INK,
	Kick,
	LAGOON,
	MINT,
	MUTED,
	OPEN,
	PAGE_H,
	PAGE_W,
	RED,
	SANS,
	SEAFOAM,
	SERIF,
	TEAL,
	YELLOW,
} from "./print-theme";

// Defined once, with the list it is built from (#1069).
export type { AgendaLayout };

export type AgendaHeader = {
	clubName: string;
	logoUrl: string | null; // already versioned; null ⇒ render nothing
	clubNumber: string | null;
	district: string | null; // "District 39"
	mission: string | null; // free text, may be multi-line
	meetingSchedule: string | null; // "2nd & 4th Thursday, 6:45–7:45 PM"
	dateLong: string; // "Thursday, June 25, 2026"
	dateShort: string; // "Thu · Jun 25, 2026"
	timeRange: string; // "6:45 – 7:45 PM"
	theme: string | null;
	wordOfTheDay: string | null;
	location: string | null;
	announcements: string | null; // free-text, one per line; null/empty ⇒ hidden
	meetingNumber: number | null; // the club's own "Meeting #56"; null ⇒ hidden
};

/** "Club #NNN  ·  District 39  ·  Meeting #56" — every part optional; "" when
 *  all are unset. The club's own meeting number (#358) rides here so it lands on
 *  all four layouts from one place, exactly once each. */
function clubLine(h: AgendaHeader): string {
	return [
		h.clubNumber ? `Club #${h.clubNumber}` : null,
		h.district,
		h.meetingNumber != null ? `Meeting #${h.meetingNumber}` : null,
	]
		.filter(Boolean)
		.join("  ·  ");
}

/** One row of the "Meeting Roles" roster: `buildRosterEntries`' output, named
 *  for the print route that feeds it. Aliased rather than restated so a field
 *  added to one cannot go missing from the other. */
export type AgendaRoleEntry = RosterEntry;

/** A club officer for the officer grid. */
export type AgendaOfficer = { office: string; name: string };

/** A role + its plain-language responsibility blurb (timing page 1). */
export type AgendaExplainer = { role: string; description: string };

type Props = {
	layout: AgendaLayout;
	header: AgendaHeader;
	roles: AgendaRoleEntry[];
	officers: AgendaOfficer[];
	explainers: AgendaExplainer[];
	rows: TimelineRow[];
	// The absolute meeting-page URL the printed QR encodes (#913,
	// `meetingHubUrlFor` — `?room=1`, the in-room strip), or undefined before the
	// print route's client-side origin effect fires. It replaced #510's ballot
	// URL and, unlike it, is present whether or not the club votes on phones.
	// Threaded to every layout, including `GridLayout` — the default layout, so
	// the club that prints instead of projecting gets it too. Three layouts
	// put it in their shared `DarkFooter`; `GridLayout` has no `DarkFooter`
	// (see its own file-header note) and renders a smaller copy inline in its
	// hand-rolled officer footer instead.
	qrUrl?: string;
	/** Told when a one-sheet or Spacious sheet is too long to scale legibly and is
	 *  about to flow onto extra pages (#1225), once it has also been tried at
	 *  `compact` (#1226). Threaded to Editorial, Grid and both Spacious sheets.
	 *  Timing receives it only to climb to `compact`; at `compact` its sheets are
	 *  given `undefined`, never this callback, because Timing is the fallback: a
	 *  Timing sheet still too long at compact paginates onto continuation sheets
	 *  (#1227) instead of being told to the caller. */
	onWouldFlow?: () => void;
	/** The density the print starts at (#1226). Absent is `regular`, which is what
	 *  the route always wants: `MeetingAgendaPrint` climbs to `compact` itself, and
	 *  only when a sheet would otherwise flow. A seam for the tests, which need to
	 *  see each density without first building an agenda that overflows. */
	initialDensity?: PrintDensity;
};

/**
 * How tightly a layout packs its run of show (#1226).
 *
 * `regular` is the layout as it has always printed. `compact` is the same
 * layout with the same declared type sizes and every string intact, minus the
 * vertical whitespace: a lead beat's detail beside its title, a 0-minute
 * hand-off folded into the beat it introduces, halved row padding, and (on
 * Editorial) a full-width run of show. `MeetingAgendaPrint` moves from one to
 * the other only when a sheet reports it would flow, so an agenda that fits
 * prints exactly as before.
 */
export type PrintDensity = "regular" | "compact";

/** What each layout receives: the public props minus what the switch consumes,
 *  plus the density and the key that makes a sheet measure again at a new one. */
type LayoutProps = Omit<Props, "layout" | "explainers" | "initialDensity"> & {
	density: PrintDensity;
	/** `FitPage` measures once per mount (`print-theme.tsx`), so a new density,
	 *  or a new agenda, has to be a new mount. Suffixed per sheet by the layout:
	 *  two sheets of one layout may not share a key. */
	fitKey: string;
};

/** The (V) key (#1164) for a sheet, or undefined. Decided per SHEET from what
 *  that sheet actually renders: a two-sheet layout shows the roster on one and
 *  the run of show on the other, so each asks only about what it carries.
 *  Read from the `visiting` flag the roster entries and rows carry from their
 *  slots, never from the rendered text: a speech title, a note line or a
 *  member's own name can end in " (V)" without anyone being a visiting
 *  Toastmaster. */
function sheetLegend(shown: {
	roles?: readonly AgendaRoleEntry[];
	rows?: readonly TimelineRow[];
}): string | undefined {
	const shows =
		(shown.roles ?? []).some((r) => r.visiting) ||
		(shown.rows ?? []).some((r) => r.visiting);
	return shows ? VISITING_TOASTMASTER_LEGEND : undefined;
}

/** minutes (e.g. 6.5) → "6:30" for the timing marks. Shared with the grace
 *  window (#357) so a mark and its window always read in the same units. */
const mark = formatTimingClock;

/** The green·yellow·red timing marks for one beat, rendered inline and colored.
 *  Shared by the one-page layouts (editorial + grid) so their per-beat timing
 *  reads the same as the detailed timing table's Green·Yellow·Red column. Since
 *  #507 this renders on evaluator and Table Topics rows too, not only speakers. */
function TimingTrio({
	marks,
	size = 10,
}: {
	marks: NonNullable<TimelineRow["marks"]>;
	size?: number;
}) {
	return (
		<span style={{ whiteSpace: "nowrap" }}>
			<span style={{ fontSize: size, color: GREEN, fontWeight: 700 }}>
				{mark(marks.green)}
			</span>
			<span
				style={{
					fontSize: size,
					color: YELLOW,
					fontWeight: 700,
					marginLeft: 6,
				}}
			>
				{mark(marks.yellow)}
			</span>
			<span
				style={{ fontSize: size, color: RED, fontWeight: 700, marginLeft: 6 }}
			>
				{mark(marks.red)}
			</span>
		</span>
	);
}

/** The compact green/yellow/red key for the one-page layouts (the full "Timing
 *  Signals" callout only exists on the 2-page timing layout).
 *
 *  Second line (#357) states the 30-second grace period — the window the Timer
 *  actually judges by — in concrete clock values taken from the first timed
 *  beat on THIS agenda, so a club running 4–6 minute speeches reads its own
 *  numbers. Deliberately 8px and right-aligned: the one-pagers are one page by
 *  design, and `FitPage` scales the sheet down rather than spilling, so the key
 *  stays as small as it can while still teaching the rule. */
function TimingLegend({ rows }: { rows: TimelineRow[] }) {
	const dot = (color: string, label: string) => (
		<span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
			<span
				style={{
					width: 9,
					height: 9,
					borderRadius: "50%",
					background: color,
					flex: "none",
				}}
			/>
			<span style={{ fontSize: 9, color: MUTED, fontWeight: 600 }}>
				{label}
			</span>
		</span>
	);
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "flex-end",
				gap: 2,
			}}
		>
			<div style={{ display: "flex", gap: 14, alignItems: "center" }}>
				{dot(GREEN, "Min reached")}
				{dot(YELLOW, "Approaching")}
				{dot(RED, "Wrap up")}
			</div>
			<div
				style={{
					// 9.5px, not the 8px used elsewhere on this sheet: FitPage
					// scales the whole page, so 8px lands at ~5.25pt on the grid
					// layout and ~4.6pt on editorial — below every other piece of
					// CONTENT there, and lower still (≈4.2pt) on a denser agenda,
					// since the scale is recomputed per agenda. The other 8px uses
					// are short uppercase labels; this is 52 characters of running
					// prose that has to be readable to teach the rule at all.
					// Costs ~2px of height, which FitPage absorbs.
					fontSize: 9.5,
					color: MUTED,
					fontWeight: 600,
					textAlign: "right",
					lineHeight: 1.3,
				}}
			>
				{graceNote(firstQualifyingWindow(rows))}
			</div>
		</div>
	);
}

/**
 * The colored spine for a run-of-show beat, by the role that owns it.
 *
 * Keyed on the row's `roleKey` first (#445). The name match below it used to be
 * the whole implementation, and it worked only because `who` always carried OUR
 * canonical English — it now carries the club's own name, so a club that renamed
 * Speaker to Presenter would have silently lost every speech row's colour.
 *
 * The name match stays as the fallback for the ONE kind of row that carries no
 * key: an event beat, whose `who` is a hardcoded string in `buildRunOfShow`
 * (Sergeant-at-Arms, President) and so is not renameable at all. Every role row
 * carries a key — `roleKey: s.roleKey ?? owner.roleKey`, and the beat's own key is
 * non-nullable — including a club-invented role, which either fails `matchesRole`
 * and emits no row or matches by name and inherits the beat's key. Only the
 * `sergeant` and `president` branches below are reachable in production; the rest
 * are kept for callers that hand-build rows, which the tests do.
 */
const ROLE_KEY_COLOR: Record<string, string> = {
	table_topics_master: FOREST,
	general_evaluator: LAGOON,
	speaker: TEAL,
	evaluator: YELLOW,
	toastmaster_of_the_day: LAGOON,
	// Seeded Speech Contest template (#agenda-templates). Without these every
	// contest row takes the unmapped-key path and prints one undifferentiated
	// grey spine, losing the sheet's whole visual hierarchy on the night it
	// matters most. Contestant roles take TEAL so they read as the speaking
	// slots, matching `speaker`; the chair and judges take the leadership
	// lagoon; the functionaries stay muted.
	// FOLLOW-UP: a category fallback would serve every future template without
	// this list growing — it needs `category` on `AgendaRow`, which is a wider
	// change than Phase 1 needs. Recorded in TODOS.md.
	contest_chair: LAGOON,
	chief_judge: LAGOON,
	contestant_prepared: TEAL,
	judge: YELLOW,
	ballot_counter: MUTED,
	contest_timer: MUTED,
	sergeant_at_arms: MUTED,
};

type RoleIdentified = { who: string; roleKey?: string | null };

function beatColor(row: RoleIdentified): string {
	// The key is AUTHORITATIVE once present, even if it is unmapped. Falling
	// through to the name match for a keyed-but-unmapped row would read
	// club-typed free text: the first beat owned by a functionary would let a club
	// that renamed Grammarian to "Speaker Coach" pick up the speaker's teal from
	// `startsWith("speaker")` below, which is #445's regression in reverse. Also
	// keeps this the same shape as `isHighlighted`, which already branches on
	// presence alone.
	if (row.roleKey != null) return ROLE_KEY_COLOR[row.roleKey] ?? MUTED;
	const w = row.who.toLowerCase();
	if (w.startsWith("sergeant")) return MUTED;
	if (w.startsWith("president")) return INK;
	if (w.includes("table topics")) return FOREST;
	if (w.includes("general evaluator")) return LAGOON;
	if (w.startsWith("speaker")) return TEAL;
	if (w.startsWith("evaluator")) return YELLOW;
	if (w.includes("award") || w.startsWith("toastmaster")) return LAGOON;
	return MUTED;
}

/** A speaker beat gets the faint mint highlight in the narrative layouts. Keyed
 *  on the role, not its name, for the reason `beatColor` explains (#445). */
function isHighlighted(row: RoleIdentified): boolean {
	return row.roleKey != null
		? row.roleKey === "speaker"
		: row.who.toLowerCase().startsWith("speaker");
}

/** The "Meeting Roles" roster, either boxed (grid/timing) or plain (editorial/spacious). */
function RolesRoster({
	roles,
	variant,
}: {
	roles: AgendaRoleEntry[];
	variant: "boxed" | "plain" | "large";
}) {
	const boxed = variant === "boxed";
	const large = variant === "large";
	const labelSize = large ? 11 : boxed ? 9.5 : 9;
	const nameSize = large ? 14 : boxed ? 11.5 : 10.5;
	// An entry naming several people (#624 — an unordered role's collapsed
	// entry) spans both columns, so "which cell closes the box" and "which is
	// the right column" are computed rather than read off the index: `i % 2` is
	// not the column once a cell can span, and `i >= length - 2` is not the
	// bottom edge. `lastInColumn` reproduces the old rule exactly for a roster
	// with no wide entry, odd counts included — this must not restyle the
	// ordinary agenda every club prints.
	const positions = rosterGridPositions(roles);
	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "1fr 1fr",
				columnGap: large ? 34 : 12,
				...(boxed && {
					border: "1px solid rgba(23,58,64,.12)",
					borderRadius: 10,
					overflow: "hidden",
				}),
			}}
		>
			{roles.map((r, i) => {
				const pos = positions[i] ?? {
					row: 0,
					col: 0 as const,
					wide: false,
					lastInColumn: true,
				};
				return (
					<div
						// Index, not label: collapsing means two same-named role
						// DEFINITIONS both render the bare role name (`buildRosterEntries`
						// groups by definition, so that shape is supported), and the
						// numbering that used to make labels unique is exactly what is
						// gone. The roster is rebuilt wholesale on every render, so
						// there is no reordering for a stable key to protect.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above
						key={i}
						data-roster-entry=""
						// Present only on an entry spanning both columns; its value is
						// the holder count the width was granted for. A collapsed entry
						// with one holder sits in an ordinary cell and carries nothing.
						data-roster-wide={pos.wide ? r.holderCount : undefined}
						style={{
							display: "flex",
							justifyContent: "space-between",
							alignItems: large ? "baseline" : "center",
							padding: boxed ? "6px 14px" : large ? "9px 0" : "3px 0",
							borderBottom:
								boxed && pos.lastInColumn
									? undefined
									: "1px solid rgba(23,58,64,.09)",
							background: boxed && pos.col === 1 ? "#fafdfb" : undefined,
							gridColumn: pos.wide ? "1 / -1" : undefined,
						}}
					>
						<span
							style={{
								fontSize: labelSize,
								textTransform: "uppercase",
								letterSpacing: ".03em",
								color: MUTED,
								fontWeight: 700,
								whiteSpace: "nowrap",
							}}
						>
							{r.label}
						</span>
						{r.holders && r.holders.length > 1 ? (
							// Two to a row, not a sentence. Joined as prose, seven
							// contestants wrapped mid-list across the full sheet width and
							// read as a paragraph — an officer scanning for who is
							// competing had to parse it. Columns hug their content
							// (`max-content`) so the block still sits at the right edge
							// like every other name in this grid, capped by `minmax` so a
							// long name wraps inside its column instead of pushing the
							// label off the sheet.
							<div
								data-roster-holders={r.holders.length}
								style={{
									display: "grid",
									gridTemplateColumns:
										"minmax(0, max-content) minmax(0, max-content)",
									columnGap: large ? 34 : 24,
									rowGap: large ? 4 : 2,
									fontSize: nameSize,
									fontWeight: 600,
									paddingLeft: 16,
								}}
							>
								{r.holders.map((h) => (
									<span data-roster-holder key={h}>
										{h}
									</span>
								))}
							</div>
						) : r.name ? (
							<span
								style={{
									fontSize: nameSize,
									fontWeight: 600,
									// A list of several names wraps; keep the wrapped lines
									// ragged-left against the right edge like every other
									// name in the column, clear of the label.
									...(pos.wide && { textAlign: "right", paddingLeft: 16 }),
								}}
							>
								{r.name}
							</span>
						) : (
							<span
								style={{
									fontSize: nameSize - 1,
									fontWeight: 700,
									color: OPEN,
								}}
							>
								{boxed ? "○ Open" : "Open"}
							</span>
						)}
					</div>
				);
			})}
		</div>
	);
}

function OfficerGrid({
	officers,
	onDark,
}: {
	officers: AgendaOfficer[];
	onDark?: boolean;
}) {
	if (officers.length === 0) return null;
	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "repeat(4, 1fr)",
				gap: "9px 20px",
				...(!onDark && {
					border: "1px solid rgba(23,58,64,.12)",
					borderRadius: 10,
					padding: "12px 16px",
				}),
			}}
		>
			{officers.map((o) => (
				<div key={o.office + o.name}>
					<div
						style={{
							fontSize: 8,
							textTransform: "uppercase",
							letterSpacing: ".04em",
							color: onDark ? SEAFOAM : FOREST,
							fontWeight: 800,
						}}
					>
						{o.office}
					</div>
					<div
						style={{
							fontSize: 11.5,
							fontWeight: 600,
							marginTop: 1,
							color: onDark ? "#fff" : INK,
						}}
					>
						{o.name}
					</div>
				</div>
			))}
		</div>
	);
}

/** The hand-off elbow's leg length, in px. Fixed across the four layouts: it is
 *  a hairline affordance drawn at rule weight, not type that scales with them. */
const ELBOW = 5;

/** A 0-minute hand-off (#363), rendered as a thin band rather than a full
 *  segment block: `buildTimeline` gives it the clock time of the row it
 *  introduces, so an equally-weighted block reads as a duplicate of that row.
 *  The band drops the repeated stamp and is indented past its layout's time
 *  column, leaving the clock gutter a clean ruler down the page. `who · detail`
 *  on one line keeps the holder's name without needing the beat's copy to be
 *  recased.
 *
 *  `who`, the separator and `detail` are THREE nodes — no separator character is
 *  ever joined into a string. Both halves carry run-sheet copy that punctuates
 *  itself: `who` is `Role · Name`, and an enabled-but-unclaimed role makes that
 *  `Role · — open —`. Any literal join collides with one of those — the middot
 *  the rest of the sheet uses printed `Role · Name · Detail` (three peers, two
 *  identical separators), and the em dash that replaced it printed `Role · —
 *  open — — Introduces the speakers`. As its own node the separator gets the
 *  differentiation a character could not: reduced opacity, so the boundary reads
 *  lighter than the middot inside `who`. Every other row site differentiates it
 *  structurally too (narrative: `who` at 700 with `detail` on its own muted
 *  line; grid: bold `who` then smaller muted `detail`; timing: separate cells),
 *  so the band was the one place it read flat. The spaces around the separator
 *  are collapsed away in the flex line (`gap` does the spacing) and exist so the
 *  band's text stream still reads as a sentence when copied or spoken.
 *
 *  The leading elbow is drawn with BORDERS, not "↳" (U+21B3): Manrope is served
 *  over the Google Fonts css2 API with a unicode-range that excludes it
 *  (src/styles.css), so the glyph always fell through to ui-sans-serif — a
 *  different face, weight and baseline from every character beside it — and the
 *  band's `fontStyle: italic` then synthesised an oblique on top, so it printed
 *  visibly slanted and read as an artifact. In a PDF pipeline whose fallback
 *  chain lacks the glyph it degrades to tofu. An `ELBOW`-sized box with two
 *  borders is font-independent, and stays `aria-hidden`: the band's own text
 *  carries the meaning.
 *
 *  `fontSize`, `padding` and `chrome` come from the call site: the four layouts
 *  have different type scales, gutters and row rules, and a band that ignores
 *  them reads as a broken row rather than a quieter one. `chrome` is narrowed
 *  to exactly the two properties every call site actually passes — background
 *  and borderBottom — and spreads FIRST, so a call site can vary the layout's
 *  own chrome but can never override the semantics (color, italics, layout)
 *  this component owns. */
/**
 * A segment header on a TEMPLATED agenda ("PREPARED SPEECH CONTEST").
 *
 * Deliberately NOT `HandoffBand`. That renders an indented italic elbow (`└`)
 * meaning "X introduces Y" — it is a sub-row continuation marker, and a section
 * printed through it reads as a note attached to the row above rather than as
 * the head of a new segment. This is full-bleed, uppercase, ruled above, and
 * carries no clock stamp because a section consumes no time.
 */
function SectionBand({
	row,
	fontSize,
	padding,
}: {
	row: TimelineRow;
	fontSize: number;
	padding: string;
}) {
	return (
		<div
			style={{
				padding,
				marginTop: 6,
				borderTop: `1.5px solid ${INK}`,
				fontSize,
				fontWeight: 700,
				letterSpacing: ".08em",
				textTransform: "uppercase",
				color: INK,
			}}
		>
			{row.who}
		</div>
	);
}

function HandoffBand({
	row,
	fontSize,
	padding,
	chrome,
	nameTheGroup = false,
}: {
	row: TimelineRow;
	fontSize: number;
	padding: string;
	chrome?: Pick<React.CSSProperties, "background" | "borderBottom">;
	/**
	 * Print the group's members after the detail (#578) — "Introduces the
	 * speakers — Jagpal, Rehanna & Faisal".
	 *
	 * OFF by default, and the default is the decision. On a one-page layout the
	 * group's own rows are the next thing on the sheet in the boldest type the
	 * rhythm has, and #585 measured the names costing 5% of every word's size
	 * because `FitPage` scales the whole page to fit the longest line. The
	 * two-page layouts turn it on: their run of show can break between the
	 * hand-off and the people it introduces, which is the case a club actually
	 * reported, and their page 2 carries only the run of show so it has the room.
	 */
	nameTheGroup?: boolean;
}) {
	return (
		<div
			style={{
				...chrome,
				display: "flex",
				gap: 6,
				padding,
				fontSize,
				lineHeight: 1.35,
				color: MUTED,
				fontStyle: "italic",
			}}
		>
			{/* The elbow's foot sits ON the band's baseline, and the browser is what
			    puts it there: an inline-block with no in-flow content takes its
			    bottom margin edge as its baseline, so a `verticalAlign: "baseline"`
			    box aligns to the text baseline exactly, at every one of the four
			    call sites' sizes and in whatever face the PDF pipeline resolves. The
			    wrapper is the flex item and carries the band's own type so the line
			    box it establishes matches its neighbours'. (Computing the offset by
			    hand needs the face's real ascent and the sign of the half-leading —
			    it was off by ~0.5px at 10 and ~1px at 11.5, and no single constant
			    fixes both because Chrome rounds the ascent. `alignSelf: "baseline"`
			    on the bare box does not work either: with no text in it Chrome
			    synthesises the baseline from its top edge.) */}
			<span aria-hidden style={{ flex: "none", fontSize, lineHeight: 1.35 }}>
				<span
					style={{
						display: "inline-block",
						width: ELBOW,
						height: ELBOW,
						borderLeft: `1px solid ${MUTED}`,
						borderBottom: `1px solid ${MUTED}`,
						verticalAlign: "baseline",
					}}
				/>
			</span>
			<span>{row.who}</span>
			<span style={{ flex: "none", opacity: 0.55 }}>{" · "}</span>
			{/* One span, not two: the names are a continuation of the same sentence
			    ("Introduces the speakers — Jagpal & Rehanna"), so they must wrap and
			    break with it rather than as an independent flex item that can be
			    pushed onto its own line while the detail sits short. The separator is
			    `NAMES_SEPARATOR`, shared with the singular hand-offs' `{names:…}`
			    token so both read identically on the page. */}
			<span style={{ whiteSpace: "pre-line" }}>
				{row.detail}
				{nameTheGroup ? introducedSuffix(row.introduces ?? []) : ""}
			</span>
		</div>
	);
}

/** A hand-off that has been folded into the beat it introduces (#1226), as that
 *  beat's first line: the same italic muted `who · detail` as `HandoffBand`, with
 *  no elbow and no band padding, so it costs one text line and nothing else.
 *  `who`, the separator and `detail` stay three nodes for the reason the band
 *  gives. `data-row-handoff` is a test hook, the `data-row-time` convention. */
function FoldedHandoff({
	row,
	fontSize,
	padding,
	nameTheGroup = false,
	spine,
}: {
	row: TimelineRow;
	fontSize: number;
	padding: string;
	nameTheGroup?: boolean;
	/** The beat's spine colour, for a layout whose spine is on the cell and not
	 *  on the block the line sits in. */
	spine?: string;
}) {
	return (
		<div
			data-row-handoff=""
			style={{
				padding,
				...(spine ? { borderLeft: `4px solid ${spine}` } : {}),
				fontSize,
				lineHeight: 1.35,
				color: MUTED,
				fontStyle: "italic",
			}}
		>
			<span>{row.who}</span>
			<span style={{ opacity: 0.55 }}>{" · "}</span>
			<span style={{ whiteSpace: "pre-line" }}>
				{row.detail}
				{nameTheGroup ? introducedSuffix(row.introduces ?? []) : ""}
			</span>
		</div>
	);
}

/** One entry of a run of show as a layout prints it. */
type RowItem<T> = {
	/** The row or group, as it was before folding. */
	entry: T;
	/** Its index in the list it came from: the React key, never the stripe. */
	index: number;
	/** The hand-offs folded into this entry as its first lines, in order. */
	folded: TimelineRow[];
};

/**
 * The rows a layout prints at `density` (#1226).
 *
 * `regular` is every entry as it is, untouched. `compact` folds each run of
 * hand-offs into the NEXT entry, unless that entry is a section or there is none:
 * then they keep their own bands, because a hand-off introducing a section's
 * segment is not introducing a beat that can carry it. A hand-off is always an
 * entry of its own (`groupByPresenter` refuses it in both directions), which is
 * why one function serves both the flat rows of Grid and Timing and the groups of
 * the narrative.
 */
function foldHandoffs<T>(
	entries: readonly T[],
	rowOf: (entry: T) => TimelineRow,
	density: PrintDensity,
): RowItem<T>[] {
	if (density === "regular")
		return entries.map((entry, index) => ({ entry, index, folded: [] }));
	const out: RowItem<T>[] = [];
	let pending: { entry: T; index: number }[] = [];
	const flush = () => {
		for (const p of pending) out.push({ ...p, folded: [] });
		pending = [];
	};
	entries.forEach((entry, index) => {
		const row = rowOf(entry);
		if (row.handoff) {
			pending.push({ entry, index });
			return;
		}
		if (row.section) {
			flush();
			out.push({ entry, index, folded: [] });
			return;
		}
		out.push({ entry, index, folded: pending.map((p) => rowOf(p.entry)) });
		pending = [];
	});
	flush();
	return out;
}

/** A run-of-show row's box (#1226). At `regular` it is the one flex row it has
 *  always been, `rowStyle` and `chrome` on the same element in that order. At
 *  `compact` it is a block that carries the chrome (stripe, rule, highlight) and
 *  opens with the hand-offs folded into the beat, then the flex row of cells. */
function RowShell({
	compact,
	folded,
	foldedPadding,
	spine,
	nameTheGroup,
	chrome,
	rowStyle,
	children,
}: {
	compact: boolean;
	folded: TimelineRow[];
	foldedPadding: string;
	/** The spine colour, when the layout draws it on the cell (Grid). */
	spine?: string;
	nameTheGroup?: boolean;
	chrome: Pick<React.CSSProperties, "background" | "borderBottom">;
	rowStyle?: React.CSSProperties;
	children: React.ReactNode;
}) {
	if (!compact)
		return (
			<div style={{ display: "flex", ...rowStyle, ...chrome }}>{children}</div>
		);
	return (
		<div data-row-block="" style={chrome}>
			{folded.map((h, hi) => (
				<FoldedHandoff
					key={rowKey(h, hi)}
					row={h}
					fontSize={10}
					padding={foldedPadding}
					nameTheGroup={nameTheGroup}
					spine={spine}
				/>
			))}
			<div style={{ display: "flex", ...rowStyle }}>{children}</div>
		</div>
	);
}

/** A run-of-show row's React key, for all three places that render the rows.
 *  Position IS the identity: the list is rebuilt wholesale and never reordered,
 *  and no combination of fields is unique. `${time}-${who}` was, until #363 —
 *  a hand-off books 0 minutes, so it carries the stamp of the beat it
 *  introduces, and a club with a General Evaluator but no functionaries gets
 *  two Toastmaster hand-offs back to back, identical in both fields.
 *
 *  The index is deliberate, not an oversight, and lives here rather than in six
 *  `biome-ignore lint/suspicious/noArrayIndexKey` comments across the three
 *  render sites — same reasoning the ignores elsewhere in this repo carry, said
 *  once. Never call this on a list that reorders. */
function rowKey(r: TimelineRow, i: number): string {
	return `${i}-${r.time}-${r.who}`;
}

/** The timing signals that belong to ONE beat: the colored green·yellow·red
 *  trio, or the muted min–max range.
 *
 *  Split out of `RunNarrative` because a merged presenter block renders these
 *  in two different positions — beside the presenter's name for the beat that
 *  opens the block, and at the end of its own detail line for every beat after
 *  it. One copy, so the two positions cannot drift apart. */
function RowMarks({
	row,
	timingColors,
	size,
}: {
	row: TimelineRow;
	timingColors?: boolean;
	size: number;
}) {
	if (!row.marks) return null;
	if (timingColors)
		return (
			<span style={{ marginLeft: 8 }}>
				<TimingTrio marks={row.marks} size={size} />
			</span>
		);
	// A RANGE in this position reads as "this row lasts this long", which is only
	// true when the marks describe the row's own duration. On the squishy Table
	// Topics segment they describe ONE response (1:00–2:00) while the row is
	// booked for the whole segment (5–25 min after applyFlex), so the range would
	// label a 20-minute segment "1:00–2:00". The colour trio above is fine — it
	// reads as timer-card signals, not a duration — so only this branch opts out.
	if (row.flex) return null;
	return (
		<span style={{ fontWeight: 600, color: MUTED }}>
			{" · "}
			{mark(row.marks.green)}–{mark(row.marks.red)}
		</span>
	);
}

/**
 * Whether a row's holders are a LIST rather than a person.
 *
 * Two or more, never one: the break costs a line, and a line costs type size
 * on a sheet `FitPage` scales (#585). Absent `holders` — every section, event
 * and hand-off row, and every row built before the field existed — reads as
 * false, so the layout is unchanged for everything but the case that needs it.
 */
function multiHolder(row: TimelineRow): boolean {
	return (row.holders?.length ?? 0) > 1;
}

/** The narrative run-of-show (editorial / spacious): a colored-spine list.
 *  `timingColors` swaps the muted min–max range for the colored green·yellow·red
 *  trio (used by the one-page editorial layout).
 *
 *  Adjacent beats with the same presenter print as ONE block — the name once, a
 *  line per beat, every clock stamp intact (`groupByPresenter`). The real MCF
 *  agenda closes with three President beats and runs four consecutive General
 *  Evaluator ones, so this is not a rare shape; printing the name on its own
 *  line five extra times cost ~186px of a 1056px sheet, and because `FitPage`
 *  scales this layout to fit, that height came straight off the type size —
 *  editorial printed at 0.81 scale, around 6.4pt body. Height IS font size here.
 *  Which is also the warning: anything added to this renderer is paid for in
 *  legibility, not in a scrollbar. */
function RunNarrative({
	rows,
	scale,
	timingColors,
	nameTheGroup,
	density = "regular",
}: {
	rows: TimelineRow[];
	scale: "sm" | "lg";
	timingColors?: boolean;
	/** `compact` (#1226): see `PrintDensity`. Declared type sizes are the same. */
	density?: PrintDensity;
	/**
	 * Print group hand-offs' members (#578) — see `HandoffBand`.
	 *
	 * A separate prop rather than reading `scale === "lg"`, even though `lg` is
	 * only ever the two-page spacious layout today. `scale` means type size and
	 * this means "the group's rows may be on another sheet"; they coincide by
	 * accident, and the day a one-page layout wants big type it would silently
	 * inherit a 5% shrink of every word on it (#585).
	 */
	nameTheGroup?: boolean;
}) {
	const lg = scale === "lg";
	const compact = density === "compact";
	const groups = groupByPresenter(rows);
	const items = foldHandoffs(groups, (g) => g.rows[0], density);
	// Sizes live in `lib/` because on this surface they are only half the story —
	// `FitPage` scales the sheet, so what prints is these times PAGE_H/height, and
	// `print-density.test.tsx` needs both in one assertion to gate the real thing.
	const type = RUN_NARRATIVE_TYPE[lg ? "lg" : "sm"];
	// One shared stamp column. Every beat gets a cell of exactly this width —
	// the leader's own detail line gets an EMPTY one — so the stamps stay the
	// single unbroken left column the hand-off band's left padding is cut to.
	const stampWidth = lg ? 64 : 54;
	const stamp = {
		flex: "none" as const,
		width: stampWidth,
		fontSize: type.stamp,
		fontWeight: lg ? 800 : 700,
		color: INK,
	};
	const detail = {
		flex: 1,
		fontSize: type.detail,
		color: MUTED,
		// 1.3 on editorial: every detail line is paid for in type size there.
		lineHeight: lg ? 1.4 : 1.3,
		// A note's own line breaks (the editor's Note is multi-line).
		whiteSpace: "pre-line" as const,
	};
	return (
		<div>
			{items.map(({ entry: g, index: gi, folded }, k) => {
				const lead = g.rows[0];
				// A hand-off is always alone in its group (`sameRun` refuses it in both
				// directions), so this branch renders the whole group.
				//
				// No spine and no bottom rule: the hand-off sits under the hairline of
				// the beat that hands over and runs straight into the beat it
				// introduces, which is the grouping the room actually experiences.
				// Indented past the 4px spine and the stamp column so the stamps stay a
				// single unbroken column.
				// Sections first: a section is never a presenter, so it must not fall
				// through to the spine-coloured presenter row below.
				if (lead.section)
					return (
						<SectionBand
							key={rowKey(lead, gi)}
							row={lead}
							fontSize={lg ? 11 : 9.5}
							padding={
								compact
									? lg
										? "3px 0 2px 0"
										: "2.5px 0 1.5px 0"
									: lg
										? "6px 0 4px 0"
										: "5px 0 3px 0"
							}
						/>
					);
				if (lead.handoff)
					return (
						<HandoffBand
							key={rowKey(lead, gi)}
							row={lead}
							fontSize={lg ? 11.5 : 10}
							padding={lg ? "4px 0 4px 83px" : "1px 0 1px 69px"}
							nameTheGroup={nameTheGroup}
						/>
					);
				return (
					<div
						key={rowKey(lead, gi)}
						{...(compact ? { "data-row-block": "" } : {})}
						style={{
							borderLeft: `4px solid ${beatColor(g)}`,
							background: isHighlighted(g) ? MINT : undefined,
							padding: compact
								? lg
									? "4px 0 4px 15px"
									: "1px 0 1px 11px"
								: lg
									? "11px 0 11px 15px"
									: "3px 0 3px 11px",
							borderBottom: k < items.length - 1 ? HAIR : undefined,
						}}
					>
						{/* A hand-off folded into this beat (#1226): its first lines, in
						    order, past the stamp column so the stamps stay one column. */}
						{folded.map((h, hi) => (
							<FoldedHandoff
								key={rowKey(h, hi)}
								row={h}
								fontSize={lg ? 11.5 : 10}
								padding={lg ? "0 0 2px 64px" : "0 0 1px 54px"}
								nameTheGroup={nameTheGroup}
							/>
						))}
						<div style={{ display: "flex" }}>
							{/* Test hook only — nothing renders off it. It marks the clock-stamp
							    cells so the suite can assert "a hand-off repeats no clock stamp"
							    (#363) by collecting every stamp on the page: a `HandoffBand` has
							    no such cell, so a band that started printing one would show up
							    as an extra entry. Matching the stamps as text instead would pass
							    on a band that echoed the row below it. All three row-rendering
							    sites carry it; keep them in sync.

							    Since consolidation there is one of these per BEAT, not per
							    printed name — the continuation lines below carry their own. That
							    is the invariant `meeting-agenda-print.test.tsx` pins: stamps on
							    the page == non-hand-off rows in the timeline. */}
							<div data-row-time={lead.time} style={stamp}>
								{lead.time}
							</div>
							<div
								style={{
									flex: 1,
									fontSize: type.name,
									fontWeight: 700,
								}}
							>
								{/* A list of SEVERAL holders gets its own line; one stays
								    inline. `who` is `Role · Name`, so a four-name list ran
								    the timing marks off behind the last surname and wrapped
								    them — and the marks are the one thing the Timer scans
								    this column for. The names come off `holders` (#578's
								    reasoning: data, not prose), because the count is what
								    decides, and it is not recoverable from the joined
								    string: a club's role names and the guest marker both
								    contain the separators a parser would key on (#463).

								    Only a list earns the break. One extra line on EVERY row
								    is paid for in type size, since `FitPage` scales the
								    whole sheet — #585 measured that trade at 6.470pt against
								    6.799pt and rejected it. A contest sheet gains one line;
								    an ordinary agenda gains none. */}
								{/* `data-row-title` / `data-row-holders` are test hooks, the
								    same convention as `data-row-time` above — nothing renders
								    off them. They let the suite assert WHICH line the marks
								    landed on, which is the whole content of this fix and is
								    invisible to a text-only query. */}
								<div data-row-title>
									{multiHolder(lead) ? (lead.roleLabel ?? g.who) : g.who}
									<RowMarks
										row={lead}
										timingColors={timingColors}
										size={lg ? 11 : 10}
									/>
									{/* Compact (#1226): the lead's detail rides the title's line,
									    after the marks, instead of a line of its own. A list of
									    holders keeps the long form: title, the holders, then the
									    detail beneath, because the names are what this row is for.
									    The detail's own size and weight, not the title's. */}
									{compact && !multiHolder(lead) && lead.detail ? (
										<span
											style={{
												fontSize: type.detail,
												fontWeight: 400,
												color: MUTED,
												whiteSpace: "pre-line",
											}}
										>
											{" · "}
											{lead.detail}
										</span>
									) : null}
								</div>
								{multiHolder(lead) ? (
									// Two to a row, matching the roles grid above: joined as
									// prose the same list wrapped mid-sentence and read as a
									// paragraph rather than a cast list, and this is the row a
									// Timer scans to see who is up.
									<div
										data-row-holders
										style={{
											display: "grid",
											gridTemplateColumns:
												"minmax(0, max-content) minmax(0, max-content)",
											columnGap: lg ? 28 : 20,
											rowGap: 1,
											fontWeight: 600,
											color: MUTED,
										}}
									>
										{(lead.holders ?? []).map((h) => (
											<span data-row-holder key={h}>
												{h}
											</span>
										))}
									</div>
								) : null}
							</div>
						</div>
						{compact && !multiHolder(lead) ? null : (
							<div style={{ display: "flex", marginTop: 1 }}>
								<div style={{ flex: "none", width: stampWidth }} />
								<div style={detail}>{lead.detail}</div>
							</div>
						)}
						{g.rows.slice(1).map((r, i) => (
							<div
								key={rowKey(r, i)}
								style={{
									display: "flex",
									marginTop: compact ? (lg ? 2 : 1) : lg ? 4 : 3,
								}}
							>
								<div data-row-time={r.time} style={stamp}>
									{r.time}
								</div>
								<div style={detail}>
									{r.detail}
									<RowMarks
										row={r}
										timingColors={timingColors}
										size={lg ? 11 : 10}
									/>
								</div>
							</div>
						))}
					</div>
				);
			})}
		</div>
	);
}

function HeaderBand({ header }: { header: AgendaHeader }) {
	const meta = [clubLine(header), header.dateLong]
		.filter(Boolean)
		.join("  ·  ");
	return (
		<div
			style={{
				background: `linear-gradient(125deg, ${LAGOON}, ${INK})`,
				color: "#fff",
				padding: "16px 38px",
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 18 }}>
				<ClubLogo logoUrl={header.logoUrl} />
				<div style={{ flex: 1, minWidth: 0 }}>
					<div
						style={{
							font: `600 24px ${SERIF}`,
							lineHeight: 1.05,
							letterSpacing: "-.01em",
						}}
					>
						{header.clubName}
					</div>
					<div
						style={{
							fontSize: 11,
							color: "rgba(255,255,255,.82)",
							marginTop: 3,
							letterSpacing: ".02em",
						}}
					>
						{meta}
					</div>
				</div>
				<div
					style={{ flex: "none", textAlign: "right", display: "flex", gap: 24 }}
				>
					{header.theme ? (
						<div style={{ whiteSpace: "nowrap" }}>
							<div
								style={{
									fontSize: 8.5,
									letterSpacing: ".1em",
									textTransform: "uppercase",
									color: SEAFOAM,
									fontWeight: 800,
								}}
							>
								Theme
							</div>
							<div style={{ font: `600 15px ${SERIF}`, marginTop: 2 }}>
								{header.theme}
							</div>
						</div>
					) : null}
					{header.wordOfTheDay ? (
						<div style={{ whiteSpace: "nowrap" }}>
							<div
								style={{
									fontSize: 8.5,
									letterSpacing: ".1em",
									textTransform: "uppercase",
									color: SEAFOAM,
									fontWeight: 800,
								}}
							>
								Word of the Day
							</div>
							<div style={{ font: `600 15px ${SERIF}`, marginTop: 2 }}>
								{header.wordOfTheDay}
							</div>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// EDITORIAL — one page
// ---------------------------------------------------------------------------
function EditorialLayout({
	header,
	roles,
	officers,
	rows,
	qrUrl,
	onWouldFlow,
	density,
	fitKey,
}: LayoutProps) {
	const compact = density === "compact";
	// The run of show, in the right column at `regular` and full-width below the
	// top at `compact` (#1226): at 506px it wraps, and the left column under the
	// officers is blank for the rest of the sheet.
	const runOfShow = (
		<>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "baseline",
					margin: "10px 0 6px",
				}}
			>
				<Kick>Run of Show</Kick>
				<TimingLegend rows={rows} />
			</div>
			<RunNarrative rows={rows} scale="sm" timingColors density={density} />
		</>
	);
	return (
		<FitPage key={fitKey} onWouldFlow={onWouldFlow}>
			<HeaderBand header={header} />
			{/* date strip */}
			<div
				style={{
					background: "#e7f0e8",
					padding: "7px 38px",
					display: "flex",
					justifyContent: "space-between",
					fontSize: 10.5,
					color: INK,
					fontWeight: 600,
				}}
			>
				<span>
					{header.dateLong}
					{"  ·  "}
					{header.timeRange}
				</span>
				{header.location ? (
					<span style={{ color: MUTED, fontWeight: 500 }}>
						{header.location}
					</span>
				) : null}
			</div>

			<div
				style={{
					display: "flex",
					gap: 22,
					padding: "14px 38px 0",
					flex: compact ? "none" : 1,
				}}
			>
				{/* left rail — officers + venue */}
				<div style={{ flex: "none", width: 212 }}>
					{officers.length > 0 ? (
						<>
							<Kick style={{ marginBottom: 6 }}>Club Officers</Kick>
							<div style={{ display: "flex", flexDirection: "column" }}>
								{officers.map((o, i) => (
									<div
										key={o.office + o.name}
										style={{
											display: "flex",
											justifyContent: "space-between",
											padding: "4.5px 0",
											borderBottom:
												i < officers.length - 1
													? "1px solid rgba(23,58,64,.08)"
													: undefined,
										}}
									>
										<span
											style={{
												fontSize: 9,
												textTransform: "uppercase",
												letterSpacing: ".03em",
												color: MUTED,
												fontWeight: 600,
												whiteSpace: "nowrap",
											}}
										>
											{o.office}
										</span>
										<span style={{ fontSize: 10.5, fontWeight: 600 }}>
											{o.name}
										</span>
									</div>
								))}
							</div>
						</>
					) : null}
					{header.meetingSchedule || header.location ? (
						<div
							style={{
								background: MINT,
								border: "1px solid rgba(23,58,64,.1)",
								borderRadius: 10,
								padding: "11px 13px",
								marginTop: 14,
							}}
						>
							{header.meetingSchedule ? (
								<>
									<Kick style={{ marginBottom: 3 }}>Meets</Kick>
									<div
										style={{
											fontSize: 10.5,
											fontWeight: 600,
											lineHeight: 1.35,
											color: INK,
											whiteSpace: "pre-line",
										}}
									>
										{header.meetingSchedule}
									</div>
								</>
							) : null}
							{header.location ? (
								<>
									<Kick
										style={{
											marginBottom: 3,
											...(header.meetingSchedule && { marginTop: 9 }),
										}}
									>
										Location
									</Kick>
									<div style={{ fontSize: 10.5, lineHeight: 1.35, color: INK }}>
										{header.location}
									</div>
								</>
							) : null}
						</div>
					) : null}
					{header.mission ? (
						<>
							<Kick style={{ margin: "14px 0 4px" }}>Club Mission</Kick>
							<div
								style={{
									fontSize: 9.5,
									lineHeight: 1.45,
									color: MUTED,
									whiteSpace: "pre-line",
								}}
							>
								{header.mission}
							</div>
						</>
					) : null}
					<AnnouncementsBlock
						text={header.announcements}
						style={{ marginTop: 14 }}
					/>
				</div>

				{/* main — roles + run of show */}
				<div style={{ flex: 1, minWidth: 0 }}>
					<Kick style={{ marginBottom: 6 }}>Meeting Roles</Kick>
					<div style={{ marginBottom: 4 }}>
						<RolesRoster roles={roles} variant="plain" />
					</div>
					{compact ? null : runOfShow}
				</div>
			</div>
			{compact ? (
				<div style={{ padding: "0 38px", flex: 1 }}>{runOfShow}</div>
			) : null}

			<DarkFooter
				left="Guests are always welcome — speak to any officer about getting involved."
				right="toastmasters.org"
				qrUrl={qrUrl}
				legend={sheetLegend({ roles, rows })}
			/>
		</FitPage>
	);
}

// ---------------------------------------------------------------------------
// GRID — one page
//
// NO HEADROOM LEFT. Measured on a 23-row MCF agenda (#363): 1108px of content
// against a 1056px page, so `FitPage` scales this layout to ~0.951. It fitted
// exactly at 1019px before the hand-off rows; rendering those as full rows
// instead of `HandoffBand`s would cost 1174px, so the band already absorbs
// half the overrun and no legible band closes the rest.
//
// The 5% scale is accepted — nothing clips and body text lands around 7.5pt —
// but grid is the DEFAULT print layout and every further addition compounds
// into a deeper shrink. Anything added here should arrive with a compensating
// reduction. The cheap inventory, when it is needed: ~16px across the three
// section gaps and the footer margin, plus ~10px from halving the band's
// padding. Past that it means re-tuning the row rhythm.
//
// ALL FOUR LAYOUTS, measured in Chromium after webfonts settled, on the same
// 23-row MCF agenda — grid came out at 1114px here against the 1108px above, so
// these are the same sheet. Each figure is for the RUN-OF-SHOW page (page 2 on
// the two-page layouts); `band` is what the hand-off band's italic actually
// lands at once FitPage has scaled the page:
//
//   timing     1056px  scale 1.000  band 7.50pt
//   grid       1114px  scale 0.946  band 7.10pt
//   editorial  1299px  scale 0.811  band 6.09pt
//   spacious   1500px  scale 0.703  band 6.06pt
//
// Editorial, not grid, is the tight one: it carries header, roles roster,
// officers, meets/location, mission, announcements AND the run of show on one
// FitPage. Two things follow. (1) Its height is set ENTIRELY by the main
// column — 1198px of roster + run of show against a 394px left rail — so
// trimming the rail (mission/announcements gaps) buys nothing; only the 18px
// above Run of Show is in the tall column, and cutting it all is worth +0.07pt.
// (2) The band is NOT the outlier there the way it was on grid: editorial's own
// `detail` is 10.5px, so at 0.811 it prints 5.95pt against the band's 6.09pt.
// Everything on that page is small together, which is a row-rhythm question for
// editorial rather than anything the band introduced.
//
// A denser but ordinary agenda (3 speakers/3 evaluators, 25 rows) pushes
// editorial to 1394px/0.756 and spacious to 1620px/0.651 — band 5.67pt and
// 5.61pt. Neither has headroom for another full-height row either.
//
// THE BALLOT QR (#510) is the addition this comment warned about, and it paid
// for itself out of the inventory above rather than compounding the shrink.
// Measured with real headless Chrome against the print-page-count fixture
// (`--dump-dom` reading the FitPage inner div's `scrollHeight`, since
// `renderToStaticMarkup` never runs FitPage's own measuring `useEffect`):
// the 32px QR inline in the officer-footer row costs +19px (that row was
// ~13px of text before it), and trimming the three section gaps and the
// footer margin 4px apiece — exactly the ~16px this comment already
// earmarked — brings the net cost to +3px over the whole sheet. `FitPage`
// absorbs 3px silently; the printed page count does not move (verified via
// `print-page-count.test.tsx`, both before and after).
//
// PRESENTER CONSOLIDATION (#562) is the first entry here that BUYS height back,
// and it is where "a row-rhythm question for editorial" above got answered. The
// narrative layouts gave every beat its own name line, so MCF's real agenda —
// a four-beat General Evaluator run and a three-beat President close — printed
// "General Evaluator · Faisal Ali" four times down one page. Merging adjacent
// beats by the same presenter drops the repeated line and keeps every clock
// stamp (`groupByPresenter`). Measured on the real 2026-08-13 agenda, now a
// checked-in fixture in `print-density.test.tsx`:
//
//   editorial  1484px  scale 0.710  detail 5.59pt   ← before
//   editorial  1304px  scale 0.808  detail 6.36pt   ← consolidated
//   editorial  1321px  scale 0.798  detail 6.88pt   ← + declared 10.5 → 11.5
//
// (Not comparable to the table above: that one was measured against the
// deployed site with Fraunces and Manrope loaded, this one through the offline
// harness on fallback fonts. Comparable to each other, which is the point.)
//
// Two things worth carrying forward. The declared bump is nearly self-
// cancelling — 9.5% more type bought 3.7% more printed type, because a taller
// sheet is scaled down further — so HEIGHT, not font-size, is the lever on this
// surface, and `agenda-print-type.ts` holds the numbers where a test can reach
// them. And the left rail measures 669px against the main column's 1304px: some
// 635px of the sheet is empty beside the run of show. Moving the roster into
// that rail, or flowing the run of show into it, is the next real gain
// available here and the one thing that would let the type grow properly. It is
// a redesign of the layout rather than a tuning of it, which is why #562 stopped
// short of it.
// ---------------------------------------------------------------------------
function GridLayout({
	header,
	roles,
	officers,
	rows,
	qrUrl,
	onWouldFlow,
	density,
	fitKey,
}: LayoutProps) {
	const legend = sheetLegend({ roles, rows });
	const compact = density === "compact";
	const gridItems = foldHandoffs(rows, (r) => r, density);
	return (
		<FitPage key={fitKey} onWouldFlow={onWouldFlow}>
			{/* header */}
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 16,
					padding: "20px 36px 18px",
					borderBottom: `3px solid ${TEAL}`,
				}}
			>
				<ClubLogo logoUrl={header.logoUrl} />
				<div style={{ flex: 1, minWidth: 0 }}>
					<div
						style={{
							font: `600 23px ${SERIF}`,
							lineHeight: 1.05,
							letterSpacing: "-.01em",
							color: INK,
						}}
					>
						{header.clubName}
					</div>
					{clubLine(header) ? (
						<div
							style={{
								fontSize: 10.5,
								color: MUTED,
								marginTop: 3,
								fontWeight: 600,
							}}
						>
							{clubLine(header)}
						</div>
					) : null}
				</div>
				<div style={{ flex: "none", display: "flex", gap: 7 }}>
					<Pill dark>{header.dateShort}</Pill>
					<Pill>{header.timeRange}</Pill>
				</div>
			</div>

			<div
				style={{
					padding: "14px 36px 0",
					flex: 1,
					display: "flex",
					flexDirection: "column",
				}}
			>
				{(header.theme || header.wordOfTheDay) && (
					// marginBottom trimmed 13 → 9 (#510): one of the three section gaps
					// this file's own header earmarks to pay for the footer QR below.
					<div style={{ display: "flex", gap: 12, marginBottom: 9 }}>
						{header.theme ? (
							<ThemeCard
								label="Meeting Theme"
								value={header.theme}
								color={TEAL}
							/>
						) : null}
						{header.wordOfTheDay ? (
							<ThemeCard
								label="Word of the Day"
								value={header.wordOfTheDay}
								color={FOREST}
							/>
						) : null}
					</div>
				)}

				<Kick style={{ marginBottom: 6 }}>Meeting Roles</Kick>
				{/* marginBottom trimmed 14 → 10 (#510) — same inventory as above. */}
				<div style={{ marginBottom: 10 }}>
					<RolesRoster roles={roles} variant="boxed" />
				</div>

				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "baseline",
						marginBottom: 6,
					}}
				>
					<Kick>Run of Show</Kick>
					<TimingLegend rows={rows} />
				</div>
				<div
					style={{
						border: "1px solid rgba(23,58,64,.12)",
						borderRadius: 10,
						overflow: "hidden",
					}}
				>
					{gridItems.map(({ entry: r, index: i, folded }, k) =>
						// This layout's language is a ruled, zebra-striped table, so the
						// band keeps the stripe and the rule and goes quiet instead:
						// no spine, no stamp, italic type, half the row padding.
						// Indented to 68px, where the segment column starts.
						//
						// 10px, matching this layout's `detail` (the `who` beside it is
						// 10.5) rather than dropping under it: at FitPage's ~0.951 the
						// band was the smallest sustained prose on the sheet (~6.8pt),
						// and it is running italic, which is the hardest thing on the
						// page to read. Same argument `TimingLegend` makes above. The
						// ~0.7px per band it costs comes out of the headroom inventory
						// the header comment enumerates.
						r.section ? (
							// A templated agenda's segment header. Without this arm it
							// prints as an ordinary zebra row WITH a clock stamp, which
							// reads as a beat someone presents.
							<SectionBand
								key={rowKey(r, i)}
								row={r}
								fontSize={10}
								padding={compact ? "3px 10px 2px 10px" : "6px 10px 4px 10px"}
							/>
						) : r.handoff ? (
							<HandoffBand
								key={rowKey(r, i)}
								row={r}
								fontSize={10}
								padding="2px 12px 2px 68px"
								chrome={{
									background: k % 2 === 1 ? "#fafdfb" : "#fff",
									borderBottom: k < gridItems.length - 1 ? HAIR : undefined,
								}}
							/>
						) : (
							<RowShell
								key={rowKey(r, i)}
								compact={compact}
								folded={folded}
								foldedPadding="1px 12px 0 64px"
								spine={beatColor(r)}
								chrome={{
									background: isHighlighted(r)
										? MINT
										: k % 2 === 1
											? "#fafdfb"
											: "#fff",
									borderBottom: k < gridItems.length - 1 ? HAIR : undefined,
								}}
							>
								{/* Test hook — see `RunNarrative`'s note on `data-row-time`. */}
								<div
									data-row-time={r.time}
									style={{
										flex: "none",
										width: 60,
										borderLeft: `4px solid ${beatColor(r)}`,
										padding: compact ? "2px 0 2px 10px" : "4px 0 4px 10px",
										fontSize: 10.5,
										fontWeight: 700,
										color: INK,
									}}
								>
									{r.time}
								</div>
								<div
									style={{
										flex: 1,
										padding: compact ? "2px 12px 2px 8px" : "4px 12px 4px 8px",
										// The line box of this cell is sized by the cell's OWN
										// font, which is the page's 16px: the two spans inside
										// declare 10.5 and 10 but cannot shrink the strut, so a
										// one-line row stood 22px tall for 13px of text. Compact
										// gives the cell the size of the text it holds. No
										// declared size changes.
										...(compact && { fontSize: 10.5, lineHeight: 1.3 }),
									}}
								>
									<span style={{ fontSize: 10.5, fontWeight: 700 }}>
										{r.who}.
									</span>{" "}
									<span
										style={{
											fontSize: 10,
											color: MUTED,
											whiteSpace: "pre-line",
										}}
									>
										{r.detail}
									</span>
								</div>
								{r.marks ? (
									<div
										style={{
											flex: "none",
											display: "flex",
											alignItems: "center",
											padding: compact ? "2px 12px 2px 0" : "4px 12px 4px 0",
										}}
									>
										<TimingTrio marks={r.marks} size={9.5} />
									</div>
								) : null}
							</RowShell>
						),
					)}
				</div>

				{/* marginTop trimmed 14 → 10 (#510) — same inventory as above. */}
				<AnnouncementsBlock
					text={header.announcements}
					style={{ marginTop: 10 }}
				/>

				{/* officer footer (also carries the club's meets schedule + mission) */}
				{officers.length > 0 ||
				header.meetingSchedule ||
				header.mission ||
				legend ||
				qrUrl ? (
					<div
						data-print-footer=""
						style={{
							marginTop: "auto",
							background: INK,
							// Top margin trimmed 14 → 10 (#510) — the fourth and last piece
							// of the inventory this file's header earmarks: three section
							// gaps above plus this footer margin, ~16px total, spent to pay
							// for the ~19px a 32px QR cost the row just below. #717 raised
							// that code to `FOOTER_QR_PX` and paid the extra 24px out of
							// this layout's remaining slack rather than out of the
							// inventory, which is already spent — see the QR's own note.
							margin: "10px -36px 0",
							padding: "13px 36px 16px",
							color: "#fff",
						}}
					>
						{officers.length > 0 ||
						header.meetingSchedule ||
						legend ||
						qrUrl ? (
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									// `center`, not the original `baseline`: this row can now
									// carry a `FOOTER_QR_PX` square beside its text, and
									// centering the two is the shape that reads right —
									// baseline would sit the square against the text's
									// cap-height instead.
									alignItems: "center",
									gap: 16,
									marginBottom: officers.length > 0 ? 8 : 0,
								}}
							>
								{officers.length > 0 ? (
									<span
										style={{
											textTransform: "uppercase",
											letterSpacing: ".09em",
											fontSize: 9,
											fontWeight: 800,
											color: SEAFOAM,
										}}
									>
										Club Officers
									</span>
								) : (
									<span />
								)}
								<span
									style={{
										display: "inline-flex",
										alignItems: "center",
										gap: 8,
									}}
								>
									{/* The (V) key (#1164), before "Meets" in the same type, so
									    it rides this row rather than adding one to a sheet that
									    has no headroom. */}
									{legend ? (
										<span
											data-visiting-legend=""
											style={{
												fontSize: 9.5,
												color: "rgba(255,255,255,.7)",
												textAlign: "right",
											}}
										>
											{legend}
											{header.meetingSchedule ? " ·" : ""}
										</span>
									) : null}
									{header.meetingSchedule ? (
										<span
											style={{
												fontSize: 9.5,
												color: "rgba(255,255,255,.7)",
												textAlign: "right",
											}}
										>
											Meets {header.meetingSchedule}
										</span>
									) : null}
									{qrUrl ? (
										// Grid has no headroom (see the file-header note above),
										// so this is the tightest copy of the QR rather than
										// `DarkFooter`'s: one caption line, not three, and 5px
										// of gap instead of 7 — every point here was taken out
										// of the layout's own inventory, not left on the table.
										//
										// The SIZE is shared, though (#717): a second literal is
										// how the two drifted, and this footer can afford the
										// same edge. Measured on the real MCF agenda, a 56px code
										// here puts the sheet at 1430px against the 1464px where
										// `FitPage` would flow it onto a second page — 34px of
										// slack, about two wrapped lines of the cross-platform
										// variance `agenda-print-type.ts` describes. That is the
										// number `ballot-qr-print-fit.test.tsx` holds; raising
										// `FOOTER_QR_PX` past it costs this layout a sheet, and
										// unlike `DarkFooter` there is no disclaimer here for the
										// code to sit beside and ride for free.
										<span
											className="footer-qr"
											style={{
												display: "inline-flex",
												alignItems: "center",
												gap: 5,
											}}
										>
											<QRCodeSVG
												value={qrUrl}
												size={FOOTER_QR_PX}
												marginSize={0}
											/>
											<span
												style={{
													fontSize: 6,
													lineHeight: 1.15,
													color: "rgba(255,255,255,.85)",
													fontWeight: 700,
												}}
											>
												{FOOTER_QR_CAPTION_LINES[0]}
												<br />
												{FOOTER_QR_CAPTION_LINES[1]}
											</span>
										</span>
									) : null}
								</span>
							</div>
						) : null}
						{officers.length > 0 ? (
							<OfficerGrid officers={officers} onDark />
						) : null}
						{header.mission ? (
							<div
								style={{
									fontSize: 9,
									fontWeight: 500,
									color: "rgba(255,255,255,.8)",
									lineHeight: 1.3,
									marginTop: officers.length > 0 ? 10 : 0,
									whiteSpace: "pre-line",
								}}
							>
								<span
									style={{
										textTransform: "uppercase",
										letterSpacing: ".04em",
										fontSize: 8,
										fontWeight: 700,
										color: SEAFOAM,
										marginRight: 6,
									}}
								>
									Mission
								</span>
								{header.mission}
							</div>
						) : null}
					</div>
				) : null}
			</div>
		</FitPage>
	);
}

function Pill({
	children,
	dark,
}: {
	children: React.ReactNode;
	dark?: boolean;
}) {
	return (
		<span
			style={{
				background: dark ? INK : "#e7f0e8",
				color: dark ? "#fff" : INK,
				fontSize: 9.5,
				fontWeight: 700,
				padding: "4px 10px",
				borderRadius: 999,
				whiteSpace: "nowrap",
			}}
		>
			{children}
		</span>
	);
}

function ThemeCard({
	label,
	value,
	color,
}: {
	label: string;
	value: string;
	color: string;
}) {
	return (
		<div
			style={{
				flex: 1,
				background: MINT,
				borderLeft: `3px solid ${color}`,
				borderRadius: "0 9px 9px 0",
				padding: "9px 14px",
			}}
		>
			<Kick>{label}</Kick>
			<div style={{ font: `600 17px ${SERIF}`, color: INK, marginTop: 1 }}>
				{value}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// SPACIOUS — two pages
// ---------------------------------------------------------------------------
function SpaciousLayout({
	header,
	roles,
	officers,
	rows,
	qrUrl,
	onWouldFlow,
	density,
	fitKey,
}: LayoutProps) {
	// Page 1 carries the roster, page 2 the run of show; each decides for itself.
	const page1Legend = sheetLegend({ roles });
	const page2Legend = sheetLegend({ rows });
	return (
		<TwoPage>
			{/* PAGE 1 */}
			<FitPage key={`1${fitKey}`} onWouldFlow={onWouldFlow}>
				<div
					style={{
						background: `linear-gradient(125deg, ${LAGOON}, ${INK})`,
						padding: "34px 52px",
						color: "#fff",
					}}
				>
					<div style={{ display: "flex", alignItems: "center", gap: 20 }}>
						<ClubLogo logoUrl={header.logoUrl} />
						<div style={{ flex: 1, minWidth: 0 }}>
							<div
								style={{
									font: `600 34px ${SERIF}`,
									lineHeight: 1.02,
									letterSpacing: "-.015em",
								}}
							>
								{header.clubName}
							</div>
							{clubLine(header) ? (
								<div
									style={{
										fontSize: 12.5,
										color: "rgba(255,255,255,.82)",
										marginTop: 5,
										letterSpacing: ".02em",
									}}
								>
									{clubLine(header)}
								</div>
							) : null}
						</div>
						<div style={{ flex: "none", textAlign: "right" }}>
							<div style={{ font: `600 15px ${SERIF}` }}>{header.dateLong}</div>
							<div
								style={{
									fontSize: 12,
									color: "rgba(255,255,255,.82)",
									marginTop: 2,
								}}
							>
								{header.timeRange}
							</div>
						</div>
					</div>
				</div>

				<div
					style={{
						padding: "26px 52px 0",
						flex: 1,
						display: "flex",
						flexDirection: "column",
					}}
				>
					{(header.theme || header.wordOfTheDay) && (
						<div style={{ display: "flex", gap: 16, marginBottom: 24 }}>
							{header.theme ? (
								<BigThemeCard
									label="Meeting Theme"
									value={header.theme}
									color={TEAL}
								/>
							) : null}
							{header.wordOfTheDay ? (
								<BigThemeCard
									label="Word of the Day"
									value={header.wordOfTheDay}
									color={FOREST}
								/>
							) : null}
						</div>
					)}

					<Kick style={{ fontSize: 11, marginBottom: 12 }}>Meeting Roles</Kick>
					<div style={{ marginBottom: 26 }}>
						<RolesRoster roles={roles} variant="large" />
					</div>

					{header.mission ? (
						<>
							<Kick style={{ fontSize: 11, marginBottom: 12 }}>
								Club Mission
							</Kick>
							<div
								style={{
									font: `400 15px/1.6 ${SERIF}`,
									color: "#2b4d52",
									maxWidth: 640,
									whiteSpace: "pre-line",
									marginBottom: 26,
								}}
							>
								{header.mission}
							</div>
						</>
					) : null}

					{header.location ? (
						<>
							<Kick style={{ fontSize: 11, marginBottom: 12 }}>
								Where We Meet
							</Kick>
							<div
								style={{
									font: `400 15px/1.6 ${SERIF}`,
									color: "#2b4d52",
									maxWidth: 640,
								}}
							>
								{header.location}
							</div>
						</>
					) : null}
				</div>

				{/* `|| qrUrl`, like `GridLayout`'s footer (#717): a club with
				    neither officers nor a meeting schedule on file would otherwise
				    render no band at all on this sheet, and the QR would have
				    nowhere to go on the very page this fixes. */}
				{officers.length > 0 ||
				header.meetingSchedule ||
				page1Legend ||
				qrUrl ? (
					<div
						data-print-footer=""
						style={{
							marginTop: "auto",
							background: INK,
							padding: "16px 52px",
							color: "#fff",
						}}
					>
						{/* #717: `spacious` is the OTHER two-sheet layout, and its page 1
						    had no ballot QR — the same defect the issue describes for
						    `timing`, which the issue's premise (that `timing` is the only
						    two-sheet layout) missed. A club printing spacious
						    double-sided still handed out a front side with no route to
						    the ballot.

						    The code goes INSIDE this existing band rather than adding a
						    `DarkFooter` beneath it: a second dark band would be a
						    block-level addition to a sheet, which is the shape of change
						    that pushes a printed page. Beside the officer stack it is
						    all but free — that stack is taller than the square, so the
						    sheet measures 890px of 1056 with the code on it against 890
						    without (macOS), and 904 against 890 on CI's Ubuntu, where
						    the officer grid renders ~14px shorter and the square
						    overhangs it. Same trick, same reason, as `DarkFooter`'s own
						    rewrite. */}
						<div style={{ display: "flex", alignItems: "center", gap: 18 }}>
							<div style={{ flex: 1, minWidth: 0 }}>
								{officers.length > 0 ? (
									<>
										<Kick
											style={{ color: SEAFOAM, fontSize: 9.5, marginBottom: 9 }}
										>
											Club Officers
										</Kick>
										<OfficerGrid officers={officers} onDark />
									</>
								) : null}
								{header.meetingSchedule ? (
									<div style={{ marginTop: officers.length > 0 ? 12 : 0 }}>
										<Kick
											style={{ color: SEAFOAM, fontSize: 9.5, marginBottom: 3 }}
										>
											Meets
										</Kick>
										<div
											style={{
												fontSize: 11,
												fontWeight: 500,
												color: "rgba(255,255,255,.85)",
												lineHeight: 1.3,
												whiteSpace: "pre-line",
											}}
										>
											{header.meetingSchedule}
										</div>
									</div>
								) : null}
								{/* The (V) key (#1164): one line under the "Meets" block. */}
								{page1Legend ? (
									<div
										data-visiting-legend=""
										style={{
											marginTop:
												officers.length > 0 || header.meetingSchedule ? 8 : 0,
											fontSize: 9.5,
											color: "rgba(255,255,255,.7)",
										}}
									>
										{page1Legend}
									</div>
								) : null}
							</div>
							{qrUrl ? (
								<span
									className="footer-qr"
									style={{
										flex: "none",
										display: "inline-flex",
										alignItems: "center",
										gap: 7,
									}}
								>
									<span
										style={{
											fontSize: 7,
											lineHeight: 1.2,
											color: "rgba(255,255,255,.85)",
											fontWeight: 700,
											textAlign: "right",
										}}
									>
										{FOOTER_QR_CAPTION_LINES[0]}
										<br />
										{FOOTER_QR_CAPTION_LINES[1]}
									</span>
									<QRCodeSVG value={qrUrl} size={FOOTER_QR_PX} marginSize={0} />
								</span>
							) : null}
						</div>
					</div>
				) : null}
			</FitPage>

			{/* PAGE 2 */}
			<FitPage key={`2${fitKey}`} onWouldFlow={onWouldFlow}>
				<div
					style={{
						padding: "34px 52px 0",
						flex: 1,
						display: "flex",
						flexDirection: "column",
					}}
				>
					<div
						style={{
							display: "flex",
							alignItems: "baseline",
							justifyContent: "space-between",
							borderBottom: `3px solid ${TEAL}`,
							paddingBottom: 12,
							marginBottom: 20,
						}}
					>
						<div style={{ font: `600 26px ${SERIF}`, color: INK }}>
							Run of Show
						</div>
						<div style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>
							{header.dateLong} · {header.timeRange}
						</div>
					</div>

					<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
						<RunNarrative
							rows={rows}
							scale="lg"
							nameTheGroup
							density={density}
						/>
					</div>

					{/* #721 retired the paper "Tonight's Votes" box that used to sit
					    beside this at a fixed 238px — the club votes on phones through
					    the footer QR now. A block rather than the old single-child flex
					    row, so the announcements list and the ruled notes lines take the
					    freed width instead of leaving a gap where the panel was. */}
					<div style={{ marginTop: 22 }}>
						{announcementLines(header.announcements).length > 0 ? (
							<AnnouncementsBlock text={header.announcements} />
						) : (
							<NotesBlock lines={3} />
						)}
					</div>
				</div>

				<DarkFooter
					left="Guests are always welcome — speak to any officer about getting involved."
					right="toastmasters.org"
					qrUrl={qrUrl}
					legend={page2Legend}
				/>
			</FitPage>
		</TwoPage>
	);
}

function BigThemeCard({
	label,
	value,
	color,
}: {
	label: string;
	value: string;
	color: string;
}) {
	return (
		<div
			style={{
				flex: 1,
				background: MINT,
				borderLeft: `4px solid ${color}`,
				borderRadius: "0 12px 12px 0",
				padding: "15px 20px",
			}}
		>
			<Kick style={{ fontSize: 10 }}>{label}</Kick>
			<div style={{ font: `600 25px ${SERIF}`, color: INK, marginTop: 3 }}>
				{value}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// TIMING — two pages (the detailed timing sheet, default)
// ---------------------------------------------------------------------------

/** The run-of-show table's Role and Green·Yellow·Red columns. Role was 150px,
 *  which wrapped nearly every "Role · Holder" cell onto two lines, and the
 *  marks column was 150px for ~105px of content (its header, "Green · Yellow ·
 *  Red", is the widest thing in it). THR's 2026-10-10 sheet measured 1500px
 *  at the old widths and 6px row padding, past `MIN_FIT_SCALE`'s 1464px cliff,
 *  so page 2 flowed onto a third sheet; `thr-timing-print-fit.test.tsx`. */
const TIMING_ROLE_W = 190;
const TIMING_MARKS_W = 110;

/** The height a sheet's capacity keeps back when Timing is paginated (#1227).
 *  `FitPage` leaves a sheet alone while its content is at most the page height,
 *  and a measured sum of fractional heights can land a hair over; 2px is its own
 *  "content == page height" guard, and a sheet that still overshoots by a pixel
 *  scales by a rounding error instead of flowing. */
const PAGINATE_SLACK_PX = 2;

/** Timing page 2's title bar: the sheet's heading and the meeting's time range. */
function TimingTitleBar({ header }: { header: AgendaHeader }) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "baseline",
				justifyContent: "space-between",
				borderBottom: `3px solid ${TEAL}`,
				paddingBottom: 11,
				marginBottom: 14,
			}}
		>
			<div style={{ font: `600 24px ${SERIF}`, color: INK }}>
				Run of Show — Detailed Timing
			</div>
			<div style={{ fontSize: 11, color: MUTED, fontWeight: 600 }}>
				{header.timeRange}
			</div>
		</div>
	);
}

/** The run-of-show table's dark column header. Repeated on every continuation
 *  sheet (#1227), so a row at the top of a later sheet still reads as a row of
 *  the same table. */
function TimingTableHead() {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				background: INK,
				color: "#fff",
				borderRadius: "8px 8px 0 0",
				padding: "7px 12px",
				fontSize: 9,
				textTransform: "uppercase",
				letterSpacing: ".05em",
				fontWeight: 800,
			}}
		>
			<div style={{ flex: "none", width: 46 }}>Time</div>
			<div style={{ flex: "none", width: TIMING_ROLE_W }}>Role</div>
			<div style={{ flex: 1 }}>Segment</div>
			<div
				style={{
					flex: "none",
					width: TIMING_MARKS_W,
					textAlign: "center",
				}}
			>
				Green · Yellow · Red
			</div>
		</div>
	);
}

/** The box the run-of-show rows sit in. `marker` (paginated sheets only) names
 *  it for the tests: it is the region whose text is the run of show. */
function TimingFrame({
	marker,
	children,
}: {
	marker?: boolean;
	children: React.ReactNode;
}) {
	return (
		<div
			{...(marker ? { "data-run-of-show": "" } : {})}
			style={{
				border: "1px solid rgba(23,58,64,.12)",
				borderTop: "none",
				borderRadius: "0 0 8px 8px",
				overflow: "hidden",
			}}
		>
			{children}
		</div>
	);
}

/** The announcements (or, with none, the notes lines) under the run of show.
 *  With `marker` it is the measured tail of a paginated run (#1227): it prints
 *  once, under the last row. */
function TimingTail({
	header,
	marker,
}: {
	header: AgendaHeader;
	marker?: boolean;
}) {
	return (
		// #721 — same as the spacious run of show above: the compact 206px votes
		// panel is gone and this block takes the full width rather than leaving a
		// column of nothing beside it.
		<div {...(marker ? { "data-run-tail": "" } : {})} style={{ marginTop: 18 }}>
			{announcementLines(header.announcements).length > 0 ? (
				<AnnouncementsBlock text={header.announcements} />
			) : (
				<NotesBlock lines={4} />
			)}
		</div>
	);
}

/** One entry of Timing's run of show: a section band, a hand-off band, or a
 *  row. `stripe` is its place in the whole run (odd ones are tinted), `last`
 *  whether it is the last thing in its box (no hairline under it). */
function TimingEntry({
	item,
	stripe,
	last,
	compact,
}: {
	item: RowItem<TimelineRow>;
	stripe: number;
	last: boolean;
	compact: boolean;
}) {
	const { entry: r, folded } = item;
	// The one place with a real column header, so the band keeps the
	// table's stripe and rule and spans the Role + Segment columns
	// as one line — starting at 58px, the Role column's own edge —
	// rather than filling four cells with a stampless echo of the
	// row below it.
	// A templated agenda's segment header, before the handoff arm.
	// This layout splits `who` on " · " into a TIMING_ROLE_W Role column,
	// so a section falling through would have its title parsed as
	// a role/holder pair and stamped with a clock.
	if (r.section)
		return (
			<SectionBand
				row={r}
				fontSize={10}
				padding={compact ? "3px 12px 2px 12px" : "6px 12px 4px 12px"}
			/>
		);
	if (r.handoff)
		return (
			<HandoffBand
				row={r}
				fontSize={10}
				padding="3px 12px 3px 58px"
				chrome={{
					background: stripe % 2 === 1 ? "#fafdfb" : "#fff",
					borderBottom: last ? undefined : HAIR,
				}}
				// Two-page layout: the speakers can be overleaf (#578).
				nameTheGroup
			/>
		);
	// The two halves come off the ROW now (#463), not out of a split.
	// This used to be `r.who.split(" · ")`, and both directions of that
	// split were wrong in general: since #445 the role half is the
	// club's own free text, so a role named "Timer · Assistant" shifted
	// text into the name column — while the holder half carries the
	// separator too on a guest row ("Speaker 1 · Jane · Guest"), so a
	// last-split broke that instead.
	//
	// The `??` fallback is for rows that carry no halves: event and
	// section beats, whose `who` is a whole label with no holder. Those
	// were never ambiguous, and splitting them was already a no-op.
	const role = r.roleLabel ?? r.who;
	const name = r.holder ?? "";
	return (
		<RowShell
			compact={compact}
			folded={folded}
			foldedPadding="1px 12px 0 58px"
			// Two-page layout: the speakers can be overleaf (#578).
			nameTheGroup
			rowStyle={{
				alignItems: "center",
				padding: compact ? "2px 12px" : "4px 12px",
			}}
			chrome={{
				borderBottom: last ? undefined : HAIR,
				background: isHighlighted(r)
					? MINT
					: stripe % 2 === 1
						? "#fafdfb"
						: "#fff",
			}}
		>
			{/* Test hook — see `RunNarrative`'s note on `data-row-time`. */}
			<div
				data-row-time={r.time}
				style={{
					flex: "none",
					width: 46,
					fontSize: 11,
					fontWeight: 800,
					color: INK,
				}}
			>
				{r.time}
			</div>
			<div
				style={{
					flex: "none",
					width: TIMING_ROLE_W,
					fontSize: 10.5,
					fontWeight: name ? 700 : 600,
					color: INK,
				}}
			>
				{role}
				{name ? (
					<span style={{ fontWeight: 600, color: MUTED }}>
						{" · "}
						{name}
					</span>
				) : null}
			</div>
			<div
				style={{
					flex: 1,
					fontSize: 10.5,
					color: MUTED,
					whiteSpace: "pre-line",
				}}
			>
				{r.detail}
			</div>
			<div
				style={{
					flex: "none",
					width: TIMING_MARKS_W,
					display: "flex",
					justifyContent: "center",
					gap: 11,
				}}
			>
				{r.marks ? (
					<>
						<span
							style={{
								fontSize: 10,
								color: GREEN,
								fontWeight: 700,
							}}
						>
							{mark(r.marks.green)}
						</span>
						<span
							style={{
								fontSize: 10,
								color: YELLOW,
								fontWeight: 700,
							}}
						>
							{mark(r.marks.yellow)}
						</span>
						<span style={{ fontSize: 10, color: RED, fontWeight: 700 }}>
							{mark(r.marks.red)}
						</span>
					</>
				) : null}
			</div>
		</RowShell>
	);
}

/** The slim band that heads sheets 3..N of a paginated Timing (#1227): the club
 *  and the date on the left, which page this is on the right. In `HeaderBand`'s
 *  colours, at a fixed 44px so it costs every continuation sheet the same, and
 *  one line each side whatever the club is called. */
function TimingContinuationHeader({
	header,
	k,
	total,
}: {
	header: AgendaHeader;
	k: number;
	total: number;
}) {
	return (
		<div
			data-continuation-header=""
			style={{
				height: 44,
				boxSizing: "border-box",
				background: `linear-gradient(125deg, ${LAGOON}, ${INK})`,
				color: "#fff",
				padding: "0 38px",
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 16,
			}}
		>
			<div
				style={{
					minWidth: 0,
					overflow: "hidden",
					textOverflow: "ellipsis",
					whiteSpace: "nowrap",
					font: `600 15px ${SERIF}`,
				}}
			>
				{[header.clubName, header.dateLong].filter(Boolean).join("  ·  ")}
			</div>
			<div
				style={{
					flex: "none",
					whiteSpace: "nowrap",
					fontSize: 11,
					fontWeight: 700,
					letterSpacing: ".03em",
					color: SEAFOAM,
				}}
			>
				{`Run of show, continued · Page ${k} of ${total}`}
			</div>
		</div>
	);
}

type TimingRunSheetProps = {
	header: AgendaHeader;
	qrUrl?: string;
	compact: boolean;
	/** The whole run, folded (`foldHandoffs`). */
	items: RowItem<TimelineRow>[];
	/** Null: every entry and the tail on this one sheet, as Timing has always
	 *  printed. Else the units (`unitsOf`: item positions) a paginated run is
	 *  packed from, and `unitIds` the ones on THIS sheet; the id `units.length`
	 *  is the tail. */
	units: number[][] | null;
	unitIds?: readonly number[];
	/** This sheet's place in the sheets of the agenda, page 1 being the roster. */
	k: number;
	total: number;
	/** Sheets 3..N: the slim header instead of the title bar. */
	continued?: boolean;
	/** Measuring only: draw the (V) key whether or not a row needs it, so the
	 *  footer is measured at its tallest. */
	forceLegend?: boolean;
	marker?: boolean;
};

/** Timing's run-of-show sheet: page 2 as it has always been (`units` null), or
 *  any sheet of a paginated run (#1227). The footer, QR included, is the same
 *  `DarkFooter` on every one, and each decides its own (V) legend from the rows
 *  it shows. */
function TimingRunSheet({
	header,
	qrUrl,
	compact,
	items,
	units,
	unitIds,
	k,
	total,
	continued,
	forceLegend,
	marker,
}: TimingRunSheetProps) {
	const ids = unitIds ?? [];
	const shownUnits = units ? ids.filter((u) => u < units.length) : [];
	const shown = units
		? shownUnits.flatMap((u) => units[u])
		: items.map((_, p) => p);
	const lastShown = shown.at(-1);
	const hasTail = units ? ids.includes(units.length) : true;
	const legend =
		forceLegend ||
		sheetLegend({
			rows: shown.flatMap((p) => [...items[p].folded, items[p].entry]),
		})
			? VISITING_TOASTMASTER_LEGEND
			: undefined;
	const entry = (p: number) => (
		<TimingEntry
			key={rowKey(items[p].entry, items[p].index)}
			item={items[p]}
			stripe={p}
			last={p === lastShown}
			compact={compact}
		/>
	);
	return (
		<>
			{continued ? (
				<TimingContinuationHeader header={header} k={k} total={total} />
			) : null}
			<div
				style={{
					padding: continued ? "16px 44px 0" : "28px 44px 0",
					flex: 1,
					display: "flex",
					flexDirection: "column",
				}}
			>
				{continued ? null : <TimingTitleBar header={header} />}
				<TimingTableHead />
				<TimingFrame marker={marker}>
					{units
						? shownUnits.map((u) => (
								<div
									key={u}
									data-unit=""
									// `flow-root`, so a section band's top margin stays inside the
									// unit and the unit's height is what it really costs.
									style={{ display: "flow-root" }}
								>
									{units[u].map(entry)}
								</div>
							))
						: shown.map(entry)}
				</TimingFrame>
				{hasTail ? <TimingTail header={header} marker={marker} /> : null}
			</div>
			<DarkFooter
				left={`Page ${k} of ${total} · Detailed run of show`}
				right={`${header.clubName}`}
				qrUrl={qrUrl}
				legend={legend}
			/>
		</>
	);
}

/** Where Timing's paginated run is measured (#1227): off-screen, at scale 1, at
 *  sheet width, both the whole run (every unit's height, and what is NOT a unit:
 *  title, table header, footer, tail) and an empty continuation sheet (its
 *  chrome). Rendered only while the answer is wanted, then unmounted. Reads
 *  after `document.fonts.ready`, the same wait `FitPage` makes, so the heights
 *  are the printed ones. */
function TimingMeasure({
	header,
	qrUrl,
	compact,
	items,
	units,
	onMeasured,
}: {
	header: AgendaHeader;
	qrUrl?: string;
	compact: boolean;
	items: RowItem<TimelineRow>[];
	units: number[][];
	onMeasured: (pages: number[][]) => void;
}) {
	const fullRef = useRef<HTMLDivElement>(null);
	const emptyRef = useRef<HTMLDivElement>(null);
	const doneRef = useRef(onMeasured);
	doneRef.current = onMeasured;
	useEffect(() => {
		let cancelled = false;
		const measure = () => {
			const full = fullRef.current;
			const empty = emptyRef.current;
			if (cancelled || !full || !empty) return;
			const height = (el: Element) => el.getBoundingClientRect().height;
			const unitHeights = [...full.querySelectorAll("[data-unit]")].map(height);
			const tail = full.querySelector("[data-run-tail]");
			// The tail's top margin sits outside its box, and is part of what it costs.
			const tailHeight = tail
				? height(tail) +
					Number.parseFloat(getComputedStyle(tail).marginTop || "0")
				: 0;
			const used = unitHeights.reduce((a, b) => a + b, 0) + tailHeight;
			const firstChrome = height(full) - used;
			const restChrome = height(empty);
			doneRef.current(
				paginate(
					[...unitHeights, tailHeight],
					PAGE_H - firstChrome - PAGINATE_SLACK_PX,
					PAGE_H - restChrome - PAGINATE_SLACK_PX,
				),
			);
		};
		const fonts = (
			document as Document & { fonts?: { ready: Promise<unknown> } }
		).fonts;
		if (fonts?.ready) fonts.ready.then(measure);
		else measure();
		return () => {
			cancelled = true;
		};
	}, []);
	const probe: React.CSSProperties = {
		position: "absolute",
		left: -99999,
		top: 0,
		visibility: "hidden",
		pointerEvents: "none",
		width: PAGE_W,
		// What `PAGE_OUTER` gives a real sheet and every cell inherits: outside a
		// sheet the probe would lay out in the page's own face, and measure heights
		// no printed sheet has (33px rows came out 27px).
		fontFamily: SANS,
		color: INK,
		display: "flex",
		flexDirection: "column",
	};
	const common = {
		header,
		qrUrl,
		compact,
		items,
		units,
		forceLegend: true,
		marker: true,
	};
	return (
		<>
			<div
				ref={fullRef}
				data-paginate-probe=""
				aria-hidden="true"
				style={probe}
			>
				<TimingRunSheet
					{...common}
					unitIds={[...units.keys(), units.length]}
					k={2}
					total={2}
				/>
			</div>
			<div
				ref={emptyRef}
				data-paginate-probe=""
				aria-hidden="true"
				style={probe}
			>
				<TimingRunSheet {...common} unitIds={[]} k={3} total={3} continued />
			</div>
		</>
	);
}

/** The units Timing's run is packed from (#1227): each folded entry's place in
 *  its presenter group (`groupByPresenter`, on the rows as they were before
 *  folding), with sections and unfolded hand-off bands marked as heads. */
function timingUnits(
	rows: readonly TimelineRow[],
	items: readonly RowItem<TimelineRow>[],
): number[][] {
	const groupOf: number[] = [];
	groupByPresenter([...rows]).forEach((g, gi) => {
		for (const _ of g.rows) groupOf.push(gi);
	});
	return unitsOf(
		items.map((it) => ({
			group: groupOf[it.index] ?? it.index,
			head: Boolean(it.entry.section || it.entry.handoff),
		})),
	);
}

function TimingLayout({
	header,
	roles,
	officers,
	explainers,
	rows,
	qrUrl,
	onWouldFlow,
	density,
	fitKey,
}: LayoutProps & Pick<Props, "explainers">) {
	// Page 1 carries the roster, page 2 the timing table; each decides for itself.
	const page1Legend = sheetLegend({ roles });
	const compact = density === "compact";
	const timingItems = foldHandoffs(rows, (r) => r, density);
	// A run still too long for sheet 2 at compact (#1227): its sheet 2 reported
	// that it would flow, so the run is measured and packed onto sheet 2 and as
	// many continuation sheets as it needs. The plan is keyed by everything the
	// measured heights are made of, so a change to any of it measures again
	// instead of printing the old sheet plan: a new density or agenda (`fitKey`),
	// the QR (its footer is 16px taller with one), and the header text the sheets
	// print (announcements are the tail's whole height; the club name and date
	// head every continuation sheet, the time range the title bar).
	const [flowedKey, setFlowedKey] = useState<string | null>(null);
	const [measured, setMeasured] = useState<{
		key: string;
		pages: number[][];
	} | null>(null);
	const flowed = compact && flowedKey === fitKey;
	const planKey = JSON.stringify([
		fitKey,
		Boolean(qrUrl),
		header.announcements,
		header.clubName,
		header.dateLong,
		header.timeRange,
	]);
	const pages = flowed && measured?.key === planKey ? measured.pages : null;
	const total = pages ? 1 + pages.length : 2;
	const units = flowed ? timingUnits(rows, timingItems) : [];
	return (
		<TwoPage>
			{/* PAGE 1 — roles, signals, officers, explainers */}
			<FitPage key={`1${fitKey}`} onWouldFlow={onWouldFlow}>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 16,
						padding: "24px 44px 18px",
						borderBottom: `3px solid ${TEAL}`,
					}}
				>
					<ClubLogo logoUrl={header.logoUrl} />
					<div style={{ flex: 1, minWidth: 0 }}>
						<div
							style={{
								font: `600 24px ${SERIF}`,
								lineHeight: 1.05,
								letterSpacing: "-.01em",
								color: INK,
							}}
						>
							{header.clubName}
						</div>
						{clubLine(header) ? (
							<div
								style={{
									fontSize: 11,
									color: MUTED,
									marginTop: 3,
									fontWeight: 600,
								}}
							>
								{clubLine(header)}
							</div>
						) : null}
					</div>
					<div style={{ flex: "none", textAlign: "right" }}>
						<div
							style={{
								fontSize: 8.5,
								letterSpacing: ".1em",
								textTransform: "uppercase",
								color: FOREST,
								fontWeight: 800,
							}}
						>
							Detailed Timing Agenda
						</div>
						<div
							style={{ font: `600 14px ${SERIF}`, color: INK, marginTop: 2 }}
						>
							{header.dateShort} · {header.timeRange}
						</div>
					</div>
				</div>

				<div
					style={{
						padding: "18px 44px 0",
						flex: 1,
						display: "flex",
						flexDirection: "column",
					}}
				>
					{/* meta */}
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "1fr 1fr 1.3fr",
							gap: 12,
							marginBottom: 18,
						}}
					>
						{header.theme ? (
							<MetaCard label="Theme" value={header.theme} color={TEAL} serif />
						) : null}
						{header.wordOfTheDay ? (
							<MetaCard
								label="Word of the Day"
								value={header.wordOfTheDay}
								color={FOREST}
								serif
							/>
						) : null}
						{header.location ? (
							<MetaCard label="Venue" value={header.location} color={LAGOON} />
						) : null}
					</div>

					<Kick style={{ marginBottom: 7 }}>Meeting Roles</Kick>
					<div style={{ marginBottom: 20 }}>
						<RolesRoster roles={roles} variant="boxed" />
					</div>

					{/* timing signals */}
					<Kick style={{ marginBottom: 7 }}>Timing Signals</Kick>
					<div
						style={{
							background: MINT,
							border: "1px solid rgba(23,58,64,.1)",
							borderRadius: 10,
							padding: "12px 18px",
							marginBottom: 20,
						}}
					>
						<div style={{ display: "flex", gap: 22 }}>
							<Signal color={GREEN} label="Green" text="minimum time reached" />
							<Signal
								color={YELLOW}
								label="Yellow"
								text="approaching the target"
							/>
							<Signal color={RED} label="Red" text="maximum; please conclude" />
						</div>
						{/* #357 — the grace period the Timer judges qualification by, spelled
						    out with this agenda's own numbers. */}
						<div
							style={{
								marginTop: 10,
								paddingTop: 9,
								borderTop: "1px solid rgba(23,58,64,.1)",
								fontSize: 10.5,
								lineHeight: 1.4,
								color: MUTED,
							}}
						>
							{graceSentence(firstQualifyingWindow(rows))}
						</div>
					</div>

					{officers.length > 0 ? (
						<>
							<Kick style={{ marginBottom: 7 }}>Club Officers</Kick>
							<div style={{ marginBottom: 16 }}>
								<OfficerGrid officers={officers} />
							</div>
						</>
					) : null}

					{header.meetingSchedule || header.mission ? (
						<div style={{ display: "flex", gap: 22, marginBottom: 16 }}>
							{header.meetingSchedule ? (
								<div style={{ flex: "none", maxWidth: 220 }}>
									<Kick style={{ marginBottom: 3 }}>Meets</Kick>
									<div
										style={{
											font: `600 12px ${SERIF}`,
											color: INK,
											lineHeight: 1.35,
											whiteSpace: "pre-line",
										}}
									>
										{header.meetingSchedule}
									</div>
								</div>
							) : null}
							{header.mission ? (
								<div style={{ flex: 1, minWidth: 0 }}>
									<Kick style={{ marginBottom: 3 }}>Club Mission</Kick>
									<div
										style={{
											font: `400 12px/1.5 ${SERIF}`,
											color: "#2b4d52",
											whiteSpace: "pre-line",
										}}
									>
										{header.mission}
									</div>
								</div>
							) : null}
						</div>
					) : null}

					{explainers.length > 0 ? (
						<>
							<Kick style={{ marginBottom: 7 }}>
								New to Toastmasters? The Roles, Explained
							</Kick>
							<div
								style={{
									border: "1px solid rgba(23,58,64,.12)",
									borderRadius: 10,
									padding: "14px 18px",
									flex: 1,
									display: "flex",
									flexDirection: "column",
								}}
							>
								<div
									style={{
										display: "grid",
										gridTemplateColumns: "1fr 1fr",
										gap: "10px 30px",
									}}
								>
									{explainers.map((e) => (
										<div
											key={e.role}
											style={{ fontSize: 11, lineHeight: 1.4, color: MUTED }}
										>
											<b style={{ color: INK }}>{e.role}</b> — {e.description}
										</div>
									))}
								</div>
							</div>
						</>
					) : null}
				</div>

				{/* #717: `qrUrl` here, not only on page 2. A club printing this
				    agenda DOUBLE-SIDED got a front side with no way to reach the
				    ballot. Invisible on screen, where both sheets scroll past in one
				    view. `SpaciousLayout` had the same gap and is fixed the same
				    way — the issue's premise that `timing` is the only two-sheet
				    layout is wrong, and `grep -n "<TwoPage>"` is how to check it.

				    This sheet has the room: measured 928px of 1056 with the code on
				    it, so `FitPage` applies no transform and the QR prints at its
				    full `FOOTER_QR_PX` edge. Not unique in that — every sheet the
				    scale leaves alone does, including spacious page 2, which is long
				    enough to take `FitPage`'s FLOW branch instead. */}
				<DarkFooter
					left={`Page 1 of ${total} · Officers & roles`}
					right="toastmasters.org"
					qrUrl={qrUrl}
					legend={page1Legend}
				/>
			</FitPage>

			{/* PAGE 2 (and, when the run is too long for one sheet at compact, the
			    continuation sheets after it, #1227) — detailed timing table */}
			{pages ? (
				pages.map((unitIds, p) => (
					<FitPage key={`p${unitIds.join("-")}|${planKey}`}>
						<TimingRunSheet
							header={header}
							qrUrl={qrUrl}
							compact={compact}
							items={timingItems}
							units={units}
							unitIds={unitIds}
							k={p + 2}
							total={total}
							continued={p > 0}
							marker
						/>
					</FitPage>
				))
			) : (
				<>
					<FitPage
						key={`2${fitKey}`}
						// At compact this sheet is the last resort, so a sheet that still
						// flows there is paginated (#1227) instead of told to the caller.
						onWouldFlow={compact ? () => setFlowedKey(fitKey) : onWouldFlow}
					>
						<TimingRunSheet
							header={header}
							qrUrl={qrUrl}
							compact={compact}
							items={timingItems}
							units={null}
							k={2}
							total={2}
						/>
					</FitPage>
					{flowed ? (
						<TimingMeasure
							key={planKey}
							header={header}
							qrUrl={qrUrl}
							compact={compact}
							items={timingItems}
							units={units}
							onMeasured={(next) => setMeasured({ key: planKey, pages: next })}
						/>
					) : null}
				</>
			)}
		</TwoPage>
	);
}

function MetaCard({
	label,
	value,
	color,
	serif,
}: {
	label: string;
	value: string;
	color: string;
	serif?: boolean;
}) {
	return (
		<div
			style={{
				background: MINT,
				borderLeft: `3px solid ${color}`,
				borderRadius: "0 9px 9px 0",
				padding: "9px 14px",
			}}
		>
			<Kick>{label}</Kick>
			<div
				style={
					serif
						? { font: `600 16px ${SERIF}`, color: INK, marginTop: 1 }
						: {
								fontSize: 11,
								color: INK,
								marginTop: 2,
								lineHeight: 1.35,
								fontWeight: 600,
							}
				}
			>
				{value}
			</div>
		</div>
	);
}

function Signal({
	color,
	label,
	text,
}: {
	color: string;
	label: string;
	text: string;
}) {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
			<span
				style={{
					width: 15,
					height: 15,
					borderRadius: "50%",
					background: color,
					flex: "none",
					boxShadow: `0 0 0 3px ${color}2e`,
				}}
			/>
			<span style={{ fontSize: 11.5, color: INK }}>
				<b>{label}</b> — {text}
			</span>
		</div>
	);
}

const NOTE_LINE_KEYS = ["a", "b", "c", "d", "e", "f"];

/** Both call sites (`spacious` :1893, `timing` :2379) are plain block
 *  containers since #721 took the votes panel out of the flex row they shared,
 *  so the root carries no `flex: 1` — it would be inert, and AC 3 was written
 *  about exactly this kind of leftover. Restore it if this is ever a flex item
 *  again. */
function NotesBlock({ lines }: { lines: number }) {
	return (
		<div>
			<Kick style={{ fontSize: 9.5, marginBottom: 7 }}>Meeting Notes</Kick>
			{NOTE_LINE_KEYS.slice(0, lines).map((k) => (
				<div
					key={k}
					style={{ borderBottom: "1px solid rgba(23,58,64,.16)", height: 20 }}
				/>
			))}
		</div>
	);
}

function AnnouncementsBlock({
	text,
	style,
}: {
	text: string | null;
	style?: React.CSSProperties;
}) {
	const lines = announcementLines(text);
	if (lines.length === 0) return null;
	return (
		<div style={style}>
			<Kick style={{ fontSize: 9.5, marginBottom: 7 }}>Announcements</Kick>
			<ul style={{ margin: 0, paddingLeft: 16, listStyleType: "disc" }}>
				{lines.map((line, i) => (
					<li
						// biome-ignore lint/suspicious/noArrayIndexKey: lines have no stable id and can repeat
						key={`${i}-${line}`}
						style={{
							fontSize: 10.5,
							color: INK,
							lineHeight: 1.4,
							marginBottom: 3,
						}}
					>
						{line}
					</li>
				))}
			</ul>
		</div>
	);
}

/* #721 removed `VotesBlock` from here: a mint panel of three award names over
   `________` rules, 238px on `spacious` and 206px on `timing`. It was a paper
   ballot from before #510; the club votes by scanning the footer QR now, so it
   collected marks nobody counted. The QR is the replacement and stays. */

/** Stacks two letter-size pages with a page break between them for print. */
function TwoPage({ children }: { children: React.ReactNode }) {
	return (
		<div
			className="pgwrap"
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: 26,
			}}
		>
			{children}
		</div>
	);
}

export function MeetingAgendaPrint({
	layout,
	header,
	roles,
	officers,
	explainers,
	rows,
	qrUrl,
	onWouldFlow,
	initialDensity = "regular",
}: Props) {
	// The density ladder (#1226): `regular` -> `compact` -> the caller's own
	// `onWouldFlow` (the print route's fallback to Timing, #1225). Climbed one
	// rung per decision, and only when a sheet reports it would flow, so an agenda
	// that fits never leaves `regular`.
	const [density, setDensity] = useState<PrintDensity>(initialDensity);
	// A new layout or a new agenda starts the climb again. Adjusted during render,
	// not in an effect, so no frame is drawn at the old density. `epoch` feeds the
	// sheets' keys: a sheet measures once per mount, and a new agenda at the SAME
	// density has to be measured too.
	const [seen, setSeen] = useState({ layout, rows, epoch: 0 });
	if (seen.layout !== layout || seen.rows !== rows) {
		setSeen({ layout, rows, epoch: seen.epoch + 1 });
		setDensity("regular");
	}
	const common = {
		header,
		roles,
		officers,
		rows,
		qrUrl,
		density,
		fitKey: `${seen.epoch}:${density}`,
		// Any sheet that would flow moves the WHOLE layout down a rung, so a
		// two-sheet layout's sheets always match. At `compact` the caller is told,
		// except for Timing: it IS the fallback, so a Timing sheet still too long at
		// compact is paginated by `TimingLayout` (#1227) whatever the caller passed,
		// or the route would announce a fallback "from Timing to Timing".
		onWouldFlow:
			density === "regular"
				? () => setDensity("compact")
				: layout === "timing"
					? undefined
					: onWouldFlow,
	};
	switch (layout) {
		case "editorial":
			return <EditorialLayout {...common} />;
		case "grid":
			return <GridLayout {...common} />;
		case "spacious":
			return <SpaciousLayout {...common} />;
		default:
			return <TimingLayout {...common} explainers={explainers} />;
	}
}
