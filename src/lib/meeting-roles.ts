/**
 * True when a role-definition name is the Toastmaster of the Day (TMOD) role.
 * Matches the standard-template name ("Toastmaster of the Day") and the bare
 * "Toastmaster", case-insensitively — but NOT "Table Topics Master" (different
 * prefix) or the plural "Toastmasters" (no word boundary). This is how the app
 * identifies the meeting's TMOD slot for self-serve editing (ADR-0010).
 */
export function isTmodRoleName(name: string): boolean {
	return /^toastmaster\b/.test(name.trim().toLowerCase());
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
