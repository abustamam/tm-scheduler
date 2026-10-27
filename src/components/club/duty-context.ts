import type { DutyContext } from "#/lib/role-duties";
import type { PersonalMeetingView } from "#/server/personal-meeting";

/**
 * What a duty's `done` reads, for ONE held role. Shared with `/me`
 * (`personal-meeting-body.tsx`) so the two surfaces tick the same boxes.
 */
export function buildDutyContext(
	view: PersonalMeetingView,
	role: PersonalMeetingView["roles"][number],
): DutyContext {
	return {
		theme: view.meeting.theme,
		wordOfTheDay: view.meeting.wordOfTheDay,
		tableTopicsNotes: view.meeting.tableTopicsNotes,
		// Per-SLOT, never per-member: a member can hold two speaker slots and one
		// title must not tick both.
		speechTitle: role.speechTitle,
		// MEETING-scoped, unlike the line above (`role-duties.ts`'s `hasTiming`
		// docblock, #730): a timing is recorded against a SPEAKER's slot, so a
		// per-slot answer would be false for the Timer forever.
		hasTiming: view.meeting.hasTiming,
	};
}
