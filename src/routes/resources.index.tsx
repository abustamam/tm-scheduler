import { createFileRoute, Link } from "@tanstack/react-router";
import {
	BookOpen,
	Clock,
	FileText,
	ListChecks,
	Star,
	Users,
} from "lucide-react";
import type { ComponentType } from "react";
import { ResourcesShell } from "#/components/resources/resources-shell";
import {
	type Resource,
	type ResourceIcon,
	resources,
	resourceToneGradient,
} from "#/data/resources";

const TITLE = "Toastmasters resources — GavelUp";
const DESCRIPTION =
	"What to expect at a Toastmasters meeting, what each role does, and printable role sheets.";

export const Route = createFileRoute("/resources/")({
	head: () => ({
		meta: [
			{ title: TITLE },
			{ name: "description", content: DESCRIPTION },
			{ property: "og:title", content: TITLE },
			{ property: "og:description", content: DESCRIPTION },
			{ property: "og:type", content: "website" },
		],
	}),
	component: ResourcesIndex,
});

const ICONS: Record<ResourceIcon, ComponentType<{ className?: string }>> = {
	book: BookOpen,
	clock: Clock,
	list: ListChecks,
	users: Users,
	doc: FileText,
	star: Star,
};

function ResourcesIndex() {
	return (
		<ResourcesShell>
			<div className="mb-6 pt-2">
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Toastmasters resources
				</h1>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					What to expect at a meeting, what each role does, and printable sheets
					you can bring along.
				</p>
			</div>
			<div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3.5">
				{resources.map((r) => (
					<ResourceCard key={r.slug} resource={r} />
				))}
			</div>
		</ResourcesShell>
	);
}

function ResourceCard({ resource }: { resource: Resource }) {
	const Icon = ICONS[resource.icon];
	return (
		<Link
			to="/resources/$slug"
			params={{ slug: resource.slug }}
			className="group flex flex-col gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-5 text-[var(--sea-ink)] no-underline shadow-[0_1px_0_var(--inset-glint)_inset,0_8px_20px_rgba(23,58,64,.05)] transition-all hover:-translate-y-0.5 hover:border-[var(--lagoon-deep)]"
		>
			<span
				className="flex size-10 items-center justify-center rounded-lg text-white"
				style={{ background: resourceToneGradient(resource.tone) }}
			>
				<Icon className="size-5" />
			</span>
			<div>
				<div className="text-sm leading-tight font-bold">{resource.title}</div>
				<p className="mt-1 text-xs leading-snug text-[var(--sea-ink-soft)]">
					{resource.desc}
				</p>
			</div>
		</Link>
	);
}
