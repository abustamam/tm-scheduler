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
}: {
	projectName: string | null | undefined;
}) {
	const { resources, currentEditionNote, isGenericFallback } =
		resolveEvaluationResources(projectName);

	return (
		<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
			{resources.map((r) => (
				<a
					key={r.key}
					href={r.url}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-1.5 text-xs"
				>
					<FileText className="size-3.5 shrink-0" aria-hidden />
					<span>
						{/* isGenericFallback is safe per-resource because resolveEvaluationResources' fallback branch is always exactly one resource. */}
						{isGenericFallback
							? "Generic evaluation resource"
							: r.part
								? `Evaluation resource — ${r.part}`
								: "Evaluation resource"}
					</span>
				</a>
			))}
			{currentEditionNote ? (
				<span className="text-[var(--sea-ink-soft)] text-xs">
					current edition
				</span>
			) : null}
		</div>
	);
}
