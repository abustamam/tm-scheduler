import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

/** Slugs live in `src/data/resources.ts` — these three are the guest-facing ones. */
const GUEST_LINKS: { slug: string; label: string }[] = [
	{ slug: "what-to-expect", label: "What to expect" },
	{ slug: "guest-faq", label: "First-time guest FAQ" },
	{ slug: "meeting-roles", label: "Meeting roles" },
];

/**
 * Compact "New to Toastmasters?" strip shown on both public club surfaces (spec
 * decision #4). Generic content — no coupling to club/meeting data.
 */
export function GuestResources() {
	return (
		<section className="rounded-xl border border-[var(--line)] bg-card p-4">
			<p className="text-sm font-semibold text-foreground">
				New to Toastmasters?
			</p>
			<ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
				{GUEST_LINKS.map((r) => (
					<li key={r.slug}>
						<Link
							to="/resources/$slug"
							params={{ slug: r.slug }}
							className="inline-flex items-center gap-1 text-sm font-medium text-[var(--lagoon-deep)] no-underline hover:underline"
						>
							{r.label}
							<ArrowRight className="size-3.5" aria-hidden />
						</Link>
					</li>
				))}
			</ul>
		</section>
	);
}
