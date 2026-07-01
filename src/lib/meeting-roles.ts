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
 *   `defaultCount` (tie → lowest `sortOrder`). For the standard template this is
 *   "Evaluator" (3), not "General Evaluator" (1). Heuristic, not a modeled link.
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
