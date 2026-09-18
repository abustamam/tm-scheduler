export interface MeetingUpdateFormContext {
	meetingId: string;
	selfMemberId: string | null;
	/**
	 * Already-resolved wall-time string the caller decided on, or `undefined` to
	 * say nothing about the time.
	 *
	 * OPTIONAL since #772, and a caller who may not reschedule must leave it
	 * undefined rather than resubmit the stored value. Resubmitting a page-load
	 * snapshot was the old requirement and it was a trap twice over: the writer
	 * compares a sent time against a FRESH read, so a tab left open while an admin
	 * moved the meeting had its next save rejected as "Only an admin or VP
	 * Education can reschedule this meeting" — naming a permission the officer
	 * never exercised and losing the edit they did make. Omitting it cannot read
	 * as a move.
	 */
	scheduledAt?: string;
}

/**
 * Read one text input as a PATCH field (#772).
 *
 *   absent  → `undefined` — the input was not rendered, so leave the column
 *             alone. Defensive rather than exercised: the dialog renders all
 *             seven text inputs unconditionally, so only a future variant of
 *             this form that omits one would take this arm. (The field that
 *             genuinely needs it is `meetingNumber`, below, which is admin-only
 *             — and it does not come through here.)
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
	// Meeting number (#358). The same three states as the text fields above, but
	// parsed to a `number` — and its absent arm is the one that really fires,
	// because the input is admin-only and a self-serve TMOD's form has none:
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
		// Spread, so an absent time is an ABSENT KEY rather than a key holding
		// `undefined`. JSON.stringify would drop it either way, but the payload a
		// test can read then says the same thing the wire does — and "the caller
		// said nothing about the time" is the contract, so it should be visible in
		// the object.
		...(ctx.scheduledAt === undefined ? {} : { scheduledAt: ctx.scheduledAt }),
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
