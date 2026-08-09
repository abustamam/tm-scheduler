/**
 * `role_definitions.key` for the three roles that carry a CAPABILITY: the
 * Toastmaster of the Day runs the meeting (self-serve agenda editing, ADR-0010),
 * the Grammarian owns the Word of the Day (#296), and the Vote Counter operates
 * the digital votes (#510).
 *
 * The key is identity and the name is a label (#368/#445). Matching on the name
 * got all three answers wrong: a club that renamed "Toastmaster of the Day" to
 * "MC" lost self-serve editing with its key fully intact, a club that invented a
 * role called "Toastmaster Evaluator" HANDED that member the whole meeting, and
 * with two names matching, `find` picked between them arbitrarily.
 */
const TMOD_ROLE_KEY = "toastmaster_of_the_day";
const GRAMMARIAN_ROLE_KEY = "grammarian";
const VOTE_COUNTER_ROLE_KEY = "vote_counter";

/** A role identified the way the rest of the app identifies one: key first, with
 *  the name as the fallback for a slot that carries no key. */
export type RoleIdentity = { roleName: string; roleKey?: string | null };

/**
 * The name fallback matches the CANONICAL names EXACTLY (trimmed, case-folded),
 * never a prefix.
 *
 * A prefix match is unsafe here because of what actually carries a NULL key.
 * `createClubRole` (role-definitions-logic.ts) never writes one, so EVERY
 * club-invented role has `key = NULL` — and `/^toastmaster\b/` matched
 * "Toastmaster Assistant", "Toastmaster Evaluator", "Toastmaster's Helper".
 * Keying off `role_definitions.key` alone did not close that, because those rows
 * fall through to exactly this fallback (#464).
 *
 * Narrowing costs nothing here, and that is a settled question rather than an
 * optimistic one. A key is NULL for exactly two populations:
 *
 *   1. Club-invented roles — `createClubRole` never writes one. These SHOULD be
 *      denied the capability; denying them is the point.
 *   2. Standard roles already renamed when `drizzle/0044` ran, since it
 *      backfilled by exact canonical name.
 *
 * Population 2 is empty (confirmed with the club owner: nothing was ever
 * renamed), and it cannot grow — `applyRoleDefinitionUpdate` never touches
 * `key`, so every rename from here carries its key and resolves by (1) above.
 *
 * So the fallback protects nobody and exists only to reject look-alikes. If a
 * club ever DOES turn up with a key-NULL standard role, the fix is to backfill
 * its key, never to widen this back to a prefix match — that is the exact hole
 * #464 closed.
 */
const TMOD_CANONICAL_NAMES = ["toastmaster of the day", "toastmaster"];
const GRAMMARIAN_CANONICAL_NAMES = ["grammarian"];
const VOTE_COUNTER_CANONICAL_NAMES = ["vote counter"];

const matchesCanonical = (names: string[], name: string): boolean =>
	names.includes(name.trim().toLowerCase());

/**
 * True when a role-definition name is EXACTLY the Toastmaster of the Day (TMOD)
 * role's canonical name, or the bare "Toastmaster" the standard template also
 * answers to. NOT "Table Topics Master", not "Toastmasters", and — since #464 —
 * not "Toastmaster Assistant".
 *
 * NAME-ONLY, so it is the fallback rather than the rule: it runs only for a slot
 * whose `role_definitions.key` is NULL. Prefer `findTmodSlot`, which reads the
 * key when there is one.
 */
export function isTmodRoleName(name: string): boolean {
	return matchesCanonical(TMOD_CANONICAL_NAMES, name);
}

/**
 * True when a role-definition name is EXACTLY the Grammarian role's canonical
 * name. NOT the plural "Grammarians", not "Grammar", and not "Grammarian
 * Assistant". Name-only, for the same reason as `isTmodRoleName`.
 */
export function isGrammarianRoleName(name: string): boolean {
	return matchesCanonical(GRAMMARIAN_CANONICAL_NAMES, name);
}

/**
 * The one slot holding a capability role, resolved so the answer never depends on
 * what order the caller happens to hold the slots in.
 *
 * Passes, in priority order:
 *   1. the KEY — a keyed slot IS the role; a name-matched one merely looks like
 *      it, so a renamed-but-keyed TMOD must beat an invented "Toastmaster
 *      Assistant" whichever comes first in the array.
 *   2. each canonical name in turn, MOST SPECIFIC first — "Toastmaster of the
 *      Day" before the bare "Toastmaster". Nothing stops a club having both
 *      (`role_definitions` has no unique constraint on (club_id, name) and the
 *      Add Role form posts free text), and both are canonical, so the key cannot
 *      separate them and only a stated precedence can.
 *
 * Without (2) the answer came from array order, which on the server is a SQL
 * result: the same meeting could grant a different member between two requests,
 * and the server could disagree with the button the client rendered.
 */
function findCapabilityRole<T extends RoleIdentity>(
	slots: T[],
	key: string,
	canonicalNames: string[],
): T | undefined {
	const keyed = slots.find((s) => s.roleKey === key);
	if (keyed) return keyed;
	for (const canonical of canonicalNames) {
		const named = slots.find(
			(s) => s.roleKey == null && s.roleName.trim().toLowerCase() === canonical,
		);
		if (named) return named;
	}
	return undefined;
}

/** The meeting's TMOD slot, or undefined. */
export function findTmodSlot<T extends RoleIdentity>(
	slots: T[],
): T | undefined {
	return findCapabilityRole(slots, TMOD_ROLE_KEY, TMOD_CANONICAL_NAMES);
}

/** The meeting's Grammarian slot, or undefined. */
export function findGrammarianSlot<T extends RoleIdentity>(
	slots: T[],
): T | undefined {
	return findCapabilityRole(
		slots,
		GRAMMARIAN_ROLE_KEY,
		GRAMMARIAN_CANONICAL_NAMES,
	);
}

/**
 * The meeting's Vote Counter slot, or undefined. The third capability role
 * (#510): its holder opens and closes the digital votes, sees the running
 * count, and confirms the winner.
 *
 * Same key-first construction as the other two, and the same deliberately
 * narrow name fallback — "Ballot Counter" is NOT canonical, so a club that
 * renamed the role keeps the capability through its key, while a club-invented
 * "Ballot Counter" with a NULL key is correctly denied it (#464).
 */
export function findVoteCounterSlot<T extends RoleIdentity>(
	slots: T[],
): T | undefined {
	return findCapabilityRole(
		slots,
		VOTE_COUNTER_ROLE_KEY,
		VOTE_COUNTER_CANONICAL_NAMES,
	);
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
