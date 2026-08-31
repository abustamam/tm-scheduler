// src/lib/agenda-materialise.ts
import { type Beat, buildRunOfShow, type RoleGroup } from "./agenda-runsheet";
import type { TemplateBeatSeed } from "./agenda-template-rows";

/**
 * Turn the code-derived run of show into rows a club can edit.
 *
 * ```
 * buildRunOfShow({ geIntroducesFunctionaries })   the CLUB's variant
 *         |  22 beats, or 23 on the GE variant
 *         v
 *   drop the gating   <- D1: a row stays until deleted, so the gate is
 *         |               evaluated ONCE, here, and never again
 *         v
 *   open five bands (D2)
 *         |  + 5 section rows
 *         v
 *   Beat -> TemplateBeatSeed
 *         |  detail tokens VERBATIM (D7), handoff carried (D8)
 *         v
 *   TemplateBeatSeed[]
 * ```
 *
 * Pure and `#/db`-free on purpose: the golden band tables in
 * `agenda-materialise.test.ts` are the acceptance criteria for this module, and
 * a `createServerFn` handler body is unreachable from vitest.
 */

/** The five bands, in the order they open. Spec D2. */
export const BAND_LABELS = [
	"OPENING",
	"SPEECHES",
	"TABLE TOPICS",
	"EVALUATIONS",
	"CLOSING",
] as const;

/**
 * The index, in the original beat list, of the beat each band opens on.
 *
 * Derived structurally rather than hardcoded, because the two variants differ
 * by one beat and the GE opening pair shifts everything after it. Only five
 * beats carry a stable `id`, so the hand-off that introduces each segment is
 * the reliable marker for the rest.
 */
function bandOpensAt(beats: Beat[]): number[] {
	const geOpening = beats.findIndex((b) => b.id === "geOpeningHandoff");
	const handoffs = beats.flatMap((b, i) => (b.handoff === true ? [i] : []));
	// SPEECHES opens on the first hand-off AFTER the GE opening pair (which is
	// itself a hand-off on that variant, hence the skip).
	const speeches = handoffs.find((i) => i > geOpening) ?? 0;
	// TABLE TOPICS opens on the next hand-off, the one introducing the TTM.
	const tableTopics = handoffs.find((i) => i > speeches) ?? 0;
	// EVALUATIONS is the one boundary with a stable id.
	const evaluations = beats.findIndex((b) => b.id === "geEvaluationHandoff");
	// CLOSING opens on the awards beat, immediately after the general evaluation.
	const closing = beats.findIndex((b) => b.id === "generalEvaluation") + 1;
	return [0, speeches, tableTopics, evaluations, closing];
}

export function materialiseRunOfShow(
	geIntroducesFunctionaries: boolean,
): TemplateBeatSeed[] {
	// NOT the `RUN_OF_SHOW` const — that is this call with the variant frozen
	// `false`, so reading it gives every club the 22-beat sheet and silently
	// drops MCF's `geOpeningHandoff`. Spec R5.
	const beats = buildRunOfShow({ geIntroducesFunctionaries });
	const opensAt = bandOpensAt(beats);

	const out: TemplateBeatSeed[] = [];
	let band = 0;
	beats.forEach((beat, i) => {
		while (band < opensAt.length && opensAt[band] === i) {
			out.push(sectionSeed(BAND_LABELS[band] as string, out.length));
			band += 1;
		}
		out.push(beatSeed(beat, out.length));
	});
	return out;
}

function sectionSeed(label: string, sortOrder: number): TemplateBeatSeed {
	return {
		sortOrder,
		kind: "section",
		label,
		detail: null,
		minutes: 0,
		roleKey: null,
		repeatsRoleKey: null,
		flex: false,
		handoff: false,
		markGreen: null,
		markYellow: null,
		markRed: null,
	};
}

function beatSeed(beat: Beat, sortOrder: number): TemplateBeatSeed {
	const isRole = beat.kind === "role";
	// A speaker or evaluator beat fans out across every matching slot, which is
	// what `repeatsRoleKey` means in the template model. Materialising it as a
	// literal row instead would give a three-speaker meeting ONE speech.
	const repeats =
		isRole && (beat.role === "speaker" || beat.role === "evaluator")
			? beat.roleKey
			: null;
	const marks = isRole ? beat.marks : null;
	return {
		sortOrder,
		kind: beat.kind,
		label: isRole ? beat.roleName : beat.who,
		detail: qualifyRolesToken(beat) || null,
		minutes: beat.minutes,
		roleKey: isRole ? beat.roleKey : null,
		repeatsRoleKey: repeats,
		flex: beat.flex === true,
		handoff: beat.handoff === true,
		markGreen: marks?.green ?? null,
		markYellow: marks?.yellow ?? null,
		markRed: marks?.red ?? null,
	};
}

/**
 * Rewrite a bare `{roles}` into `{roles:<group>}`.
 *
 * The token resolves through the beat's `requiresGroup` today, and a
 * materialised row has no gating fields (D1). Putting the group INSIDE the
 * token keeps the list dynamic — it still names whoever holds those roles that
 * week — without a column and without reviving the gate.
 */
function qualifyRolesToken(beat: Beat): string {
	const group: RoleGroup | undefined = beat.requiresGroup;
	if (group == null) return beat.detail;
	return beat.detail.replaceAll("{roles}", `{roles:${group}}`);
}
