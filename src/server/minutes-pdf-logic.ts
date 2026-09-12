// Server-side minutes PDF generation (ADR-0014 / #152) via `@react-pdf/renderer`
// — a pure-JS renderer with no headless browser, so it fits the `node:22-slim`
// Railway image and the single-Node-server deploy (no Chromium). This module is
// server-only (it touches `#/db` through the minutes logic) and is never
// imported by a client route.
//
// `renderMinutesPdf(meetingId)` is a CONTRACT consumed by the email fast-follow
// (#165): keep the name + signature (`(meetingId: string) => Promise<Uint8Array>`)
// stable.
//
// Uses `React.createElement` rather than JSX because the contract fixes this
// module at a `.ts` path (JSX requires `.tsx`).
import {
	Document,
	Page,
	renderToBuffer,
	StyleSheet,
	Text,
	View,
} from "@react-pdf/renderer";
import { eq } from "drizzle-orm";
import { createElement as h } from "react";
import { db } from "#/db";
import { clubs, meetings } from "#/db/schema";
// The caps live in `#/lib` so their VALUES are assertable — this module imports
// `#/db`, so a unit test importing it throws `DATABASE_URL is not set`. See the
// trap-5 note in that file.
import {
	ACTION_ITEM_LIMITS,
	ACTION_ITEM_RENDER_CAPS,
} from "#/lib/action-item-limits";
// The ONE audited `cap`. It is deliberately not reimplemented here: that
// function has now had TWO cost/correctness defects found in it by review (a
// full-input spread in #519, an astral-plane bypass in #522), so a second
// `slice` written from scratch is exactly the wrong kind of duplication.
import { cap } from "#/lib/cap";
import { formatMeetingDate } from "#/lib/format";
import { MINUTES_RENDER_CAPS } from "#/lib/minutes-render-caps";
import { SPEAKER_LIMITS } from "#/lib/speaker-limits";
import { TIMING_VERDICT_LABEL, timingVerdict } from "#/lib/timing-verdict";
import { formatTimingClock } from "#/lib/timing-window";
import {
	type AttendanceStatus,
	type AwardCategory,
	loadMinutes,
	loadMinutesProgram,
	type MinutesData,
	type MinutesTimingRow,
} from "./minutes-logic";

const AWARD_LABELS: Record<AwardCategory, string> = {
	best_speaker: "Best Speaker",
	best_evaluator: "Best Evaluator",
	best_table_topics: "Best Table Topics",
};

const styles = StyleSheet.create({
	page: {
		paddingVertical: 40,
		paddingHorizontal: 48,
		fontSize: 11,
		fontFamily: "Helvetica",
		color: "#1f2933",
		lineHeight: 1.4,
	},
	title: { fontSize: 20, fontFamily: "Helvetica-Bold", marginBottom: 2 },
	subtitle: { fontSize: 12, color: "#52606d", marginBottom: 2 },
	headerMeta: { fontSize: 11, color: "#52606d" },
	section: { marginTop: 18 },
	sectionTitle: {
		fontSize: 13,
		fontFamily: "Helvetica-Bold",
		marginBottom: 6,
		borderBottomWidth: 1,
		borderBottomColor: "#cbd2d9",
		paddingBottom: 3,
	},
	counts: { fontSize: 11, marginBottom: 4, color: "#3e4c59" },
	label: { fontFamily: "Helvetica-Bold" },
	row: { flexDirection: "row", marginBottom: 2 },
	rowLabel: { width: 130, fontFamily: "Helvetica-Bold" },
	rowValue: { flex: 1 },
	listItem: { marginBottom: 2 },
	muted: { color: "#7b8794", fontStyle: "italic" },
});

/**
 * A trailing "+N more" line when a list was cut, or nothing when it was not.
 *
 * The row caps keep the render bounded; this keeps the DOCUMENT honest about
 * it. Minutes are the club's official record, and a section that silently stops
 * at 60 rows reads as complete.
 */
function elided(total: number, shown: number) {
	if (total <= shown) return null;
	return h(Text, { style: styles.muted }, `+${total - shown} more not shown`);
}

/** The "+N more not shown" sentence, or null when nothing was cut. */
function elidedLine(total: number, shown: number): string | null {
	if (total <= shown) return null;
	return `+${total - shown} more not shown`;
}

/**
 * The action-item block of the minutes, as plain strings (#529).
 *
 * Pure and exported so the three rules that matter here are ordinary
 * assertions instead of PDF archaeology — a rendered PDF's content streams are
 * compressed, so a byte search cannot see any of them:
 *
 *  - an UNOWNED item carries no owner run at all (a placeholder in a permanent
 *    record reads as an owner named "The club", and would silently convert a
 *    departed owner's personal commitment into a club-wide one)
 *  - a list cut by the row cap says so, rather than reading as complete
 *  - the whole block is absent for the `guests` audience
 *
 * Row-capped here as well as in `loadActionItemsForMinutes`. That is deliberate
 * duplication: the upstream cap bounds the payload, the DOM and the offline
 * snapshot, while this one bounds the RENDER for any caller that hands over an
 * uncapped list — react-pdf lays out synchronously in the single Node process
 * and its cost is super-linear in row count. `*Total` carries the true count, so
 * the tails stay honest through both caps.
 */
export function buildActionItemsSection(
	actionItems: MinutesData["actionItems"] | undefined,
	audience: "members" | "guests",
): {
	openRows: string[];
	openTail: string | null;
	resolvedRows: string[];
	resolvedTail: string | null;
} | null {
	if (audience === "guests" || !actionItems) return null;
	const openRows = actionItems.open
		.slice(0, ACTION_ITEM_RENDER_CAPS.rows)
		.map((a) =>
			a.ownerName
				? `${cap(a.text, ACTION_ITEM_LIMITS.text)} — ${cap(
						a.ownerName,
						ACTION_ITEM_RENDER_CAPS.ownerName,
					)}`
				: cap(a.text, ACTION_ITEM_LIMITS.text),
		);
	const resolvedRows = actionItems.resolved
		.slice(0, ACTION_ITEM_RENDER_CAPS.rows)
		.map(
			(a) =>
				`Closed (${a.resolution}): ${cap(a.text, ACTION_ITEM_LIMITS.text)}`,
		);
	return {
		openRows,
		openTail: elidedLine(actionItems.openTotal, ACTION_ITEM_RENDER_CAPS.rows),
		resolvedRows,
		resolvedTail: elidedLine(
			actionItems.resolvedTotal,
			ACTION_ITEM_RENDER_CAPS.rows,
		),
	};
}

/**
 * Join a roster into one display line, bounded BEFORE the join (#522).
 *
 * Capping the joined string afterwards would be the #519 defect one frame up:
 * the cost of building it still scales with the input, so `cap(names(list))`
 * materialises the whole megabyte and only then shortens it. The list is
 * anonymously growable — `submitGuestBook` is public with no session, and each
 * distinct guest becomes an attendance row — so the bound has to come first.
 *
 * Elision is COUNTED, not silent. These are the club's record of who was in the
 * room; a bare "…" loses names with no indication how many.
 */
function names(list: { name: string }[]): string {
	if (!list.length) return "—";
	const shown = list.slice(0, MINUTES_RENDER_CAPS.nameRows);
	const hidden = list.length - shown.length;
	// BOTH bounds, and both are load-bearing. Slicing the list first is what
	// stops the build cost scaling with the input. Capping the JOINED result is
	// what stops the line itself being huge — 100 names at 120 code points each
	// is 12,000, well past what one wrapped line should lay out. The second cap
	// is cheap precisely because the first one already ran: its input is bounded
	// before it sees it, which is the ordering the #519 defect got backwards.
	const line = cap(
		shown.map((x) => cap(x.name, MINUTES_RENDER_CAPS.name)).join(", "),
		MINUTES_RENDER_CAPS.namesLine,
	);
	return hidden > 0 ? `${line} (+${hidden} more)` : line;
}

/**
 * Pure view-model for the PDF's Attendance section — the single source of the
 * counts line and the per-status name rows. Unmarked members (no saved
 * attendance record, `status: null`, #218) are NEVER listed as absent: they
 * get their own "Unmarked" row and count, included only when at least one
 * member is unmarked so fully-recorded minutes render unchanged.
 */
export function buildAttendanceSection(minutes: {
	members: Pick<MinutesData["members"][number], "name" | "status">[];
	guests: { name: string }[];
	counts: MinutesData["counts"];
}): { countsLine: string; rows: { label: string; names: string }[] } {
	const byStatus = (status: AttendanceStatus | null) =>
		minutes.members.filter((m) => m.status === status);
	const { present, absent, excused, unmarked, guests } = minutes.counts;
	const countsLine =
		`Present: ${present}   Absent: ${absent}   Excused: ${excused}   ` +
		(unmarked > 0 ? `Unmarked: ${unmarked}   ` : "") +
		`Guests: ${guests}`;
	const rows = [
		{ label: "Present", names: names(byStatus("present")) },
		{ label: "Excused", names: names(byStatus("excused")) },
		{ label: "Absent", names: names(byStatus("absent")) },
		...(unmarked > 0
			? [{ label: "Unmarked", names: names(byStatus(null)) }]
			: []),
		{ label: "Guests", names: names(minutes.guests) },
	];
	return { countsLine, rows };
}

/**
 * The Timing block of the minutes, as plain strings (#730).
 *
 * Pure and exported for the same reason `buildActionItemsSection` is: a
 * rendered PDF's content streams are compressed, so a byte search cannot see
 * any of the rules below, and asserting them here is the only way they are
 * checkable at all.
 *
 * ## Null means the section is OMITTED, and that is a decision
 *
 * This repo does BOTH things with an empty section, so neither is an existing
 * invariant to inherit: `buildActionItemsSection` returning null omits
 * entirely, while Table Topics and Program render "No … recorded." The choice
 * here follows action items, and the reason is what the absence would MEAN.
 * Attendance and Table Topics are things every meeting has, so an empty one is
 * information — "nobody came", "we skipped the segment". The stopwatch is
 * opt-in: a club that never uses it has not failed to record anything, and
 * printing a permanently empty heading on every set of its minutes says
 * otherwise.
 *
 * ## The verdict is derived here, from the row's OWN marks
 *
 * `timingVerdict` reads the marks stored on the timing, never a live agenda
 * value, so an officer editing the min/max next month cannot re-decide whether
 * a past speech qualified. `unknown` is a real outcome — a beat can carry a
 * partial trio — and prints as "No window set" rather than as a judgement
 * nobody made.
 *
 * Row-capped like every other section: react-pdf's cost is super-linear in row
 * count, and `role_slots` are creatable through the self-assert path with no
 * ceiling. `programRows` is the right constant because a timing IS a program
 * row that got measured, so the two sections cannot be capped differently.
 */
export function buildTimingSection(minutes: {
	timings?: MinutesTimingRow[];
}): { rows: string[]; tail: string | null } | null {
	// `?? []` and not a non-null assertion: an offline snapshot written by a
	// previous deploy has no `timings` key at all. See `MinutesData.timings`.
	const timings = minutes.timings ?? [];
	if (timings.length === 0) return null;
	const rows = timings.slice(0, MINUTES_RENDER_CAPS.programRows).map((t) => {
		const who = t.assigneeName
			? `${cap(t.assigneeName, MINUTES_RENDER_CAPS.name)}${
					t.isGuest ? " (Guest)" : ""
				}`
			: "—";
		const verdict =
			TIMING_VERDICT_LABEL[timingVerdict(t.elapsedSeconds, t, "speech")];
		// Seconds → the SAME clock the printed agenda and the Timer's role sheet
		// use, so a member reading the minutes beside the agenda sees one
		// notation rather than two.
		const clock = formatTimingClock(t.elapsedSeconds / 60);
		return `${cap(t.roleName, MINUTES_RENDER_CAPS.roleName)}: ${who} — ${clock} · ${verdict}`;
	});
	return {
		rows,
		tail: elidedLine(timings.length, MINUTES_RENDER_CAPS.programRows),
	};
}

/**
 * Build the minutes PDF for a meeting and return it as a byte buffer. Contains:
 * a header (club, date, theme, Word of the Day), attendance (present/absent/
 * excused/unmarked counts + names + the guest list), Table Topics speakers +
 * topics, awards, and a compact program section (roles + speeches,
 * summary-level).
 *
 * `audience` decides whether the club's action items are included, and it
 * defaults to the narrow answer. The download route is gated on club
 * membership, but `createMinutesEmailPort` attaches these same bytes to the
 * minutes email, whose default recipient list includes every guest marked
 * present — and a guest can add themselves through `submitGuestBook`, which is
 * a public endpoint with no session. Action items are club-internal ("chase the
 * lapsed members", "drop the venue"), so the emailed copy asks for "guests" and
 * gets a PDF without them.
 */
export async function renderMinutesPdf(
	meetingId: string,
	audience: "members" | "guests" = "members",
): Promise<Uint8Array> {
	const [meeting] = await db
		.select({
			clubId: meetings.clubId,
			scheduledAt: meetings.scheduledAt,
			theme: meetings.theme,
			wordOfTheDay: meetings.wordOfTheDay,
		})
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting) throw new Error("Meeting not found.");

	const [club] = await db
		.select({ name: clubs.name, timezone: clubs.timezone })
		.from(clubs)
		.where(eq(clubs.id, meeting.clubId))
		.limit(1);

	const [minutes, program] = await Promise.all([
		loadMinutes(meetingId),
		loadMinutesProgram(meetingId),
	]);

	const attendance = buildAttendanceSection(minutes);

	const clubName = cap(club?.name ?? "Meeting", MINUTES_RENDER_CAPS.club);

	const actionItemsSection = buildActionItemsSection(
		minutes.actionItems,
		audience,
	);
	const timingSection = buildTimingSection(minutes);
	const doc = h(
		Document,
		{ title: `Minutes — ${clubName}` },
		h(
			Page,
			{ size: "LETTER", style: styles.page },
			// Header
			h(
				View,
				null,
				h(
					Text,
					{ style: styles.title },
					club?.name ? clubName : "Meeting Minutes",
				),
				h(
					Text,
					{ style: styles.subtitle },
					formatMeetingDate(meeting.scheduledAt, club?.timezone ?? "UTC"),
				),
				meeting.theme
					? h(
							Text,
							{ style: styles.headerMeta },
							`Theme: ${cap(meeting.theme, MINUTES_RENDER_CAPS.theme)}`,
						)
					: null,
				meeting.wordOfTheDay
					? h(
							Text,
							{ style: styles.headerMeta },
							`Word of the Day: ${cap(
								meeting.wordOfTheDay,
								MINUTES_RENDER_CAPS.word,
							)}`,
						)
					: null,
			),
			// Attendance
			h(
				View,
				{ style: styles.section },
				h(Text, { style: styles.sectionTitle }, "Attendance"),
				h(Text, { style: styles.counts }, attendance.countsLine),
				attendance.rows.map((r) =>
					h(
						View,
						{ key: r.label, style: styles.row },
						h(Text, { style: styles.rowLabel }, r.label),
						// `names()` already bounds both the row count and each name,
						// so the line arrives capped. Capping it again here would
						// re-add the very post-join pass that made the cost scale
						// with the input.
						h(Text, { style: styles.rowValue }, r.names),
					),
				),
			),
			// Table Topics
			h(
				View,
				{ style: styles.section },
				h(Text, { style: styles.sectionTitle }, "Table Topics Speakers"),
				minutes.tableTopicsSpeakers.length
					? minutes.tableTopicsSpeakers
							.slice(0, MINUTES_RENDER_CAPS.tableTopicsRows)
							.map((s, i) =>
								h(
									Text,
									{ key: s.id, style: styles.listItem },
									`${i + 1}. ${cap(s.name, MINUTES_RENDER_CAPS.name)}${
										s.isGuest ? " (Guest)" : ""
									}${
										s.topic
											? ` — ${cap(s.topic, MINUTES_RENDER_CAPS.topic)}`
											: ""
									}`,
								),
							)
					: h(Text, { style: styles.muted }, "No Table Topics recorded."),
				elided(
					minutes.tableTopicsSpeakers.length,
					MINUTES_RENDER_CAPS.tableTopicsRows,
				),
			),
			// Action items (#529) — the section model is built by the pure
			// `buildActionItemsSection` above so every rule in it (the omitted owner,
			// the "+N more" tails, the guest omission) is a plain string assertion
			// rather than something you would have to extract from compressed PDF
			// content streams. Same split `buildAttendanceSection` already uses.
			actionItemsSection === null
				? null
				: h(
						View,
						{ style: styles.section },
						h(Text, { style: styles.sectionTitle }, "Action Items"),
						actionItemsSection.openRows.length
							? actionItemsSection.openRows.map((line, i) =>
									h(
										Text,
										{ key: `ai-open-${i}`, style: styles.listItem },
										line,
									),
								)
							: h(Text, { style: styles.muted }, "Nothing outstanding."),
						actionItemsSection.openTail
							? h(Text, { style: styles.muted }, actionItemsSection.openTail)
							: null,
						actionItemsSection.resolvedRows.map((line, i) =>
							h(Text, { key: `ai-closed-${i}`, style: styles.listItem }, line),
						),
						actionItemsSection.resolvedTail
							? h(
									Text,
									{ style: styles.muted },
									actionItemsSection.resolvedTail,
								)
							: null,
					),
			// Timing (#730) — the Timer's measured times. ABSENT, not empty, when
			// the club recorded none; `buildTimingSection`'s docblock says why that
			// differs from Table Topics two sections up.
			timingSection === null
				? null
				: h(
						View,
						{ style: styles.section },
						h(Text, { style: styles.sectionTitle }, "Timing"),
						timingSection.rows.map((line, i) =>
							h(Text, { key: `timing-${i}`, style: styles.listItem }, line),
						),
						timingSection.tail
							? h(Text, { style: styles.muted }, timingSection.tail)
							: null,
					),
			// Awards
			h(
				View,
				{ style: styles.section },
				h(Text, { style: styles.sectionTitle }, "Awards"),
				// No row cap: `loadMinutes` builds this from the fixed
				// `AWARD_CATEGORIES` enum, so it is always exactly three rows. A
				// slice here would be a constant that can never fire, and an
				// absolute-ceiling test on it could never fail.
				minutes.awards.map((a) =>
					h(
						View,
						{ key: a.category, style: styles.row },
						h(Text, { style: styles.rowLabel }, AWARD_LABELS[a.category]),
						h(
							Text,
							{ style: a.name ? styles.rowValue : styles.muted },
							a.name
								? `${cap(a.name, MINUTES_RENDER_CAPS.name)}${
										a.isGuest ? " (Guest)" : ""
									}`
								: "—",
						),
					),
				),
			),
			// Program
			h(
				View,
				{ style: styles.section },
				h(Text, { style: styles.sectionTitle }, "Program"),
				program.length
					? program
							.slice(0, MINUTES_RENDER_CAPS.programRows)
							.map((p) =>
								h(
									Text,
									{ key: p.slotId, style: styles.listItem },
									`${cap(p.roleName, MINUTES_RENDER_CAPS.roleName)}: ${
										p.assigneeName
											? `${cap(p.assigneeName, MINUTES_RENDER_CAPS.name)}${
													p.isGuest ? " (Guest)" : ""
												}`
											: "—"
									}${
										p.speechTitle
											? ` — “${cap(p.speechTitle, SPEAKER_LIMITS.speechTitle)}”`
											: ""
									}`,
								),
							)
					: h(Text, { style: styles.muted }, "No program recorded."),
				elided(program.length, MINUTES_RENDER_CAPS.programRows),
			),
		),
	);

	return renderToBuffer(doc as Parameters<typeof renderToBuffer>[0]);
}
