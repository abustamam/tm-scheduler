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
 * The detail payload with its `meeting` narrowed to `IN_ROOM_MEETING_FIELDS`.
 *
 * Everything else on the payload passes through: the artifacts read `slots`,
 * `officers`, `template` and the club fields, and a public payload already
 * carries no roster, plan or guest contact (`getPublicMeetingByKey` forces
 * `canManage = false`).
 *
 * A field the caller's `meeting` does not have stays ABSENT rather than
 * becoming `undefined`, so a partial fixture round-trips unchanged.
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
	return { ...rest, meeting: kept } as InRoomPayload<T>;
}
