/**
 * The projected deck for a TEMPLATED meeting (#agenda-templates, PR 2).
 *
 * `buildSlideDeck` composes slides by hand against the seven standard role keys
 * — a Toastmaster slide, a Table Topics slide, three vote slides — so a speech
 * contest ran it and got a title slide and a thank-you slide with nothing
 * between. PR 1 guarded both call sites and pointed the room at Print. This is
 * the deck those guards were standing in for.
 *
 * ## One derivation, two renderers
 *
 * The input is `AgendaRow[]` — the SAME rows `resolveAgendaRows` hands the
 * printed run sheet, not a second walk over the template's beats. That is the
 * whole architecture, and it is the reason this file is short. The deck cannot
 * disagree with the paper about what happens or in what order, which matters
 * more here than on a standard meeting: during a contest the Chair works from
 * the printed sheet while the room watches the wall, and the two drifting apart
 * is a contest protest.
 *
 * It also means the deck inherits, for free, every property PR 1 established on
 * those rows — the repeat-block expansion, the character caps, the beat-label
 * (not role-name) `who`, and the refusal to fall back when a template is empty.
 *
 * ## Speaking order is DATA, and it is drawn outside this app
 *
 * A contest's speaking order is drawn by lot at the briefing, physically, and
 * the app deliberately has no randomizer — a draw the software performed is a
 * draw nobody in the room watched happen, which is the opposite of what the
 * ritual is for. The officer RECORDS the drawn order instead, by moving
 * contestants in the agenda (`applyMoveSpeakerSlot`, which swaps `slot_index`
 * within one `role_definition_id` and is therefore already template-agnostic).
 *
 * Three consequences this builder must honour, all of them satisfied by being a
 * pure function of the rows at render time:
 *
 * 1. **Nothing is cached or pre-generated.** The deck is rebuilt from the
 *    current rows on every render, so a re-draw — including one made mid-contest
 *    after a no-show — is reflected by a refresh and cannot go stale on the wall.
 * 2. **Numbering follows POSITION, not identity.** `buildTemplateRows` numbers
 *    from the slot's place in its repeat block, so "Contestant 1" means whoever
 *    drew first, not whoever signed up first. Reordering renumbers.
 * 3. **No order of its own.** This file sorts nothing and re-derives nothing. If
 *    it ever needs to, the order belongs in the rows, upstream, where the print
 *    sheet reads it too.
 *
 * ## What it deliberately does NOT emit
 *
 * No vote slides. The club's digital vote (#510) elects Best Speaker by member
 * ballot; a contest is scored by judges on paper to a different rulebook, and
 * projecting a club ballot QR during one would invite the room to vote in a
 * contest they are not the judges of.
 *
 * No awards, guest-comments or Table Topics slides. Those are beats of the
 * standard run of show; a template that wants them declares them as beats and
 * gets them through the generic path below. Announcements are the one exception
 * — they are meeting-level text the club typed, not a beat, so they would
 * otherwise be silently dropped from a contest.
 */
import type { AgendaRow } from "./agenda-runsheet";
import type { ClubForDeck, MeetingForDeck, Slide } from "./agenda-slides";
import {
	formatTableTopicsWindow,
	hasTableTopicsLimits,
	TABLE_TOPICS_ROLE_KEY,
	type TableTopicsLimits,
} from "./table-topics-limits";
import {
	formatTimingClock,
	type QualifyingWindow,
	qualifyingWindowForMarks,
} from "./timing-window";

export type TemplateDeckInput = {
	meeting: MeetingForDeck;
	club: ClubForDeck;
	/** Rows from `resolveAgendaRows` — the printed run sheet's own rows. */
	rows: AgendaRow[];
	/** Backs the Thank-You slide; null when nothing is scheduled after. */
	nextMeetingAt?: Date | null;
	/** The club's effective meeting number (#358). */
	meetingNumber?: number | null;
};

/**
 * The timing a beat's marks imply, as display-ready clock text.
 *
 * `null` for an untimed beat. Built through `qualifyingWindowForMarks` rather
 * than formatted here, so the ±30s grace period this shows is the same rule
 * (#357) the printed agenda's timing key and the Timer's role sheet teach. In a
 * contest that window is not a courtesy — it IS the disqualification rule, so
 * the wall showing a different one from the paper is the worst case.
 *
 * The Table Topics segment is the one beat the grace does NOT govern once a
 * club has stated its own window (#443). Its cap is the club's rule — MCF's own
 * sheet says "2.31+ disqualified" — so applying the speech grace here projected
 * "qualifies 0:30–3:00" off a materialised meeting while the identical club's
 * unmaterialised meeting projected "2:31+ disqualified", one wall contradicting
 * the next with nothing but the agenda editor between them. `firstQualifyingWindow`
 * filters non-speaker rows for exactly this reason; this derivation did not,
 * and a comment in `table-topics-limits.ts` claimed that filter covered both.
 *
 * A club that has stated NOTHING is left alone: its beat carries the standard
 * marks, the graced window is what the Timer's blank role sheet has always
 * printed, and changing that is a product question with its own shape (#679).
 */
export type BeatTiming = {
	green: string;
	yellow: string;
	red: string;
	/** The qualifying window, e.g. "4:30–7:30". */
	qualifies: string;
};

export function beatTimingText(
	row: AgendaRow,
	tableTopicsLimits?: TableTopicsLimits | null,
): BeatTiming | null {
	if (!row.marks) return null;
	const ownRule =
		row.roleKey === TABLE_TOPICS_ROLE_KEY &&
		hasTableTopicsLimits(tableTopicsLimits);
	const window = ownRule ? null : qualifyingWindowForMarks(row.marks);
	if (!ownRule && !window) return null;
	return {
		green: formatTimingClock(row.marks.green),
		yellow: formatTimingClock(row.marks.yellow),
		red: formatTimingClock(row.marks.red),
		// The ROW's marks, which for this segment are the club's CURRENT window
		// since #679 — `resolveAgendaRows` re-derives them on the way here, so the
		// wall and the paper the room is holding are the same derivation from the
		// same source. This comment said "FROZEN marks, not the club's current
		// columns" and stayed true only until that landed; the file was not touched
		// by the change, so nothing prompted a re-read. Reading the row rather than
		// the club columns is still the right call and is now also correct: it
		// keeps this function a pure function of its argument.
		//
		// `ownRule` needs no marks-provenance test of its own. The early return
		// above means `row.marks` is non-null, which with the roleKey match is
		// exactly `isTableTopicsSegment` — so the club's hard cap is labelled as
		// the rule for precisely the rows whose marks the club owns.
		qualifies: ownRule
			? formatTableTopicsWindow(row.marks)
			: (window as QualifyingWindow).range,
	};
}

export function buildTemplateSlideDeck({
	meeting,
	club,
	rows,
	nextMeetingAt = null,
	meetingNumber = null,
}: TemplateDeckInput): Slide[] {
	const deck: Slide[] = [
		{
			kind: "title",
			clubName: club.name,
			logoUrl: club.logoUrl ?? null,
			district: club.district,
			clubNumber: club.clubNumber,
			meetingNumber,
			scheduledAt: new Date(meeting.scheduledAt),
			timezone: club.timezone,
		},
	];

	for (const row of rows) {
		if (row.section) {
			// A round divider. `who` carries the band title on a section row — see
			// `toRow` in agenda-template-rows.ts, which puts the label there and
			// nulls the role key precisely so both renderers read one field.
			deck.push({ kind: "templateSection", title: row.who });
			continue;
		}
		deck.push({
			kind: "templateBeat",
			// `who`, not the beat's raw label: on a role row it is the numbered
			// label plus the assignee ("Contestant 1 · Ada Lovelace"), which is
			// what the room needs on the wall. Using the label alone would drop the
			// person, and #463 is the standing reminder that these two are not
			// interchangeable.
			label: row.who,
			detail: row.detail.trim() || null,
			minutes: row.minutes,
			// The club's own columns, off the SAME `ClubForDeck` the standard deck
			// reads them from — so the two decks state one disqualification rule
			// between them rather than one each.
			timing: beatTimingText(row, {
				minSeconds: club.tableTopicsMinSeconds,
				maxSeconds: club.tableTopicsMaxSeconds,
			}),
		});
	}

	// Meeting-level text, not a beat — so unlike awards or guest comments it has
	// no template row to arrive through and would vanish from a contest. Placed
	// before the closing splash, matching the standard deck's closing order.
	if (meeting.reminders?.trim()) {
		deck.push({ kind: "reminders", text: meeting.reminders.trim() });
	}

	deck.push({
		kind: "thankYou",
		meetingSchedule: club.meetingSchedule,
		nextMeetingAt,
		timezone: club.timezone,
	});

	return deck;
}
