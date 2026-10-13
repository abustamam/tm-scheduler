/**
 * Easy-Speak role names -> GavelUp's standard roles (#1051, decision 6 of the
 * #1054 migration).
 *
 * The table is explicit on purpose. A fuzzy match would quietly fold a club's own
 * role ("Joke Master") into a standard one it only resembles, and a role slot
 * history is exactly what an import must not get wrong. Anything this table does
 * not name becomes that club's OWN role definition, listed in the preview.
 *
 * Pure and client-safe: no `#/db`. The keys on the right are the stable
 * `role_definitions.key` values of `ROLE_TEMPLATE` (`#/lib/role-template`);
 * `easy-speak-roles.test.ts` fails when one stops naming a standard role.
 */

/**
 * The part of an Easy-Speak label that names the ROLE, lowercased:
 *
 * - "1st Speaker", "2nd Evaluator": the ordinal is the slot's position, which
 *   GavelUp derives itself, so it is dropped;
 * - "Timer 2 - Online": a trailing number and the "- Online" suffix mark a second
 *   Timer seat that is on the video call, which is still a Timer slot;
 * - extra whitespace and hyphen spacing are collapsed.
 */
export function normalizeEasySpeakRoleName(label: string): string {
	return label
		.toLowerCase()
		.replace(/\s*-\s*online\s*$/u, "")
		.replace(/^\s*\d+\s*(?:st|nd|rd|th)\s+/u, "")
		.replace(/\s+\d+\s*$/u, "")
		.replace(/\s*-\s*/gu, "-")
		.replace(/\s+/gu, " ")
		.trim();
}

/**
 * Normalized Easy-Speak name -> standard role key. Every name Easy-Speak is
 * known to print for one of the nine standard roles, in either spelling it uses.
 */
export const EASY_SPEAK_ROLE_MAP: Readonly<Record<string, string>> = {
	toastmaster: "toastmaster_of_the_day",
	"toastmaster of the day": "toastmaster_of_the_day",
	"table topic master": "table_topics_master",
	"table topics master": "table_topics_master",
	"topics master": "table_topics_master",
	speaker: "speaker",
	"prepared speaker": "speaker",
	evaluator: "evaluator",
	"speech evaluator": "evaluator",
	"general evaluator": "general_evaluator",
	timer: "timer",
	"ah master": "ah_counter",
	"ah counter": "ah_counter",
	"ah-counter": "ah_counter",
	grammarian: "grammarian",
	"vote counter": "vote_counter",
};

/** The standard role key an Easy-Speak role label maps to, or null for a club's own role. */
export function standardRoleKeyFor(label: string): string | null {
	return EASY_SPEAK_ROLE_MAP[normalizeEasySpeakRoleName(label)] ?? null;
}

/**
 * The name a club-own role definition gets: the label with its ordinal, trailing
 * number and "- Online" suffix removed, in the casing Easy-Speak printed. Two
 * seats of the one role ("Timer 2 - Online" beside "Timer") share one definition.
 */
export function ownRoleDisplayName(label: string): string {
	return label
		.replace(/\s*-\s*online\s*$/iu, "")
		.replace(/^\s*\d+\s*(?:st|nd|rd|th)\s+/iu, "")
		.replace(/\s+\d+\s*$/u, "")
		.replace(/\s+/gu, " ")
		.trim();
}
