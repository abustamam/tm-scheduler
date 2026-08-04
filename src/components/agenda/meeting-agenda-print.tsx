// src/components/agenda/meeting-agenda-print.tsx
//
// Faithful React port of the four designed layouts in
// templates/meeting-agenda/MeetingAgenda.dc.html (editorial + grid = one page,
// spacious + timing = two pages). Everything is data-driven from the meeting's
// slots, officers, and run-of-show. The club's district, mission, and
// meeting-schedule are optional free-text profile fields: each renders in its
// designated slot when set and is omitted gracefully (no empty label) when not.
// Logo upload remains a tracked follow-up (#83).
import type { TimelineRow } from "#/lib/agenda-timing";
import { announcementLines } from "#/lib/announcement-lines";
import {
	firstQualifyingWindow,
	formatTimingClock,
	graceNote,
	graceSentence,
} from "#/lib/timing-window";
import {
	AMBER,
	DarkFooter,
	FitPage,
	FOREST,
	GREEN,
	HAIR,
	INK,
	Kick,
	LAGOON,
	MINT,
	MUTED,
	OPEN,
	RED,
	SEAFOAM,
	SERIF,
	TEAL,
} from "./print-theme";

export type AgendaLayout = "timing" | "spacious" | "editorial" | "grid";

export type AgendaHeader = {
	clubName: string;
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

/** One row of the "Meeting Roles" roster (name null → open/unfilled). */
export type AgendaRoleEntry = { label: string; name: string | null };

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
};

/** minutes (e.g. 6.5) → "6:30" for the timing marks. Shared with the grace
 *  window (#357) so a mark and its window always read in the same units. */
const mark = formatTimingClock;

/** The green·yellow·red timing marks for one beat, rendered inline and colored.
 *  Shared by the one-page layouts (editorial + grid) so their per-speaker
 *  timing reads the same as the detailed timing table's Green·Amber·Red column. */
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
				style={{ fontSize: size, color: AMBER, fontWeight: 700, marginLeft: 6 }}
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
				{dot(AMBER, "Approaching")}
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
	evaluator: AMBER,
	toastmaster_of_the_day: LAGOON,
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
	if (w.startsWith("evaluator")) return AMBER;
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
			{roles.map((r, i) => (
				<div
					key={r.label}
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: large ? "baseline" : "center",
						padding: boxed ? "6px 14px" : large ? "9px 0" : "5px 0",
						borderBottom:
							boxed && i >= roles.length - 2
								? undefined
								: "1px solid rgba(23,58,64,.09)",
						background: boxed && i % 2 === 1 ? "#fafdfb" : undefined,
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
					{r.name ? (
						<span style={{ fontSize: nameSize, fontWeight: 600 }}>
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
			))}
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
function HandoffBand({
	row,
	fontSize,
	padding,
	chrome,
}: {
	row: TimelineRow;
	fontSize: number;
	padding: string;
	chrome?: Pick<React.CSSProperties, "background" | "borderBottom">;
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
			<span>{row.detail}</span>
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

/** The narrative run-of-show (editorial / spacious): a colored-spine list.
 *  `timingColors` swaps the muted min–max range for the colored green·yellow·red
 *  trio (used by the one-page editorial layout). */
function RunNarrative({
	rows,
	scale,
	timingColors,
}: {
	rows: TimelineRow[];
	scale: "sm" | "lg";
	timingColors?: boolean;
}) {
	const lg = scale === "lg";
	return (
		<div>
			{rows.map((r, i) => {
				// No spine and no bottom rule: the hand-off sits under the hairline of
				// the beat that hands over and runs straight into the beat it
				// introduces, which is the grouping the room actually experiences.
				// Indented past the 4px spine and the time column so the stamps stay a
				// single unbroken column.
				if (r.handoff)
					return (
						<HandoffBand
							key={rowKey(r, i)}
							row={r}
							fontSize={lg ? 11.5 : 10}
							padding={lg ? "4px 0 4px 83px" : "3px 0 3px 69px"}
						/>
					);
				const color = beatColor(r);
				const highlight = isHighlighted(r);
				return (
					<div
						key={rowKey(r, i)}
						style={{
							display: "flex",
							borderLeft: `4px solid ${color}`,
							background: highlight ? MINT : undefined,
							padding: lg ? "11px 0 11px 15px" : "8px 0 8px 11px",
							borderBottom: i < rows.length - 1 ? HAIR : undefined,
						}}
					>
						{/* Test hook only — nothing renders off it. It marks the clock-stamp
						    cells so the suite can assert "a hand-off repeats no clock stamp"
						    (#363) by collecting every stamp on the page: a `HandoffBand` has
						    no such cell, so a band that started printing one would show up
						    as an extra entry. Matching the stamps as text instead would pass
						    on a band that echoed the row below it. All three row-rendering
						    sites carry it; keep them in sync. */}
						<div
							data-row-time={r.time}
							style={{
								flex: "none",
								width: lg ? 64 : 54,
								fontSize: lg ? 13 : 10.5,
								fontWeight: lg ? 800 : 700,
								color: INK,
							}}
						>
							{r.time}
						</div>
						<div style={{ flex: 1 }}>
							<div style={{ fontSize: lg ? 14 : 11.5, fontWeight: 700 }}>
								{r.who}
								{r.marks ? (
									timingColors ? (
										<span style={{ marginLeft: 8 }}>
											<TimingTrio marks={r.marks} size={lg ? 11 : 10} />
										</span>
									) : (
										<span style={{ fontWeight: 600, color: MUTED }}>
											{" · "}
											{mark(r.marks.green)}–{mark(r.marks.red)}
										</span>
									)
								) : null}
							</div>
							<div
								style={{
									fontSize: lg ? 12 : 10.5,
									color: MUTED,
									lineHeight: 1.4,
									marginTop: 1,
								}}
							>
								{r.detail}
							</div>
						</div>
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
				padding: "22px 38px",
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 18 }}>
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
}: Omit<Props, "layout" | "explainers">) {
	return (
		<FitPage>
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
				style={{ display: "flex", gap: 22, padding: "18px 38px 0", flex: 1 }}
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
					<div
						style={{
							display: "flex",
							justifyContent: "space-between",
							alignItems: "baseline",
							margin: "18px 0 8px",
						}}
					>
						<Kick>Run of Show</Kick>
						<TimingLegend rows={rows} />
					</div>
					<RunNarrative rows={rows} scale="sm" timingColors />
				</div>
			</div>

			<DarkFooter
				left="Guests are always welcome — speak to any officer about getting involved."
				right="toastmasters.org"
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
// ---------------------------------------------------------------------------
function GridLayout({
	header,
	roles,
	officers,
	rows,
}: Omit<Props, "layout" | "explainers">) {
	return (
		<FitPage>
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
					<div style={{ display: "flex", gap: 12, marginBottom: 13 }}>
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
				<div style={{ marginBottom: 14 }}>
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
					{rows.map((r, i) =>
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
						r.handoff ? (
							<HandoffBand
								key={rowKey(r, i)}
								row={r}
								fontSize={10}
								padding="2px 12px 2px 68px"
								chrome={{
									background: i % 2 === 1 ? "#fafdfb" : "#fff",
									borderBottom: i < rows.length - 1 ? HAIR : undefined,
								}}
							/>
						) : (
							<div
								key={rowKey(r, i)}
								style={{
									display: "flex",
									background: isHighlighted(r)
										? MINT
										: i % 2 === 1
											? "#fafdfb"
											: "#fff",
									borderBottom: i < rows.length - 1 ? HAIR : undefined,
								}}
							>
								{/* Test hook — see `RunNarrative`'s note on `data-row-time`. */}
								<div
									data-row-time={r.time}
									style={{
										flex: "none",
										width: 60,
										borderLeft: `4px solid ${beatColor(r)}`,
										padding: "4px 0 4px 10px",
										fontSize: 10.5,
										fontWeight: 700,
										color: INK,
									}}
								>
									{r.time}
								</div>
								<div style={{ flex: 1, padding: "4px 12px 4px 8px" }}>
									<span style={{ fontSize: 10.5, fontWeight: 700 }}>
										{r.who}.
									</span>{" "}
									<span style={{ fontSize: 10, color: MUTED }}>{r.detail}</span>
								</div>
								{r.marks ? (
									<div
										style={{
											flex: "none",
											display: "flex",
											alignItems: "center",
											padding: "4px 12px 4px 0",
										}}
									>
										<TimingTrio marks={r.marks} size={9.5} />
									</div>
								) : null}
							</div>
						),
					)}
				</div>

				<AnnouncementsBlock
					text={header.announcements}
					style={{ marginTop: 14 }}
				/>

				{/* officer footer (also carries the club's meets schedule + mission) */}
				{officers.length > 0 || header.meetingSchedule || header.mission ? (
					<div
						style={{
							marginTop: "auto",
							background: INK,
							margin: "14px -36px 0",
							padding: "13px 36px 16px",
							color: "#fff",
						}}
					>
						{officers.length > 0 || header.meetingSchedule ? (
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "baseline",
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
}: Omit<Props, "layout" | "explainers">) {
	return (
		<TwoPage>
			{/* PAGE 1 */}
			<FitPage>
				<div
					style={{
						background: `linear-gradient(125deg, ${LAGOON}, ${INK})`,
						padding: "34px 52px",
						color: "#fff",
					}}
				>
					<div style={{ display: "flex", alignItems: "center", gap: 20 }}>
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

				{officers.length > 0 || header.meetingSchedule ? (
					<div
						style={{
							marginTop: "auto",
							background: INK,
							padding: "16px 52px",
							color: "#fff",
						}}
					>
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
					</div>
				) : null}
			</FitPage>

			{/* PAGE 2 */}
			<FitPage>
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
						<RunNarrative rows={rows} scale="lg" />
					</div>

					<div style={{ display: "flex", gap: 20, marginTop: 22 }}>
						{announcementLines(header.announcements).length > 0 ? (
							<AnnouncementsBlock
								text={header.announcements}
								style={{ flex: 1 }}
							/>
						) : (
							<NotesBlock lines={3} />
						)}
						<VotesBlock />
					</div>
				</div>

				<DarkFooter
					left="Guests are always welcome — speak to any officer about getting involved."
					right="toastmasters.org"
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
function TimingLayout({
	header,
	roles,
	officers,
	explainers,
	rows,
}: Omit<Props, "layout">) {
	return (
		<TwoPage>
			{/* PAGE 1 — roles, signals, officers, explainers */}
			<FitPage>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 16,
						padding: "24px 44px 18px",
						borderBottom: `3px solid ${TEAL}`,
					}}
				>
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
								color={AMBER}
								label="Amber"
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

				<DarkFooter
					left="Page 1 of 2 · Officers & roles"
					right="toastmasters.org"
				/>
			</FitPage>

			{/* PAGE 2 — detailed timing table */}
			<FitPage>
				<div
					style={{
						padding: "28px 44px 0",
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

					{/* table header */}
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
						<div style={{ flex: "none", width: 150 }}>Role</div>
						<div style={{ flex: 1 }}>Segment</div>
						<div style={{ flex: "none", width: 150, textAlign: "center" }}>
							Green · Amber · Red
						</div>
					</div>

					<div
						style={{
							border: "1px solid rgba(23,58,64,.12)",
							borderTop: "none",
							borderRadius: "0 0 8px 8px",
							overflow: "hidden",
						}}
					>
						{rows.map((r, i) => {
							// The one place with a real column header, so the band keeps the
							// table's stripe and rule and spans the Role + Segment columns
							// as one line — starting at 58px, the Role column's own edge —
							// rather than filling four cells with a stampless echo of the
							// row below it.
							if (r.handoff)
								return (
									<HandoffBand
										key={rowKey(r, i)}
										row={r}
										fontSize={10}
										padding="3px 12px 3px 58px"
										chrome={{
											background: i % 2 === 1 ? "#fafdfb" : "#fff",
											borderBottom: i < rows.length - 1 ? HAIR : undefined,
										}}
									/>
								);
							// `who` joins the role and the holder with " · ", and since #445 the
							// role half is the club's own free text — so a role literally named
							// "Chief · Evaluator" shifts text into the name column. First-split, not
							// last, because the HOLDER half also carries the separator on a guest row
							// ("Speaker 1 · Jane · Guest"). Neither direction is right in general;
							// the real fix is carrying the two as separate fields (#463).
							const [role, ...rest] = r.who.split(" · ");
							const name = rest.join(" · ");
							return (
								<div
									key={rowKey(r, i)}
									style={{
										display: "flex",
										alignItems: "center",
										padding: "6px 12px",
										borderBottom: i < rows.length - 1 ? HAIR : undefined,
										background: isHighlighted(r)
											? MINT
											: i % 2 === 1
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
											width: 150,
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
									<div style={{ flex: 1, fontSize: 10.5, color: MUTED }}>
										{r.detail}
									</div>
									<div
										style={{
											flex: "none",
											width: 150,
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
														color: AMBER,
														fontWeight: 700,
													}}
												>
													{mark(r.marks.yellow)}
												</span>
												<span
													style={{ fontSize: 10, color: RED, fontWeight: 700 }}
												>
													{mark(r.marks.red)}
												</span>
											</>
										) : null}
									</div>
								</div>
							);
						})}
					</div>

					<div style={{ display: "flex", gap: 16, marginTop: 18 }}>
						{announcementLines(header.announcements).length > 0 ? (
							<AnnouncementsBlock
								text={header.announcements}
								style={{ flex: 1 }}
							/>
						) : (
							<NotesBlock lines={4} />
						)}
						<VotesBlock compact />
					</div>
				</div>

				<DarkFooter
					left="Page 2 of 2 · Detailed run of show"
					right={`${header.clubName}`}
				/>
			</FitPage>
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

function NotesBlock({ lines }: { lines: number }) {
	return (
		<div style={{ flex: 1 }}>
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

function VotesBlock({ compact }: { compact?: boolean }) {
	const rows = ["Best Speaker", "Best Table Topic", "Best Evaluator"];
	return (
		<div
			style={{
				flex: "none",
				width: compact ? 206 : 238,
				background: MINT,
				border: "1px solid rgba(23,58,64,.1)",
				borderRadius: compact ? 10 : 12,
				padding: compact ? "12px 15px" : "14px 16px",
			}}
		>
			<Kick style={{ fontSize: 9.5, marginBottom: 7 }}>Tonight's Votes</Kick>
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					gap: 6,
					fontSize: 11,
					color: INK,
				}}
			>
				{rows.map((r, i) => (
					<div
						key={r}
						style={{
							display: "flex",
							justifyContent: "space-between",
							borderBottom:
								i < rows.length - 1
									? "1px dashed rgba(23,58,64,.2)"
									: undefined,
							paddingBottom: 4,
						}}
					>
						<span style={{ color: MUTED, fontWeight: 600 }}>{r}</span>
						<span>________</span>
					</div>
				))}
			</div>
		</div>
	);
}

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
}: Props) {
	switch (layout) {
		case "editorial":
			return (
				<EditorialLayout
					header={header}
					roles={roles}
					officers={officers}
					rows={rows}
				/>
			);
		case "grid":
			return (
				<GridLayout
					header={header}
					roles={roles}
					officers={officers}
					rows={rows}
				/>
			);
		case "spacious":
			return (
				<SpaciousLayout
					header={header}
					roles={roles}
					officers={officers}
					rows={rows}
				/>
			);
		default:
			return (
				<TimingLayout
					header={header}
					roles={roles}
					officers={officers}
					explainers={explainers}
					rows={rows}
				/>
			);
	}
}
