import { createFileRoute } from "@tanstack/react-router";
import {
	BookOpen,
	Clock,
	FileText,
	ListChecks,
	Star,
	Users,
} from "lucide-react";
import type { ComponentType } from "react";
import { useState } from "react";
import { PageContainer } from "#/components/page-container";
import {
	type Resource,
	type ResourceIcon,
	resourceCategories,
	resources,
	resourceToneGradient,
} from "#/data/resources";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/_authed/resources")({
	component: Resources,
});

const ICONS: Record<ResourceIcon, ComponentType<{ className?: string }>> = {
	book: BookOpen,
	clock: Clock,
	list: ListChecks,
	users: Users,
	doc: FileText,
	star: Star,
};

function Resources() {
	const [cat, setCat] = useState<(typeof resourceCategories)[number]>("all");
	const visible =
		cat === "all" ? resources : resources.filter((r) => r.cat === cat);

	return (
		<PageContainer>
			<div className="mb-5">
				<h1 className="font-display text-[30px] font-semibold tracking-[-0.02em]">
					Resources
				</h1>
				<p className="mt-[5px] text-sm text-[var(--sea-ink-soft)]">
					Everything in one place — guides, templates and references, without
					digging through Base Camp.
				</p>
			</div>

			{/* Category filters */}
			<div className="mb-5 flex flex-wrap gap-2">
				{resourceCategories.map((k) => (
					<button
						key={k}
						type="button"
						onClick={() => setCat(k)}
						className={cn(
							"rounded-full border px-[13px] py-[7px] text-[13px] font-semibold transition-transform active:scale-[0.97]",
							cat === k
								? "border-[var(--sea-ink)] bg-[var(--sea-ink)] text-[var(--background)]"
								: "border-[var(--line)] bg-[var(--surface-strong)] text-[var(--sea-ink-soft)]",
						)}
					>
						{k === "all" ? "All" : k}
					</button>
				))}
			</div>

			{/* Card grid */}
			<div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3.5">
				{visible.map((r) => (
					<ResourceCard key={r.title} resource={r} />
				))}
			</div>
		</PageContainer>
	);
}

function ResourceCard({ resource }: { resource: Resource }) {
	const Icon = ICONS[resource.icon];
	return (
		<button
			type="button"
			className="group flex flex-col gap-[11px] rounded-[15px] border border-[var(--line)] bg-[var(--surface-strong)] p-[18px] text-left shadow-[0_1px_0_var(--inset-glint)_inset,0_8px_20px_rgba(23,58,64,.05)] transition-all hover:-translate-y-0.5 hover:border-[var(--lagoon-deep)]"
		>
			<div className="flex items-center justify-between">
				<span
					className="flex size-10 items-center justify-center rounded-[11px] text-white"
					style={{ background: resourceToneGradient(resource.tone) }}
				>
					<Icon className="size-[19px]" />
				</span>
				<span className="text-[10.5px] font-bold tracking-[0.05em] text-[var(--sea-ink-soft)] uppercase">
					{resource.cat}
				</span>
			</div>
			<div>
				<div className="text-[15px] leading-tight font-bold">
					{resource.title}
				</div>
				<p className="mt-[5px] text-[12.5px] leading-snug text-[var(--sea-ink-soft)]">
					{resource.desc}
				</p>
			</div>
			<div className="mt-auto inline-flex items-center gap-[5px] text-[12.5px] font-bold text-[var(--lagoon-deep)] opacity-85 transition-opacity group-hover:opacity-100">
				Open
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<title>Open</title>
					<path d="M7 17 17 7M9 7h8v8" />
				</svg>
			</div>
		</button>
	);
}
