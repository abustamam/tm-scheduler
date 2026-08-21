import { FileText } from "lucide-react";
import { resolveEvaluationResources } from "#/lib/evaluation-resources";

/**
 * Links to the official TI evaluation resource(s) for a project (#606-adjacent;
 * spec 2026-08-20). External links to toastmasters.org — nothing is hosted here.
 *
 * The colour is deliberately left alone: `src/styles.css` styles bare `a`
 * outside `@layer`, so the global link-teal rule wins over any utility class.
 * These ARE outbound links, so that is the right colour, and a `text-*` utility
 * here would silently do nothing.
 */
export function EvaluationResourceLinks({
	projectName,
	fallback = false,
}: {
	projectName: string | null | undefined;
	/**
	 * Opt in to the generic `8053` form when the project has no resource of its
	 * own. DEFAULT FALSE: `resolveEvaluationResources` always returns something,
	 * so calling it unconditionally put "Generic evaluation resource" on every
	 * functionary row of an agenda and handed a Base-Camp-ingested project the
	 * catalog lacks (Cross-Cultural Understanding, for which TI publishes 8202E)
	 * an authoritative-looking WRONG form. `evaluation-resources.ts` says
	 * `resourcesForProject` exists so the CALL SITE decides; this prop is that
	 * decision. Spec §2: "A project with no resource renders no link."
	 *
	 * Pass it where the generic form is genuinely the right answer — an evaluator
	 * paired with a TBA speech (spec §3 step 3, the reason 8053 ships at all).
	 */
	fallback?: boolean;
}) {
	const { resources, currentEditionNote, isGenericFallback } =
		resolveEvaluationResources(projectName);

	// Nothing at all, rather than a form that is not this project's.
	if (isGenericFallback && !fallback) return null;

	return (
		<div className="mt-1">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				{resources.map((r) => {
					// isGenericFallback is safe per-resource because
					// resolveEvaluationResources' fallback branch is always exactly one.
					const label = isGenericFallback
						? "Generic evaluation resource"
						: r.part
							? `Evaluation resource — ${r.part}`
							: "Evaluation resource";
					return (
						<a
							key={r.key}
							href={r.url}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1.5 text-xs"
							// The picker dialog renders one of these per project row, so up
							// to ~30 links whose visible text is the identical "Evaluation
							// resource". The project name is what tells them apart.
							aria-label={projectName ? `${label} — ${projectName}` : label}
						>
							<FileText className="size-3.5 shrink-0" aria-hidden />
							<span>{label}</span>
						</a>
					);
				})}
			</div>
			{currentEditionNote ? (
				// Its own row, not trailing the last anchor: a legacy multi-part
				// project (Evaluation and Feedback, required at Level 1 on all five
				// legacy paths) renders THREE links, and inline the caveat read as if
				// it qualified only the third.
				<p className="text-[var(--sea-ink-soft)] text-xs">
					Toastmasters publishes only the current edition of{" "}
					{resources.length > 1 ? "these forms" : "this form"}.
				</p>
			) : null}
		</div>
	);
}
