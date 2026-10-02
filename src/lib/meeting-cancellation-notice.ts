// Meeting cancellation (#1057): the refusal copy every surface shares, and the
// copyable notice an officer gets instead of the app sending anything.
//
// Pure and client-safe: no `#/db`. The meeting page's notice sheet and the
// `cancel_meeting` MCP tool both build their text HERE, from the same holders,
// so the button and the connector cannot draft different notices.
//
// ## The app drafts; a human sends (ADR-0028)
//
// Nothing here sends anything. The officer copies the text, or the holders'
// addresses, into their own chat or mail app.
//
// ## Why the refusal constants live in `src/lib`
//
// `meetings-logic.ts` imports `voting-logic.ts` and `attendance-plan-logic.ts`,
// and both of those now refuse a write on a cancelled meeting. Defining
// `MEETING_CANCELLED_MESSAGE` in `meetings-logic.ts` would make them import it
// back, a cycle the bundler tolerates and a reader does not. The meeting page
// also shows the sentence, and a route may not import a `*-logic.ts` module.

import { formatMeetingDate } from "./format";

/** A member-facing write on a cancelled meeting. The one sentence every
 *  refused path says, so a test can tell it from the lock and the archive. */
export const MEETING_CANCELLED_MESSAGE = "This meeting is cancelled.";

/** Cancel refusals, checked in this order; the first that applies wins. */
export const MEETING_CANCEL_COMPLETED_MESSAGE =
	"A completed meeting can't be cancelled. Reopen it first.";
export const MEETING_CANCEL_PAST_MESSAGE =
	"A meeting whose date has passed can't be cancelled.";
export const MEETING_ALREADY_CANCELLED_MESSAGE =
	"This meeting is already cancelled.";

/** Restore refusals, in order. */
export const MEETING_RESTORE_PAST_MESSAGE =
	"A meeting whose date has passed can't be restored.";
export const MEETING_NOT_CANCELLED_MESSAGE = "This meeting isn't cancelled.";

/**
 * Reopen's refusal for anything that is not `completed` (#1057). Reopen sets
 * `scheduled` unconditionally, so before this a cancelled meeting could be
 * "reopened" around restore's day rule. Here rather than beside the lock copy
 * in `meeting-lifecycle.ts` because cancellation is what made it reachable,
 * and because the sentence's job is to point at Restore.
 */
export const MEETING_REOPEN_NOT_COMPLETED_MESSAGE =
	"Only a completed meeting can be reopened. A cancelled meeting is put back with Restore.";

/** True when the meeting is cancelled (skipped, assignments kept). */
export function isMeetingCancelled(status: string): boolean {
	return status === "cancelled";
}

/**
 * The search key that opens the notice sheet on arrival. A bare-date meeting
 * URL skips a cancelled meeting (`meeting-resolve-logic.ts`), so after
 * cancelling from one the page moves to the uuid URL, and this is how the sheet
 * survives the move: the route's `validateSearch` passes unknown keys through
 * unchanged, and an officer landing with it open sees the notice first.
 */
export const CANCELLATION_NOTICE_PARAM = "notice";

/** The uuid meeting URL with the notice flag set. */
export function cancellationNoticeHref(
	clubKey: string,
	meetingId: string,
): string {
	return `/club/${clubKey}/meeting/${meetingId}?${CANCELLATION_NOTICE_PARAM}=1`;
}

/** Whether the URL asks for the notice. Both spellings the router can hand
 *  over: the number a default parse produces, and the string a hand-built
 *  search may carry (`isInRoom` makes the same allowance). Takes the route's
 *  search object as-is: `validateSearch` passes unknown keys through, so the
 *  key is present at runtime though absent from `MeetingRoomSearch`'s type. */
export function isCancellationNoticeRequested(search: object): boolean {
	const notice = (search as { [CANCELLATION_NOTICE_PARAM]?: unknown }).notice;
	return notice === 1 || notice === "1";
}

/** Throw the member-facing refusal for a cancelled meeting. */
export function assertMeetingNotCancelled(status: string): void {
	if (isMeetingCancelled(status)) {
		throw new Error(MEETING_CANCELLED_MESSAGE);
	}
}

/**
 * One held role on the cancelled meeting, as the notice needs it. `email` is
 * present only for a MEMBER holder on the officer's own payload; a guest is
 * named and gets no address, and the connector never carries one.
 */
export interface CancellationHolder {
	roleName: string;
	name: string;
	email?: string | null;
}

/** One line of the notice: a role and everyone who held it. */
export interface CancellationLine {
	roleName: string;
	/** In agenda order, joined with ", " in the text. */
	names: string[];
}

export interface CancellationNotice {
	/** A subject line for the mail an officer writes: names the club. */
	subject: string;
	/** The drafted notice: the sentence, then one line per held role. */
	text: string;
	lines: CancellationLine[];
	/** De-duplicated, members with an address only, in agenda order. */
	emails: string[];
}

/**
 * The shape both callers already hold a slot in: `loadMeetingSlots`'s rows
 * (the MCP tool) and the meeting payload's contact-bearing rows (the page).
 * Structural, so neither has to map before calling.
 */
export interface HolderSlot {
	roleName: string;
	assigneeName: string | null;
	assigneeIsGuest?: boolean;
	holderEmail?: string | null;
}

/** The held slots of a meeting as notice holders, in the order given. */
export function holdersFromSlots(
	slots: readonly HolderSlot[],
): CancellationHolder[] {
	const out: CancellationHolder[] = [];
	for (const s of slots) {
		if (!s.assigneeName) continue;
		out.push({
			roleName: s.roleName,
			name: s.assigneeName,
			// A guest is named but never addressed: guest contact has never
			// ridden on this surface, and the notice is for the club's own list.
			email: s.assigneeIsGuest ? null : (s.holderEmail ?? null),
		});
	}
	return out;
}

/**
 * Draft the cancellation notice.
 *
 * "Our meeting on <date> is cancelled." and then, when anyone held a role, a
 * blank line and one line per role in the order the holders were given, which
 * callers take from the agenda. A role several people held names them all,
 * joined with ", ". With no holders the notice is the one sentence.
 *
 * The date is `formatMeetingDate`, the same club-local formatter the meeting
 * page header uses, so the notice names the day the officer is looking at.
 */
export function buildCancellationNotice(input: {
	clubName: string;
	scheduledAt: Date | string;
	timezone: string;
	holders: readonly CancellationHolder[];
}): CancellationNotice {
	const date = formatMeetingDate(input.scheduledAt, input.timezone);
	const byRole = new Map<string, string[]>();
	for (const h of input.holders) {
		const names = byRole.get(h.roleName);
		if (names) names.push(h.name);
		else byRole.set(h.roleName, [h.name]);
	}
	const lines: CancellationLine[] = [...byRole.entries()].map(
		([roleName, names]) => ({ roleName, names }),
	);
	const sentence = `Our meeting on ${date} is cancelled.`;
	const text =
		lines.length === 0
			? sentence
			: [
					sentence,
					"",
					...lines.map((l) => `${l.roleName}: ${l.names.join(", ")}`),
				].join("\n");

	const emails: string[] = [];
	const seen = new Set<string>();
	for (const h of input.holders) {
		const email = h.email?.trim();
		if (!email) continue;
		const key = email.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		emails.push(email);
	}

	return {
		subject: `${input.clubName}: meeting on ${date} cancelled`,
		text,
		lines,
		emails,
	};
}
