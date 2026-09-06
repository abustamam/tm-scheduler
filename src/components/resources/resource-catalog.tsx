import { Link } from "@tanstack/react-router";
import {
	BookOpen,
	Clock,
	FileText,
	ListChecks,
	Star,
	Users,
} from "lucide-react";
import { type ComponentType, useMemo, useState } from "react";
import {
	filterResourcesByCategory,
	type Resource,
	type ResourceCategory,
	type ResourceIcon,
	resources as registry,
	resourceCategories,
	resourceToneGradient,
} from "#/data/resources";
import { cn } from "#/lib/utils";

/**
 * The card grid on `/resources`, with the category filter (#313).
 *
 * A COMPONENT rather than JSX inline in `src/routes/resources.index.tsx`,
 * because a route cannot be mounted in vitest — the same reason
 * `eval-resources-search-first.guard.test.ts` had to settle for a source grep.
 * Selection behaviour, the derived option list and the empty case are all
 * things a source grep cannot see, so the filter lives where a render test can
 * drive it and the route is left with a one-line call a guard test can pin.
 *
 * Filter state is local `useState`, not a URL search param, matching the
 * sibling search on `/resources/evaluation-resources`. `items` is injectable so
 * tests can supply a registry with a different shape (a single category, none
 * at all) without editing the real one.
 */

const ICONS: Record<ResourceIcon, ComponentType<{ className?: string }>> = {
	book: BookOpen,
	clock: Clock,
	list: ListChecks,
	users: Users,
	doc: FileText,
	star: Star,
};

export function ResourceCatalog({
	items = registry,
}: {
	items?: readonly Resource[];
}) {
	const [cat, setCat] = useState<ResourceCategory | null>(null);
	const categories = useMemo(() => resourceCategories(items), [items]);
	const visible = useMemo(
		() => filterResourcesByCategory(cat, items),
		[cat, items],
	);

	// One category narrows nothing, so a chip row over it is pure cost. This is
	// also what a would-be fourth category gets for free: the row appears when
	// the registry earns it.
	const showFilter = categories.length > 1;

	return (
		<>
			{showFilter ? (
				// A group of toggles, not a tablist: there are no panels to switch
				// between, only one list that shrinks.
				//
				// <fieldset> rather than <div role="group"> because biome 2.4.5's
				// `a11y/useSemanticElements` fails the div as an ERROR, naming
				// <fieldset> as the replacement — it covers `group`, and the diagnostic
				// does not depend on having an aria-label. That is a claim about one
				// pinned linter version, so re-probe rather than inherit it:
				// `printf 'export const P = () => <div role="group" />;' > src/p.tsx &&
				// bunx biome lint src/p.tsx`. If a later biome drops `group` from the
				// mapping, a plain div is the better element here — this is a row of
				// toggle buttons, not form fields, and it carries no <legend>.
				// The accessible name comes from aria-label either way, which is what
				// getByRole("group", { name }) resolves in the test beside this.
				<fieldset
					aria-label="Filter resources by category"
					className="mb-5 flex flex-wrap gap-2"
				>
					<CategoryChip
						label="All"
						active={cat === null}
						onSelect={() => setCat(null)}
					/>
					{categories.map((c) => (
						<CategoryChip
							key={c}
							label={c}
							active={cat === c}
							onSelect={() => setCat(c)}
						/>
					))}
				</fieldset>
			) : null}

			<p className="mb-3 text-sm text-[var(--sea-ink-soft)]" aria-live="polite">
				{countLabel(visible.length, items.length)}
			</p>

			{visible.length === 0 ? (
				// Never an empty grid: `auto-fill` over no children collapses to a
				// blank band under the heading, which reads as a broken page rather
				// than as "nothing here". Only an empty `items` reaches this in
				// practice — `categories` is derived, so a category with no articles
				// never becomes a chip you could press.
				<p className="text-sm text-[var(--sea-ink-soft)]">
					Nothing to show here yet.
				</p>
			) : (
				<div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3.5">
					{visible.map((r) => (
						<ResourceCard key={r.slug} resource={r} />
					))}
				</div>
			)}
		</>
	);
}

/**
 * Exported for the render test, which asserts BOTH arms — a branch between two
 * strings is exactly the shape that survives a source grep unnoticed.
 */
export function countLabel(shown: number, total: number): string {
	const noun = total === 1 ? "resource" : "resources";
	return shown === total
		? `All ${total} ${noun}`
		: `${shown} of ${total} ${noun}`;
}

function CategoryChip({
	label,
	active,
	onSelect,
}: {
	label: string;
	active: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onSelect}
			className={cn(
				"rounded-full border px-3.5 py-1.5 text-[13px] font-semibold outline-none transition-transform active:scale-[0.97] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
				active
					? "border-[var(--sea-ink)] bg-[var(--sea-ink)] text-[var(--background)]"
					: "border-[var(--line)] bg-[var(--surface-strong)] text-[var(--sea-ink-soft)]",
			)}
		>
			{label}
		</button>
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
			<div className="flex items-center justify-between gap-2">
				<span
					className="flex size-10 items-center justify-center rounded-lg text-white"
					style={{ background: resourceToneGradient(resource.tone) }}
				>
					<Icon className="size-5" />
				</span>
				{/* The card's own category, so the chip you pressed is legible on the
				    results it produced — and so the grouping still reads once the
				    filter is back on "All". */}
				<span className="text-[10.5px] font-bold tracking-[0.05em] text-[var(--sea-ink-soft)] uppercase">
					{resource.cat}
				</span>
			</div>
			<div>
				<div className="text-sm leading-tight font-bold">{resource.title}</div>
				<p className="mt-1 text-xs leading-snug text-[var(--sea-ink-soft)]">
					{resource.desc}
				</p>
			</div>
		</Link>
	);
}
