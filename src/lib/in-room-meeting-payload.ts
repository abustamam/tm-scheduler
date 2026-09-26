import type {
	NextMeetingRole,
	NextMeetingSummary,
} from "./next-meeting-summary";

/**
 * The meeting row an IN-ROOM ARTIFACT is allowed to carry (#754).
 *
 * ## What this is for
 *
 * `/print` (all four layouts), `/present`, `/word` and the `.pptx` built from
 * the projected deck are the surfaces that get printed onto paper, thrown onto
 * a wall and forwarded into club chat. #731 decided the meeting's video-call
 * `join_url` is WITHHELD from all four: it is a key to the room, there is no
 * revocation short of a new room, and nobody types a URL off a projector
 * anyway, so there the link is risk with no matching benefit.
 *
 * ## Why the withholding had to move here
 *
 * #731 enforced that decision RENDER-side — the four modules simply did not
 * draw the field — and pinned it with a source grep that called itself the only
 * enforcement. The field shipped anyway, through three links none of which is
 * wrong on its own:
 *
 *   1. `loadMeetingDetail` (`#/server/meetings`) reads the meeting with
 *      `db.query.meetings.findFirst` and no column projection, so the whole row
 *      is on the payload. That was known and accepted in #731, because
 *      `getMeetingByKey` and `getPublicMeetingByKey` share the one builder.
 *   2. Each of the three route loaders returned `{ ...data, logoUrl }`.
 *   3. TanStack Start dehydrates loader data into the served document.
 *
 * So the URL was in `view-source` on all three whether or not any component
 * drew it, and a grep for the identifier cannot, by construction, see a field
 * riding a spread. Measured before the fix: the join URL appeared exactly once
 * in the served HTML of `/print?chrome=none`, `/present` and `/word`, and zero
 * times on `/vote`. A render-side rule governs what is PAINTED; the leak was in
 * what is SHIPPED, so the rule belongs where the payload is built.
 *
 * ## Why an ALLOWLIST and not `delete meeting.joinUrl`
 *
 * The failure being fixed is a column nobody was thinking about riding a
 * spread. A denylist reproduces it the first time a column is added: it is
 * exactly as blind to the next `join_url` as the source grep was to this one.
 * Naming what an artifact may carry means a new column is withheld by default
 * and has to be added here on purpose. `notes` — the organizer's PRIVATE
 * scratch, distinct from `reminders` — drops out for free on the same
 * reasoning, and so does anything added next to it.
 *
 * `/vote` needs no call: it already projects four named fields off the same
 * detail payload, and it is the pattern copied here.
 * `src/routes/join-url-not-on-print-surfaces.guard.test.ts` asserts over the
 * BUILT payload of all four routes, which is the half a source grep could not
 * reach.
 */

/**
 * Every `meetings` column an in-room artifact may carry, and nothing else.
 *
 * Each entry names the surface that reads it, so removing a line is a decision
 * with a visible cost rather than a tidy-up.
 */
export const IN_ROOM_MEETING_FIELDS = [
	/** The real DB id — `/present` hands it to `getVoteParticipation` (#510). */
	"id",
	/** Read by every one of these loaders' cross-club 404 check. */
	"clubId",
	/** The printed header's date and time range, and the deck's title slide. */
	"scheduledAt",
	/** `applyFlex`'s budget for the printed run sheet. */
	"lengthMinutes",
	/** The printed header's location chip. */
	"location",
	/** The meeting theme — printed header and title slide. */
	"theme",
	/** The Word of the Day. `/word` is a whole surface for these three. */
	"wordOfTheDay",
	"wodDefinition",
	"wodExample",
	/** Club announcements: printed on the agenda, projected on their own slide.
	 *  The column keeps the name `reminders` for history. */
	"reminders",
	/** The Table Topics Master's notes (#880), projected on the Table Topics
	 *  slide and exported to the .pptx. Shown to the room, so it belongs here. */
	"tableTopicsNotes",
] as const;

export type InRoomMeetingField = (typeof IN_ROOM_MEETING_FIELDS)[number];

/** A detail payload whose `meeting` has been narrowed to the allowlist. */
export type InRoomPayload<T extends { meeting: object }> = Omit<
	T,
	"meeting"
> & {
	meeting: Pick<T["meeting"], Extract<keyof T["meeting"], InRoomMeetingField>>;
};

/**
 * The detail payload with its `meeting` narrowed to `IN_ROOM_MEETING_FIELDS`,
 * and its `nextMeeting` (#932) narrowed to `IN_ROOM_NEXT_MEETING_FIELDS`.
 *
 * Everything else on the payload passes through: the artifacts read `slots`,
 * `officers`, `template` and the club fields, and a public payload already
 * carries no roster, plan or guest contact (`getPublicMeetingByKey` forces
 * `canManage = false`).
 *
 * A field the caller's `meeting` does not have stays ABSENT rather than
 * becoming `undefined`, so a partial fixture round-trips unchanged — and the
 * same holds for `nextMeeting` on a payload that has none.
 */
export function inRoomMeetingPayload<T extends { meeting: object }>(
	data: T,
): InRoomPayload<T> {
	const { meeting, ...rest } = data;
	const kept: Record<string, unknown> = {};
	for (const field of IN_ROOM_MEETING_FIELDS) {
		if (Object.hasOwn(meeting, field)) {
			kept[field] = (meeting as Record<string, unknown>)[field];
		}
	}
	const out: Record<string, unknown> = { ...rest, meeting: kept };
	// The next meeting rides the same payload onto all three in-room routes
	// (`/present` draws it; `/print` and `/word` carry it because they spread the
	// same object), so it is narrowed HERE, once, for all of them.
	if (Object.hasOwn(rest, "nextMeeting")) {
		out.nextMeeting = inRoomNextMeeting(
			(rest as { nextMeeting?: NextMeetingSummary | null }).nextMeeting ?? null,
		);
	}
	return out as InRoomPayload<T>;
}

/**
 * Every field of the NEXT meeting an in-room artifact may carry (#932) — the
 * "What's on tap for next meeting" slide on `/present` and in its `.pptx`.
 *
 * The same allowlist argument as `IN_ROOM_MEETING_FIELDS`, one meeting over.
 * `NextMeetingSummary` is built by a projection of its own and carries nothing
 * else today, but it rides the same dehydrated loader payload, and a field
 * added to it later reaches the wall only if someone adds it HERE on purpose.
 * Deliberately absent: the next meeting's id, its video-call link, its notes,
 * and any contact for the people named.
 */
export const IN_ROOM_NEXT_MEETING_FIELDS = [
	/** The slide's date and time line, and the Thank-You splash's. */
	"scheduledAt",
	/** On the slide's date line. */
	"location",
	/** Under the Toastmaster, when set. */
	"theme",
	/** "Meeting #57" beside the theme. */
	"meetingNumber",
	/** The sign-up QR's path — a public URL key, not an id. */
	"urlKey",
	/** The role the slide leads with, and every other role. Names only. */
	"toastmaster",
	"roles",
] as const;

/** The fields of one ROLE on the next meeting that may ship: a label and
 *  display names. No member id, no contact. */
export const IN_ROOM_NEXT_MEETING_ROLE_FIELDS = [
	"label",
	"names",
	"openCount",
] as const;

const pickRole = (r: NextMeetingRole): NextMeetingRole => ({
	label: r.label,
	names: [...r.names],
	openCount: r.openCount,
});

/**
 * The next-meeting summary narrowed to `IN_ROOM_NEXT_MEETING_FIELDS`, with each
 * role narrowed to `IN_ROOM_NEXT_MEETING_ROLE_FIELDS`. Null passes through: a
 * club with nothing scheduled after this meeting gets no slide.
 */
export function inRoomNextMeeting<N extends NextMeetingSummary>(
	next: N | null,
): N | null {
	if (!next) return null;
	return {
		scheduledAt: next.scheduledAt,
		location: next.location,
		theme: next.theme,
		meetingNumber: next.meetingNumber,
		urlKey: next.urlKey,
		toastmaster: next.toastmaster ? pickRole(next.toastmaster) : null,
		roles: next.roles.map(pickRole),
		// Typed as the input: every key above is one `NextMeetingSummary`
		// declares, so the narrowed object is a (possibly smaller) value of it.
	} as N;
}
