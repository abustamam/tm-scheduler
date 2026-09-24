import { Link } from "@tanstack/react-router";
import { StatusScreen } from "#/components/status-screen";
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
		<StatusScreen
			title="Page not found"
			actions={
				<Button asChild variant="outline">
					<Link to="/">Go home</Link>
				</Button>
			}
		>
			That page doesn't exist, or the link is out of date.
		</StatusScreen>
	);
}
