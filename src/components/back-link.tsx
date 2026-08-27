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
 * `data-slot="back-link"` is a TEST SELECTOR, not a colour opt-out. It used
 * to be one: the `a { color: var(--lagoon-deep) }` rule in `styles.css` was
 * unlayered, so it beat `text-muted-foreground` below and both call sites
 * rendered #328f97 at 3.81:1 on white — under WCAG AA. #646 moved that rule
 * into `@layer base`, where a utility beats it by layer order, so the
 * exclusion it needed is gone and the colour below now simply wins.
 * `text-link-layering.guard.test.ts` is what keeps that true.
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
