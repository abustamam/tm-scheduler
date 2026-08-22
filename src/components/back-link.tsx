import { createLink } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { forwardRef } from "react";

/**
 * The "Back to …" pattern shared by every in-chrome standalone page (the
 * per-meeting agenda editor, the roles guide, …): an icon, a muted label, and
 * a foreground hover state.
 *
 * Built with `createLink` rather than a plain wrapper around `<Link>` so it
 * stays a FULLY TYPED router link — `to`/`params`/`search` are still
 * validated against the route tree at each call site, exactly as they would
 * be calling `Link` directly — while the icon, the shared classes and the
 * colour opt-out below live in one place instead of two hand-rolled copies.
 *
 * `data-slot="back-link"` opts this anchor OUT of the unlayered
 * `a:not(…) { color: var(--lagoon-deep) }` rule in `styles.css`. That rule
 * beats anything Tailwind emits into `@layer utilities`, so without the
 * exclusion `text-muted-foreground` below is silently discarded and both
 * call sites render `--lagoon-deep` (#328f97, 3.81:1 on white) instead —
 * under WCAG AA for normal text. Same shape as the `wa-phone`/`wa-email` and
 * `dropdown-menu-item` exclusions beside it in `styles.css`, and a class
 * cannot fix this: that has already failed here four times.
 * `back-link-color.guard.test.ts` pins the marker and both rules together.
 */
const BackAnchor = forwardRef<
	HTMLAnchorElement,
	React.ComponentPropsWithoutRef<"a">
>((props, ref) => (
	<a
		{...props}
		ref={ref}
		data-slot="back-link"
		className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground no-underline hover:text-foreground"
	>
		<ArrowLeft className="size-3.5" aria-hidden="true" />
		{props.children}
	</a>
));
BackAnchor.displayName = "BackAnchor";

export const BackLink = createLink(BackAnchor);
