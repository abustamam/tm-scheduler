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
import { formatMeetingDate } from "#/lib/format";
import {
	type AttendanceStatus,
	type AwardCategory,
	loadMinutes,
	loadMinutesProgram,
	type MinutesData,
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

function names(list: { name: string }[]): string {
	return list.length ? list.map((x) => x.name).join(", ") : "—";
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
 * Build the minutes PDF for a meeting and return it as a byte buffer. Contains:
 * a header (club, date, theme, Word of the Day), attendance (present/absent/
 * excused/unmarked counts + names + the guest list), Table Topics speakers +
 * topics, awards, and a compact program section (roles + speeches,
 * summary-level).
 */
export async function renderMinutesPdf(meetingId: string): Promise<Uint8Array> {
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

	const doc = h(
		Document,
		{ title: `Minutes — ${club?.name ?? "Meeting"}` },
		h(
			Page,
			{ size: "LETTER", style: styles.page },
			// Header
			h(
				View,
				null,
				h(Text, { style: styles.title }, club?.name ?? "Meeting Minutes"),
				h(
					Text,
					{ style: styles.subtitle },
					formatMeetingDate(meeting.scheduledAt, club?.timezone ?? "UTC"),
				),
				meeting.theme
					? h(Text, { style: styles.headerMeta }, `Theme: ${meeting.theme}`)
					: null,
				meeting.wordOfTheDay
					? h(
							Text,
							{ style: styles.headerMeta },
							`Word of the Day: ${meeting.wordOfTheDay}`,
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
					? minutes.tableTopicsSpeakers.map((s, i) =>
							h(
								Text,
								{ key: s.id, style: styles.listItem },
								`${i + 1}. ${s.name}${s.isGuest ? " (Guest)" : ""}${
									s.topic ? ` — ${s.topic}` : ""
								}`,
							),
						)
					: h(Text, { style: styles.muted }, "No Table Topics recorded."),
			),
			// Awards
			h(
				View,
				{ style: styles.section },
				h(Text, { style: styles.sectionTitle }, "Awards"),
				minutes.awards.map((a) =>
					h(
						View,
						{ key: a.category, style: styles.row },
						h(Text, { style: styles.rowLabel }, AWARD_LABELS[a.category]),
						h(
							Text,
							{ style: a.name ? styles.rowValue : styles.muted },
							a.name ? `${a.name}${a.isGuest ? " (Guest)" : ""}` : "—",
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
					? program.map((p) =>
							h(
								Text,
								{ key: p.slotId, style: styles.listItem },
								`${p.roleName}: ${
									p.assigneeName
										? `${p.assigneeName}${p.isGuest ? " (Guest)" : ""}`
										: "—"
								}${p.speechTitle ? ` — “${p.speechTitle}”` : ""}`,
							),
						)
					: h(Text, { style: styles.muted }, "No program recorded."),
			),
		),
	);

	return renderToBuffer(doc as Parameters<typeof renderToBuffer>[0]);
}
