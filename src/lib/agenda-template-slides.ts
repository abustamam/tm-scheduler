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
import { type AgendaRow, visitingFlag } from "./agenda-runsheet";
import {
	type ClubForDeck,
	type MeetingForDeck,
	nextMeetingSlide,
	type Slide,
	tableTopicsNoteLines,
} from "./agenda-slides";
import type { NextMeetingSummary } from "./next-meeting-summary";
import {
	formatTimingClock,
	qualifyingWindowForMarks,
	segmentFor,
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
	/** Backs the "What's on tap for next meeting" slide (#932), as on the
	 *  standard deck; null or absent leaves the deck unchanged. */
	nextMeeting?: NextMeetingSummary | null;
	/** The sign-up QR's absolute URL, null until the origin is known. */
	nextMeetingSignupUrl?: string | null;
	/** The anonymous feedback page's absolute URL (#1282). A templated meeting
	 *  has no General Evaluation slide, so the Thank-You slide carries the QR. */
	feedbackUrl?: string | null;
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
 * Table Topics is the one segment whose window FLOORS at green (#720: a response
 * must reach the minimum to be eligible), and its upper bound is the same
 * red + 0:30 as every other segment (#1258: one rule, no club opt-out). A
 * club's own cap changes the row's marks (`refreshTableTopicsMarks` re-derives
 * them), never the rule, so a governed row and an ungoverned one print through
 * the same derivation and cannot project two disqualification rules.
 */
export type BeatTiming = {
	green: string;
	yellow: string;
	red: string;
	/** The qualifying window, e.g. "4:30–7:30". */
	qualifies: string;
};

export function beatTimingText(row: AgendaRow): BeatTiming | null {
	if (!row.marks) return null;
	// ONE derivation of "which segment is this row", shared with the Timer's
	// sheet and the printed agenda's grace line (#720) — `segmentFor` is where
	// the role key is matched, so this file no longer states that rule itself.
	// The segment travels into the derivation: Table Topics floors at green
	// (#720) and graces +0:30 above red like every other segment (#1258).
	const window = qualifyingWindowForMarks(row.marks, segmentFor(row.roleKey));
	if (!window) return null;
	return {
		green: formatTimingClock(row.marks.green),
		yellow: formatTimingClock(row.marks.yellow),
		red: formatTimingClock(row.marks.red),
		// The ROW's marks, which for this segment are the club's CURRENT window
		// (`resolveAgendaRows` re-derives them on the way here), so the wall and
		// the paper the room is holding are one derivation from one source.
		// Reading the row keeps this function a pure function of its argument.
		qualifies: window.range,
	};
}

export function buildTemplateSlideDeck({
	meeting,
	club,
	rows,
	nextMeetingAt = null,
	meetingNumber = null,
	nextMeeting = null,
	nextMeetingSignupUrl = null,
	feedbackUrl = null,
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

	// The ONE row the Table Topics notes ride on (#880): the first Table Topics
	// Master row. The run of show gives the role three beats in this order — the
	// segment, the vote, the hand-off to the GE — so the first is the segment
	// unless an officer drags another above it. NOT `clubGoverned`: that flag is
	// timer-window ownership, which "Use a different window for this meeting"
	// clears and re-governing can move onto the vote or the hand-off row, taking
	// the notes with it.
	// The role is matched through `segmentFor`, the one place a role key decides
	// "is this the Table Topics segment", as `beatTimingText` below does.
	const notesRow = rows.find(
		(r) => !r.section && segmentFor(r.roleKey) === "tableTopics",
	);

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
			// The row's marks already carry the club's window, so the two decks
			// state one disqualification rule between them.
			timing: beatTimingText(row),
			// Once, on the segment — see `notesRow` above.
			notes:
				row === notesRow ? tableTopicsNoteLines(meeting.tableTopicsNotes) : [],
			// The holder rides in `label` (the header), not the body, so the (V) key
			// is the ROW's flag, set from the slot (#1164).
			...visitingFlag(row),
		});
	}

	// Meeting-level text, not a beat — so unlike awards or guest comments it has
	// no template row to arrive through and would vanish from a contest. Placed
	// before the closing splash, matching the standard deck's closing order.
	if (meeting.reminders?.trim()) {
		deck.push({ kind: "reminders", text: meeting.reminders.trim() });
	}

	// What's on tap next (#932) — the same slide, from the same builder, that the
	// standard deck ends on. Meeting-level like the announcements above, so it has
	// no template row to arrive through either.
	const onTap = nextMeetingSlide(
		nextMeeting,
		club.timezone,
		nextMeetingSignupUrl,
	);
	if (onTap) deck.push(onTap);

	deck.push({
		kind: "thankYou",
		meetingSchedule: club.meetingSchedule,
		nextMeetingAt,
		timezone: club.timezone,
		feedbackUrl,
	});

	return deck;
}
