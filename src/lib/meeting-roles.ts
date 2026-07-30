/**
 * `role_definitions.key` for the two roles that carry a CAPABILITY: the
 * Toastmaster of the Day runs the meeting (self-serve agenda editing, ADR-0010)
 * and the Grammarian owns the Word of the Day (#296).
 *
 * The key is identity and the name is a label (#368/#445). Matching on the name
 * got all three answers wrong: a club that renamed "Toastmaster of the Day" to
 * "MC" lost self-serve editing with its key fully intact, a club that invented a
 * role called "Toastmaster Evaluator" HANDED that member the whole meeting, and
 * with two names matching, `find` picked between them arbitrarily.
 */
const TMOD_ROLE_KEY = "toastmaster_of_the_day";
const GRAMMARIAN_ROLE_KEY = "grammarian";

/** A role identified the way the rest of the app identifies one: key first, with
 *  the name as the fallback for a slot that carries no key. */
export type RoleIdentity = { roleName: string; roleKey?: string | null };

/**
 * True when a role-definition name is the Toastmaster of the Day (TMOD) role.
 * Matches the standard-template name ("Toastmaster of the Day") and the bare
 * "Toastmaster", case-insensitively — but NOT "Table Topics Master" (different
 * prefix) or the plural "Toastmasters" (no word boundary).
 *
 * NAME-ONLY, so it is the fallback rather than the rule: prefer `isTmodRole`,
 * which reads the key when there is one. This still runs for a slot whose
 * `role_definitions.key` is NULL — a club-invented role, or a standard role
 * renamed before the #368 backfill, which matched on the canonical name and so
 * left the key NULL for anything already renamed.
 */
export function isTmodRoleName(name: string): boolean {
	return /^toastmaster\b/.test(name.trim().toLowerCase());
}

/**
 * True when a role-definition name is the Grammarian role. Matches the
 * standard-template name ("Grammarian"), case-insensitively — but NOT the plural
 * "Grammarians" (no word boundary) or "Grammar". Name-only; prefer
 * `isGrammarianRole` for the same reason as `isTmodRoleName`.
 */
export function isGrammarianRoleName(name: string): boolean {
	return /^grammarian\b/.test(name.trim().toLowerCase());
}

/** The TMOD, by key where the slot has one. Mirrors `matchesRole`
 *  (agenda-runsheet.ts), which is how agenda beats have bound since #368. */
export function isTmodRole(role: RoleIdentity): boolean {
	return role.roleKey != null
		? role.roleKey === TMOD_ROLE_KEY
		: isTmodRoleName(role.roleName);
}

/** The Grammarian, by key where the slot has one. */
export function isGrammarianRole(role: RoleIdentity): boolean {
	return role.roleKey != null
		? role.roleKey === GRAMMARIAN_ROLE_KEY
		: isGrammarianRoleName(role.roleName);
}

/**
 * The one slot holding a capability role, keyed match preferred over a named one.
 *
 * Two passes rather than a single `find`, because the two kinds of match are not
 * equally trustworthy: a keyed slot IS the role, a name-matched one merely looks
 * like it. A club running both a renamed TMOD (key intact) and an invented
 * "Toastmaster Assistant" (no key) has two candidates, and a single `find` would
 * pick whichever the caller's array happened to order first — for the server that
 * is an unordered SQL result, so the answer could differ between requests.
 */
function findCapabilityRole<T extends RoleIdentity>(
	slots: T[],
	key: string,
	matchesName: (name: string) => boolean,
): T | undefined {
	return (
		slots.find((s) => s.roleKey === key) ??
		slots.find((s) => s.roleKey == null && matchesName(s.roleName))
	);
}

/** The meeting's TMOD slot, or undefined. */
export function findTmodSlot<T extends RoleIdentity>(
	slots: T[],
): T | undefined {
	return findCapabilityRole(slots, TMOD_ROLE_KEY, isTmodRoleName);
}

/** The meeting's Grammarian slot, or undefined. */
export function findGrammarianSlot<T extends RoleIdentity>(
	slots: T[],
): T | undefined {
	return findCapabilityRole(slots, GRAMMARIAN_ROLE_KEY, isGrammarianRoleName);
}

/**
 * The current member's role flags for a meeting, from its slots. Both `false`
 * when `memberId` is null (no identity holds a role). Shared by both meeting
 * surfaces so the TMOD/Grammarian derivation can't drift between them.
 */
export function deriveMeetingRoleFlags(
	slots: (RoleIdentity & { assigneeId: string | null })[],
	memberId: string | null,
): { isTmod: boolean; isGrammarian: boolean } {
	if (memberId === null) return { isTmod: false, isGrammarian: false };
	const tmod = findTmodSlot(slots)?.assigneeId ?? null;
	const gram = findGrammarianSlot(slots)?.assigneeId ?? null;
	return { isTmod: memberId === tmod, isGrammarian: memberId === gram };
}

/** Minimal role-definition shape needed to choose speaker/evaluator roles. */
export interface RoleDefLite {
	id: string;
	category: "leadership" | "speaker" | "evaluator" | "functionary";
	defaultCount: number;
	sortOrder: number;
	isSpeakerRole: boolean;
}

export interface SpeakerEvaluatorRoles {
	speakerRoleId: string;
	/** null when the club defines no evaluator-category role. */
	evaluatorRoleId: string | null;
}

/**
 * Choose the club's speaker role and the evaluator role paired with it.
 * - Speaker = the `isSpeakerRole` def (lowest `sortOrder` if several).
 * - Paired evaluator = the `category === "evaluator"` def with the highest
 *   `defaultCount` (tie → lowest `sortOrder`). In the standard template that is
 *   "Evaluator" (3) uncontested, since General Evaluator is a leadership role;
 *   the count tie-break still guards clubs that categorize their GE as an
 *   evaluator. Heuristic, not a modeled link.
 * Throws when there is no speaker role.
 */
export function pickSpeakerAndEvaluatorRoles(
	defs: RoleDefLite[],
): SpeakerEvaluatorRoles {
	const speaker = defs
		.filter((d) => d.isSpeakerRole)
		.sort((a, b) => a.sortOrder - b.sortOrder)[0];
	if (!speaker) throw new Error("This club has no speaker role.");
	const evaluator = defs
		.filter((d) => d.category === "evaluator")
		.sort(
			(a, b) => b.defaultCount - a.defaultCount || a.sortOrder - b.sortOrder,
		)[0];
	return { speakerRoleId: speaker.id, evaluatorRoleId: evaluator?.id ?? null };
}

/**
 * Role ids the generic add/remove/template-sync must skip: the speaker role and
 * its paired evaluator (both managed by the "+ Add speaker" / "− Remove speaker"
 * pair buttons). Empty when the club has no speaker role. A non-throwing
 * companion to `pickSpeakerAndEvaluatorRoles`, reusing the same heuristic.
 */
export function pairedRoleIds(defs: RoleDefLite[]): Set<string> {
	try {
		const { speakerRoleId, evaluatorRoleId } =
			pickSpeakerAndEvaluatorRoles(defs);
		return new Set(
			evaluatorRoleId ? [speakerRoleId, evaluatorRoleId] : [speakerRoleId],
		);
	} catch {
		return new Set<string>();
	}
}
