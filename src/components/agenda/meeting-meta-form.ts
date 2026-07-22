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
	return {
		meetingId: ctx.meetingId,
		actorMemberId: ctx.actorMemberId,
		selfMemberId: ctx.selfMemberId,
		scheduledAt: ctx.scheduledAt,
		lengthMinutes: lengthRaw ? Number(lengthRaw) : undefined,
		theme: String(form.get("theme") ?? "").trim() || undefined,
		location: String(form.get("location") ?? "").trim() || undefined,
		wordOfTheDay: String(form.get("wordOfTheDay") ?? "").trim() || undefined,
		wodDefinition: String(form.get("wodDefinition") ?? "").trim() || undefined,
		wodExample: String(form.get("wodExample") ?? "").trim() || undefined,
		notes: String(form.get("notes") ?? "").trim() || undefined,
		reminders: String(form.get("reminders") ?? "").trim() || undefined,
	};
}
