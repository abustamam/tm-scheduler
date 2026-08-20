import { createFileRoute } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ResourcesShell } from "#/components/resources/resources-shell";
import { Input } from "#/components/ui/input";
import { getResourceMarkdown } from "#/data/resource-content";
import {
	EVALUATION_RESOURCES,
	filterEvaluationResources,
} from "#/lib/evaluation-resources";
import { getAuthContext } from "#/server/auth-context";

const TITLE = "Evaluation resources — GavelUp";
const DESCRIPTION =
	"Every official Toastmasters evaluation resource, searchable by project name or item number.";

/**
 * The article registered for this slug in `src/data/resources.ts`, rendered HERE
 * because this static route WINS over `resources.$slug` — so
 * `content/resources/evaluation-resources.md` was reachable from no URL at all
 * and its 26 lines of public prose, including the instruction on how to search
 * this very page, rendered nowhere. Bundled at build time by
 * `resource-content.ts` (Vite `?raw` glob), so this is a constant, not I/O.
 */
const ARTICLE = getResourceMarkdown("evaluation-resources") ?? "";

export const Route = createFileRoute("/resources/evaluation-resources")({
	// Mirrors resources.index.tsx: a signed-in member with a club gets the app
	// shell, an anonymous visitor the light header.
	beforeLoad: async () => {
		const ctx = await getAuthContext();
		const shell = !!ctx.user && ctx.clubs.length > 0;
		return { shell, authCtx: shell ? ctx : null };
	},
	head: () => ({
		meta: [
			{ title: TITLE },
			{ name: "description", content: DESCRIPTION },
			{ property: "og:title", content: TITLE },
			{ property: "og:description", content: DESCRIPTION },
			{ property: "og:type", content: "website" },
		],
	}),
	component: EvaluationResourcesIndex,
});

function EvaluationResourcesIndex() {
	const { shell, authCtx } = Route.useRouteContext();
	const [query, setQuery] = useState("");
	const results = useMemo(() => filterEvaluationResources(query), [query]);

	return (
		<ResourcesShell shell={shell} authCtx={authCtx}>
			{/* Heading + ONE line, then straight to the search box. The registered
			    article renders BELOW the results, not here: rendering its four
			    headings above the box put the box at y=1146 on a 375x812 phone —
			    334px below the fold — and looking a form up on a phone mid-meeting
			    is the whole point of this page. Prose is context; the search is the
			    tool. Found by /qa 2026-08-20. */}
			<div className="mb-4 pt-2">
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Evaluation resources
				</h1>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					The official evaluation form for every Pathways project. Search by
					project name or item number.
				</p>
			</div>

			<Input
				type="search"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				placeholder="Search projects, item numbers…"
				aria-label="Search evaluation resources"
				className="mb-4 max-w-md"
			/>

			<p className="mb-3 text-[var(--sea-ink-soft)] text-sm" aria-live="polite">
				{results.length} of {EVALUATION_RESOURCES.length}
			</p>

			{results.length === 0 ? (
				<p className="text-[var(--sea-ink-soft)] text-sm">
					Nothing matches “{query}”. Try a project name or an item number like
					8200E.
				</p>
			) : (
				<ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3.5">
					{results.map((r) => (
						<li
							key={r.key}
							className="rounded-xl border border-[var(--line)] bg-card p-3.5"
						>
							<a
								href={r.url}
								target="_blank"
								rel="noopener noreferrer"
								className="flex items-start gap-2 text-sm font-medium"
							>
								<FileText className="mt-0.5 size-4 shrink-0" aria-hidden />
								<span>
									{r.title}
									{r.part ? ` — ${r.part}` : ""}
								</span>
							</a>
							{r.itemCode ? (
								<p className="mt-1 pl-6 text-[var(--sea-ink-soft)] text-xs">
									Item {r.itemCode}
								</p>
							) : null}
						</li>
					))}
				</ul>
			)}

			{/* The registered article, below the tool it explains. It stands in for a
			    hand-written blurb so one copy cannot drift from the other, and it is
			    the only place this slug's prose renders — the static route wins over
			    `resources.$slug`, so without this it reaches no URL at all. */}
			<article className="prose-gavelup mt-10 border-[var(--line)] border-t pt-6">
				<ReactMarkdown remarkPlugins={[remarkGfm]}>{ARTICLE}</ReactMarkdown>
			</article>
		</ResourcesShell>
	);
}
