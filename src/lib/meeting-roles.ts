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
 *
 * EXPORTED rather than private since #660, because the role duty registry
 * (`#/lib/role-duties`) keys its pre-meeting duties off the same two of them
 * and imports them rather than redeclaring them — a second copy of a role key
 * in a second file is the drift that caused both failures above.
 *
 * That is a claim about the duty registry ONLY, and deliberately not about the
 * codebase: `agenda-slides.ts`, `agenda-runsheet.ts` and `meeting-packet.ts`
 * still carry their own literals of these keys. Consolidating them is real
 * work on three heavily-imported render modules, recorded in TODOS.md rather
 * than smuggled into #660. So this export is where a new reader SHOULD come,
 * not proof that every existing one already does.
 *
 * `VOTE_COUNTER_ROLE_KEY` has no importer yet and is exported for symmetry:
 * the three keys are one set under one comment, and exporting two of them
 * would invite the next reader to re-privatise the odd one out.
 */
export const TMOD_ROLE_KEY = "toastmaster_of_the_day";
export const GRAMMARIAN_ROLE_KEY = "grammarian";
export const VOTE_COUNTER_ROLE_KEY = "vote_counter";

/**
 * `role_definitions.key` for the Timer, kept OUT of the three above because it
 * is not a capability (#732).
 *
 * The other three decide who may DO something — edit the agenda, own the Word
 * of the Day, run the votes. Nothing is granted by holding the Timer; the key
 * is here because the Timer is the role two other surfaces have to name, and
 * naming it by string is the #464 failure shape. Resolve a SLOT through
 * `findTimerSlot` below rather than comparing to this constant by hand: the
 * key is only half the answer, and the other half is the order it is asked in.
 *
 * Five modules still spell `"timer"` as a bare literal —
 * `src/server/packet-pdf-logic.ts`, `src/lib/agenda-slides.ts`,
 * `src/lib/meeting-packet.ts`, `src/data/role-sheets.ts` and
 * `src/lib/agenda.ts`. This export does NOT claim to have replaced them; same
 * standing caveat the block above states for its own three keys, and this is
 * where a new reader should come, not proof that every existing one already
 * does. (`src/lib/role-template.ts` is the canonical seed declaration, which
 * is the source, not an offender.)
 *
 * Separate const rather than a fourth entry in that group so the group's
 * comment stays true. A reader who needs "may this member run the votes"
 * should not find a role that answers no such question sitting in the list.
 */
export const TIMER_ROLE_KEY = "timer";

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
/** Exactly one canonical name, and exactly the seed's (`role-template.ts`).
 *  "Timekeeper" is what many clubs SAY and is deliberately not here: it is not
 *  the name this app ships, so a role called that was invented by a club and
 *  has a NULL key for that reason, which is population 1 above. */
const TIMER_CANONICAL_NAMES = ["timer"];

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
 * True when a role-definition name is EXACTLY the Timer role's canonical name
 * (#732). NOT "Timekeeper", not "Timer Keeper", not the plural "Timers".
 *
 * NAME-ONLY, so it is the fallback rather than the rule: it runs only for a
 * slot whose `role_definitions.key` is NULL. Prefer `findTimerSlot`, which
 * reads the key when there is one — same relationship `isTmodRoleName` has to
 * `findTmodSlot`. A standard Timer renamed before the #368 backfill still has
 * to resolve; a club-invented role that merely sounds like one must not.
 *
 * Exact for the reason the canonical-name docblock above gives at length: every
 * club-invented role has a NULL key, so a prefix or substring match here would
 * hand a club's "Timer Assistant" whatever the caller is gating.
 */
export function isTimerRoleName(name: string): boolean {
	return matchesCanonical(TIMER_CANONICAL_NAMES, name);
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
 * The meeting's Timer slot, or undefined (#732).
 *
 * Reuses `findCapabilityRole` for its MECHANISM, not for its premise: the
 * Timer grants nothing, and `TIMER_ROLE_KEY`'s docblock says why it is not in
 * the capability group. What is worth reusing is the resolution ORDER — key
 * first, then the canonical names in priority order — and the array-order
 * determinism that function's docblock records as a real bug, where the same
 * meeting resolved to a different member between two requests because the
 * server's slot array is a SQL result.
 *
 * That is the whole reason this exists rather than leaving `TIMER_ROLE_KEY`
 * and `isTimerRoleName` for a caller to combine. #732 shipped the two pieces
 * and left the order to whoever assembled them, which put the load-bearing
 * half — key BEFORE name — in no shipped code at all: a caller that checked
 * the name first would hand the Timer's surface to a club-invented
 * look-alike whenever the real Timer had been renamed, and nothing would have
 * failed. One exported function is what makes the order testable.
 */
export function findTimerSlot<T extends RoleIdentity>(
	slots: T[],
): T | undefined {
	return findCapabilityRole(slots, TIMER_ROLE_KEY, TIMER_CANONICAL_NAMES);
}

/**
 * The current member's role flags for a meeting, from its slots. All `false`
 * when `memberId` is null (no identity holds a role). Shared by both meeting
 * surfaces so the TMOD/Grammarian/Vote Counter derivation can't drift between
 * them.
 */
export function deriveMeetingRoleFlags(
	slots: (RoleIdentity & { assigneeId: string | null })[],
	memberId: string | null,
): { isTmod: boolean; isGrammarian: boolean; isVoteCounter: boolean } {
	if (memberId === null)
		return { isTmod: false, isGrammarian: false, isVoteCounter: false };
	const tmod = findTmodSlot(slots)?.assigneeId ?? null;
	const gram = findGrammarianSlot(slots)?.assigneeId ?? null;
	const vote = findVoteCounterSlot(slots)?.assigneeId ?? null;
	return {
		isTmod: memberId === tmod,
		isGrammarian: memberId === gram,
		isVoteCounter: memberId === vote,
	};
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
