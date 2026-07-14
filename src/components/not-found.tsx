import { Link } from "@tanstack/react-router";
import { BrandMark } from "#/components/brand-mark";
import { Button } from "#/components/ui/button";

/**
 * The router-level 404 (`defaultNotFoundComponent` in `src/router.tsx`). Any
 * unmatched path lands here, so it must stand alone: `__root__` is a bare
 * `html`/`body` shell shared by the authed workspace, the public club shell,
 * `signin`, and the present/print views, and a logged-out user mistyping a URL
 * is not authed. Route subtrees with their own `notFoundComponent`
 * (`ClubNotFound`, `MeetingNotFound`) take precedence for their paths.
 */
export function NotFound() {
	return (
		<div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6 text-center">
			<BrandMark />
			<div className="flex flex-col gap-2">
				<p className="font-semibold text-lg">Page not found</p>
				<p className="text-muted-foreground text-sm">
					That page doesn't exist, or the link is out of date.
				</p>
			</div>
			<Button asChild variant="outline">
				<Link to="/">Go home</Link>
			</Button>
		</div>
	);
}
