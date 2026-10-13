// The refusal text for removing a member who is on a past agenda (#1189). It lives
// here, not in `members-logic.ts`, because the member page also reads it: that
// module imports `db` and must never reach the client bundle.

/** The closing sentence of the refusal. The builder and the matcher both read this
 *  one constant, so they cannot drift apart. */
export const PAST_AGENDA_REMOVE_ALTERNATIVE = "Mark them inactive instead.";

export function pastAgendaRemoveRefusal(name: string): string {
	return `${name} appears on past agendas, so removing them would blank their name there. ${PAST_AGENDA_REMOVE_ALTERNATIVE}`;
}

/** True for the refusal above, so the remove dialog can offer "Mark inactive". */
export function isPastAgendaRemoveRefusal(message: string): boolean {
	return message.endsWith(PAST_AGENDA_REMOVE_ALTERNATIVE);
}
