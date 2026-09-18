export interface MeetingUpdateFormContext {
	meetingId: string;
	selfMemberId: string | null;
	/** Already-resolved wall-time string the caller decided on. */
	scheduledAt: string;
}

/**
 * Read one text input as a PATCH field (#772).
 *
 *   absent  → `undefined` — the input was not rendered, so leave the column
 *             alone. `meetingNumber` is admin-only, and a self-serve TMOD's save
 *             must not wipe the club's number.
 *   blank   → `null` — the officer cleared the input, which is an edit.
 *   a value → trimmed.
 *
 * The blank arm is the one that matters. `applyMeetingMetaPatch` leaves an
 * omitted field alone, so a blanked input arriving as `undefined` would make
 * this dialog — the only surface that can clear these fields — silently keep the
 * old value and report success. Under the full-REPLACE writer this returned
 * `undefined` for blank and the server nulled it; that is exactly the coupling
 * #772 removed, and it has to be undone HERE in the same change.
 */
const patchField = (
	form: FormData,
	name: string,
): string | null | undefined => {
	const raw = form.get(name);
	if (raw == null) return undefined;
	return String(raw).trim() || null;
};

/**
 * Build the `updateMeeting` payload from the "Edit meeting" form. Pure so it can
 * be unit-tested without rendering the Radix dialog. Every text field is a patch
 * field — see `patchField`.
 */
export function meetingUpdateFromForm(
	form: FormData,
	ctx: MeetingUpdateFormContext,
) {
	const lengthRaw = String(form.get("lengthMinutes") ?? "").trim();
	// Meeting number (#358). Three distinct states, unlike the text fields:
	//   absent  → undefined — the input wasn't rendered (the number is admin-only,
	//             so a self-serve TMOD's save must leave it untouched)
	//   blank   → null — the admin cleared it, handing the meeting back to
	//             automatic (derived) numbering
	//   a value → that number, stored as the anchor
	const numberField = form.get("meetingNumber");
	const numberRaw = numberField == null ? null : String(numberField).trim();
	return {
		meetingId: ctx.meetingId,
		selfMemberId: ctx.selfMemberId,
		scheduledAt: ctx.scheduledAt,
		lengthMinutes: lengthRaw ? Number(lengthRaw) : undefined,
		meetingNumber:
			numberRaw === null ? undefined : numberRaw ? Number(numberRaw) : null,
		theme: patchField(form, "theme"),
		location: patchField(form, "location"),
		wordOfTheDay: patchField(form, "wordOfTheDay"),
		wodDefinition: patchField(form, "wodDefinition"),
		wodExample: patchField(form, "wodExample"),
		notes: patchField(form, "notes"),
		reminders: patchField(form, "reminders"),
	};
}
