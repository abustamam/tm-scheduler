/**
 * The payload a ONE-FIELD meeting-meta editor has to send (#666).
 *
 * ## `updateMeeting` is a full REPLACE, and that is the whole reason this exists
 *
 * `applyMeetingUpdate` writes `theme: input.theme?.trim() || null` — and the
 * identical line for `location`, `wordOfTheDay`, `wodDefinition`, `wodExample`,
 * `notes` and `reminders`. An OMITTED field is therefore not "leave it alone",
 * it is **null it**. The existing "Edit meeting" dialog never notices, because
 * it prefills every one of those inputs from the stored row and resubmits the
 * lot; a focused editor that posts `{ meetingId, scheduledAt, theme }` and
 * nothing else silently erases the club's location, its Word of the Day, its
 * announcements and the organizer's notes, and the only visible consequence is
 * a theme appearing. Nothing throws, and nothing else on the page changes until
 * the next reload.
 *
 * So the round trip is a REQUIREMENT of the writer, not a nicety, and it lives
 * here rather than inside a route file for the reason CODING_STANDARDS gives
 * twice: a route module imports `#/server/meetings` → `#/db` and cannot be
 * imported by vitest at all, so an expression there is guarded by a source grep
 * and nothing else. `meeting-meta-update.test.ts` asserts the preservation
 * directly, and its enrollment sweep — which reads the field list off
 * `updateMeetingSchema` itself — fails if that schema ever grows a field this
 * echo does not carry.
 *
 * Two fields are deliberately NOT echoed, because for them omission really does
 * mean "leave it alone" — `applyMeetingUpdate` falls back to the stored value
 * rather than to null:
 *
 *   - `lengthMinutes` — `input.lengthMinutes != null ? … : meeting.lengthMinutes`
 *   - `meetingNumber` — `input.meetingNumber === undefined ? meeting.meetingNumber : …`
 *
 * Echoing them would be harmless but would also invite the reader to assume the
 * others are optional in the same way. They are not.
 *
 * `scheduledAt` is the third exception and the one with teeth: it is REQUIRED by
 * the schema and has no stored-value fallback, so a focused editor must resubmit
 * the meeting's current wall time. A self-serve TMOD carries `canReschedule =
 * false`, and `applyMeetingUpdate` compares the resubmitted value against the
 * stored one TO THE MINUTE — so the caller must pass exactly what
 * `utcToZonedWallTime(meeting.scheduledAt, club.timezone)` produces, which is
 * minute-precision and round-trips. Passing anything else does not fail
 * validation; it is rejected as an attempted reschedule.
 */

/**
 * The meta fields a partial edit must carry back unchanged. Nullable because
 * that is how the columns come off the row — the caller passes the stored value
 * straight through, blanks included.
 *
 * `notes` rides along even though no `/me/` surface DISPLAYS it: this is an echo
 * of what is stored, not a payload the reader is shown, and leaving it out is
 * precisely the bug the module header describes. It is already on every payload
 * `loadMeetingDetail` returns, so carrying it here discloses nothing new.
 */
export interface MeetingMetaEcho {
	location: string | null;
	wordOfTheDay: string | null;
	wodDefinition: string | null;
	wodExample: string | null;
	notes: string | null;
	reminders: string | null;
}

/**
 * Blank → `undefined`, matching `meetingUpdateFromForm`'s treatment of an empty
 * input: the server normalizes both to null, and sending `""` through the
 * truncating validators is a pointless round trip. Whitespace-only counts as
 * blank for the same reason `isFilled` says so in the duty registry.
 */
const echo = (value: string | null | undefined): string | undefined =>
	value?.trim() ? value : undefined;

export interface ThemeOnlyUpdateInput {
	/** The RESOLVED meeting uuid — never the `$meetingId` URL segment, which is a
	 *  club-local date key that `updateMeetingSchema`'s `z.string().uuid()`
	 *  rejects. */
	meetingId: string;
	/** Self-asserted roster member id, or null for a signed-in admin. */
	selfMemberId: string | null;
	/** The meeting's CURRENT wall time in the club's timezone, exactly as
	 *  `utcToZonedWallTime` renders it — see the module header. */
	scheduledAt: string;
	/** The new theme. Blank clears it, which is a legitimate edit. */
	theme: string;
	/** Everything else the writer would otherwise null. */
	current: MeetingMetaEcho;
}

/**
 * Build the `updateMeeting` payload for a theme-only edit: the new theme, plus
 * every other free-text field echoed back so the full-replace writer leaves it
 * where it was.
 */
export function themeOnlyUpdate(input: ThemeOnlyUpdateInput) {
	return {
		meetingId: input.meetingId,
		selfMemberId: input.selfMemberId,
		scheduledAt: input.scheduledAt,
		theme: echo(input.theme),
		location: echo(input.current.location),
		wordOfTheDay: echo(input.current.wordOfTheDay),
		wodDefinition: echo(input.current.wodDefinition),
		wodExample: echo(input.current.wodExample),
		notes: echo(input.current.notes),
		reminders: echo(input.current.reminders),
	};
}
