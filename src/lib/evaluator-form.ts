// Pure, client-safe (#1163): which speaker an Evaluator is evaluating and which
// TI evaluation form to print for them. NO `#/db` here so the meeting route, the
// nudge drafts and the personal page can all import it.
//
// This is NOT a `RoleDuty` (`#/lib/role-duties`): it has no `done`, never
// suppresses a draft, and Evaluator keeps owning zero duties. It only names the
// speaker and the form.

import {
	type EvaluationResource,
	GENERIC_EVALUATION_RESOURCE,
	resolveEvaluationResources,
} from "#/lib/evaluation-resources";
import { greetingName } from "#/lib/person-name";

export interface EvaluatorFormBrief {
	/** The speaker's greeting name (preferred name, else first token). */
	speaker: string;
	/** The project's forms, or the generic one. A tuple, so `resources[0]` is
	 *  typed present: the draft links it. */
	resources: readonly [EvaluationResource, ...EvaluationResource[]];
	/** True when the project is absent, TBA or unknown. */
	isGenericFallback: boolean;
}

/**
 * The brief for one evaluator, or null when no speaker is set: a null target, or
 * a null/blank speaker name. The caller passes the PAIRED speaker slot's holder
 * and project, so "unpaired" and "paired to an empty slot" both arrive as null.
 */
export function evaluatorFormBrief(
	target: {
		speakerName: string | null;
		speakerPreferredName?: string | null;
		projectName?: string | null;
	} | null,
): EvaluatorFormBrief | null {
	if (!target) return null;
	const name = target.speakerName?.trim();
	if (!name) return null;
	const resolved = resolveEvaluationResources(target.projectName);
	// `resolveEvaluationResources` never returns an empty list (it falls back to
	// the generic form); this is what makes that visible to the type.
	const [first, ...rest] = resolved.resources;
	const resources: EvaluatorFormBrief["resources"] = first
		? [first, ...rest]
		: [GENERIC_EVALUATION_RESOURCE];
	const isGenericFallback = first ? resolved.isGenericFallback : true;
	return {
		speaker: greetingName({
			name,
			preferredName: target.speakerPreferredName,
		}),
		resources,
		isGenericFallback,
	};
}

/**
 * The evaluator brief keyed by MEMBER, for the attendance rail.
 *
 * FIRST slot per member wins, whatever its role, for the reason
 * `outstandingDutiesByMember` (`#/lib/nudge`) gives: the rail's draft names the
 * first slot's role. If that first slot is not a paired evaluator the member
 * gets NO entry, even when a later slot is one; otherwise the sentence would
 * name one role and describe another. A `Map`, so an unknown key fails closed.
 */
export function evaluatingByMember(
	slots: readonly {
		assigneeId: string | null;
		evaluates?: {
			speakerName: string | null;
			speakerPreferredName?: string | null;
			projectName?: string | null;
		} | null;
	}[],
): ReadonlyMap<string, EvaluatorFormBrief> {
	const seen = new Set<string>();
	const byMember = new Map<string, EvaluatorFormBrief>();
	for (const slot of slots) {
		if (!slot.assigneeId || seen.has(slot.assigneeId)) continue;
		seen.add(slot.assigneeId);
		const brief = evaluatorFormBrief(slot.evaluates ?? null);
		if (brief) byMember.set(slot.assigneeId, brief);
	}
	return byMember;
}
