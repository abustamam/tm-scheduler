import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

/**
 * The GENERIC guest-facing articles. Slugs live in `src/data/resources.ts`.
 *
 * "Meeting roles" is deliberately NOT in this list — see `GuestResources`.
 */
export const GUEST_LINKS: { slug: string; label: string }[] = [
	{ slug: "what-to-expect", label: "What to expect" },
	{ slug: "guest-faq", label: "First-time guest FAQ" },
];

/**
 * Compact "New to Toastmasters?" strip shown on both public club surfaces (spec
 * decision #4).
 *
 * Club-aware since #318. The generic articles above stay generic — they are the
 * only search-indexable surface in the product, since every `/club/$clubId/*`
 * route is `noindex, nofollow` via the shell. But "Meeting roles" now points at
 * `/club/$clubId/roles-guide`, which lists THIS club's roles and
 * responsibilities rather than a generic article about roles in the abstract.
 * Before #318 a guest standing on a club's own page was routed away from the
 * page describing that club's actual roles.
 *
 * `clubId` is required rather than optional: both call sites are already
 * club-scoped (the public club page and the public meeting agenda), so there is
 * no context where this strip renders without a club and no generic fallback to
 * maintain. Making it required means a future call site cannot silently
 * regress to the generic link.
 */
export function GuestResources({ clubId }: { clubId: string }) {
	return (
		<section className="rounded-xl border border-[var(--line)] bg-card p-4">
			<h2 className="text-sm font-semibold text-foreground">
				New to Toastmasters?
			</h2>
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
				<li>
					<Link
						to="/club/$clubId/roles-guide"
						params={{ clubId }}
						className="inline-flex items-center gap-1 text-sm font-medium text-[var(--lagoon-deep)] no-underline hover:underline"
					>
						Meeting roles
						<ArrowRight className="size-3.5" aria-hidden />
					</Link>
				</li>
			</ul>
		</section>
	);
}
