// The refusal text for removing a member who is on a past agenda (#1189). It lives
// here, not in `members-logic.ts`, because the member page also reads it: that
// module imports `db` and must never reach the client bundle.

const ALTERNATIVE = "Mark them inactive instead.";

export function pastAgendaRemoveRefusal(name: string): string {
	return `${name} appears on past agendas, so removing them would blank their name there. ${ALTERNATIVE}`;
}

/** True for the refusal above, so the remove dialog can offer "Mark inactive". */
export function isPastAgendaRemoveRefusal(message: string): boolean {
	return message.endsWith(ALTERNATIVE);
}
