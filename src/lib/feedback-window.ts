/**
 * When anonymous role feedback ("love notes", #981 / #984) may be written and
 * read, as ONE pure rule every surface asks.
 *
 * Instant-based, not day-based — unlike `meetingPhase`, which answers "is it
 * meeting day in the club's timezone". A note may be left from the moment the
 * meeting STARTS (`scheduledAt`) until three days after it is scheduled to END
 * (`scheduledAt + lengthMinutes`), and its recipient may read it once that end
 * has passed. No timezone enters into it: every bound is an absolute instant.
 *
 * The server re-derives this with its OWN clock on every write
 * (`leaveFeedbackLogic`); a client's answer only decides which copy to show.
 */

/** How long after the scheduled end a note may still be left. */
export const FEEDBACK_WINDOW_DAYS_AFTER_END = 3;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export interface FeedbackWindowInput {
	scheduledAt: Date | string;
	lengthMinutes: number;
	status: string;
}

export interface FeedbackWindow {
	/** The meeting's start: the first instant a note may be left. */
	opensAt: Date;
	/** The meeting's scheduled end: the first instant a recipient may read. */
	endsAt: Date;
	/** The first instant a note may NO LONGER be left (exclusive bound). */
	closesAt: Date;
	/** A note may be written now. Never for a cancelled meeting. */
	canWrite: boolean;
	/** The recipient may read this meeting's notes now. */
	recipientsCanRead: boolean;
}

export function feedbackWindow(
	meeting: FeedbackWindowInput,
	now: Date,
): FeedbackWindow {
	const start = new Date(meeting.scheduledAt).getTime();
	const opensAt = new Date(start);
	const endsAt = new Date(start + meeting.lengthMinutes * MINUTE_MS);
	const closesAt = new Date(
		endsAt.getTime() + FEEDBACK_WINDOW_DAYS_AFTER_END * DAY_MS,
	);
	const t = now.getTime();
	return {
		opensAt,
		endsAt,
		closesAt,
		canWrite:
			meeting.status !== "cancelled" &&
			opensAt.getTime() <= t &&
			t < closesAt.getTime(),
		recipientsCanRead: t >= endsAt.getTime(),
	};
}

/** Where `now` falls against a window, ignoring cancellation (callers refuse a
 *  cancelled meeting before asking). */
export type FeedbackWindowState = "notYet" | "open" | "closed";

/**
 * The ONE place open / not-yet / closed is decided. Both the public page (via
 * the state the server computes into its payload) and the write's refusal
 * read this, so the copy a visitor sees and the reason a write is refused can
 * never disagree.
 */
export function feedbackWindowState(
	window: Pick<FeedbackWindow, "opensAt" | "closesAt">,
	now: Date,
): FeedbackWindowState {
	const t = now.getTime();
	if (t < window.opensAt.getTime()) return "notYet";
	if (t >= window.closesAt.getTime()) return "closed";
	return "open";
}

export const FEEDBACK_NOT_OPEN_MESSAGE =
	"Feedback opens when the meeting starts.";
export const FEEDBACK_CLOSED_MESSAGE = "Feedback for this meeting has closed.";

/** Each prompt's cap, counted after trimming. */
export const FEEDBACK_TEXT_MAX = 500;
/** Notes one recipient may receive at one meeting. */
export const FEEDBACK_PER_RECIPIENT_CAP = 20;
/** Notes one meeting may receive in total. */
export const FEEDBACK_PER_MEETING_CAP = 300;
