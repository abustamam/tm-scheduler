import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeft, Download } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ResourcesShell } from "#/components/resources/resources-shell";
import { Button } from "#/components/ui/button";
import { getResourceMarkdown } from "#/data/resource-content";
import { resourceBySlug } from "#/data/resources";

export const Route = createFileRoute("/resources/$slug")({
	loader: ({ params }) => {
		const resource = resourceBySlug(params.slug);
		const markdown = getResourceMarkdown(params.slug);
		if (!resource || !markdown) throw notFound();
		return { resource, markdown };
	},
	head: ({ params }) => {
		const resource = resourceBySlug(params.slug);
		const title = resource
			? `${resource.title} — GavelUp`
			: "Resource — GavelUp";
		return {
			meta: [{ title }, { name: "description", content: resource?.desc ?? "" }],
		};
	},
	component: ResourceArticle,
});

function ResourceArticle() {
	const { resource, markdown } = Route.useLoaderData();
	return (
		<ResourcesShell>
			<Link
				to="/resources"
				className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-[var(--lagoon-deep)] no-underline hover:underline"
			>
				<ArrowLeft className="size-4" />
				All resources
			</Link>
			<article className="prose-gavelup mt-4">
				<ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
			</article>
			{resource.downloads?.length ? (
				<section className="mt-8 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-5">
					<h2 className="font-display text-lg font-semibold">
						Printable role sheets
					</h2>
					<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
						Blank forms to print and fill in by hand.
					</p>
					<div className="mt-3 flex flex-wrap gap-2">
						{resource.downloads.map((d) => (
							<Button key={d.href} asChild variant="outline" size="sm">
								<a href={d.href} download>
									<Download className="size-4" />
									{d.label}
								</a>
							</Button>
						))}
					</div>
				</section>
			) : null}
		</ResourcesShell>
	);
}
