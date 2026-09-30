/**
 * The sentences the club default agenda (#910) says in more than one place.
 *
 * Client-safe and `#/db`-free, so the server's refusal and the page that
 * explains the same rule import ONE string: a rule worded twice is a rule that
 * reads differently depending on where it is met.
 */

/**
 * Why the General Evaluator checkbox is locked while the club has a default
 * agenda (spec D5): the club settings page shows it beside the disabled
 * checkbox, and `updateClubAgendaSettings` refuses a change with it.
 */
export const GE_LOCKED_MESSAGE =
	"Your club uses its own default agenda. Change the General Evaluator's introduction there.";

/** Adopting's one-way trade, verbatim from spec R1. The confirm dialog shows
 *  it before anything is written. */
export const ADOPT_NOTICE =
	"From now on this agenda is yours. Improvements we ship to the standard agenda will not reach it.";

/** The Agendas page has no editor (spec Q4 / D14); this is where editing is. */
export const EDIT_THROUGH_MEETING =
	"Open a meeting's agenda, change it, then Save as club template.";
