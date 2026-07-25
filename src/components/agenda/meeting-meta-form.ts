export interface MeetingUpdateFormContext {
	meetingId: string;
	actorMemberId: string | null;
	selfMemberId: string | null;
	/** Already-resolved wall-time string the caller decided on. */
	scheduledAt: string;
}

/**
 * Build the `updateMeeting` payload from the "Edit meeting" form. Pure so it can
 * be unit-tested without rendering the Radix dialog. Empty text fields become
 * `undefined`; the server (`applyMeetingUpdate`) normalizes each to `null`.
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
		actorMemberId: ctx.actorMemberId,
		selfMemberId: ctx.selfMemberId,
		scheduledAt: ctx.scheduledAt,
		lengthMinutes: lengthRaw ? Number(lengthRaw) : undefined,
		meetingNumber:
			numberRaw === null ? undefined : numberRaw ? Number(numberRaw) : null,
		theme: String(form.get("theme") ?? "").trim() || undefined,
		location: String(form.get("location") ?? "").trim() || undefined,
		wordOfTheDay: String(form.get("wordOfTheDay") ?? "").trim() || undefined,
		wodDefinition: String(form.get("wodDefinition") ?? "").trim() || undefined,
		wodExample: String(form.get("wodExample") ?? "").trim() || undefined,
		notes: String(form.get("notes") ?? "").trim() || undefined,
		reminders: String(form.get("reminders") ?? "").trim() || undefined,
	};
}
