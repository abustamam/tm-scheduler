import {
	type ErrorComponentProps,
	Link,
	useParams,
	useRouter,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { StatusScreen } from "#/components/status-screen";
import { Button } from "#/components/ui/button";

/**
 * The router-level error page (`defaultErrorComponent` in `src/router.tsx`),
 * replacing TanStack Router's unstyled "Something went wrong!" and its
 * "Show Error" toggle, which put the raw message and stack in front of members
 * (#878).
 *
 * The router renders this at the boundary of the route that threw, so a failing
 * page keeps the app shell its parent layout drew; when a layout itself fails it
 * renders under the bare `__root` document instead. Either way it reads nothing
 * but router state — no loader data, no session — because the data it would
 * read is what just failed.
 *
 * It never shows `error.message`: a server-fn failure can carry SQL, ids or
 * another member's name. The error goes to the console instead — on the server
 * during SSR (where the router renders this directly, with no `onCatch` and no
 * effects), and in the browser after mount.
 *
 * A route COMPONENT that throws during SSR is the one case the server cannot
 * render this for: React has no server-side error boundaries, so the stream
 * leaves that route's Suspense boundary empty and marks it for client
 * rendering. The client then re-renders it, the boundary catches the throw,
 * and this page appears once the bundle hydrates. `route-error.test.tsx` pins
 * that round trip; a loader error, by contrast, renders here on the server.
 */
export function RouteError({ error }: ErrorComponentProps) {
	const router = useRouter();
	// `strict: false` so this works under any route; only club routes carry it.
	const { clubId } = useParams({ strict: false }) as { clubId?: string };

	if (router.isServer) console.error("[route-error]", error);
	useEffect(() => {
		console.error("[route-error]", error);
	}, [error]);

	function retry() {
		// `invalidate` alone, deliberately. It re-runs the loaders (a loader error
		// needs that), and the router keys every match's error boundary on
		// `loadedAt`, so the reload also clears a RENDER error. The `reset` prop is
		// not called: it clears the boundary while the match is still `error`, so
		// the match re-throws before the reload lands. The router also passes no
		// `reset` at all to an error it rendered during SSR.
		void router.invalidate();
	}

	return (
		<StatusScreen
			title="Something went wrong"
			className="min-h-[70svh]"
			actions={
				<>
					<Button type="button" onClick={retry}>
						Try again
					</Button>
					{/* Beside "Go home", never instead of it: when the club layout or the
					    club page itself is what failed, this link is the page that just
					    errored, and "Go home" is the only way out. */}
					{clubId ? (
						<Button asChild variant="outline">
							<Link
								to="/club/$clubId"
								params={{ clubId }}
								// Required by the club index's `validateSearch`; these are its
								// own defaults, so the link lands on the default view.
								search={{ view: "roles", count: 8 }}
							>
								Back to club
							</Link>
						</Button>
					) : null}
					<Button asChild variant="outline">
						<Link to="/">Go home</Link>
					</Button>
				</>
			}
		>
			This page couldn't load. Try again, and if it keeps happening, let a club
			officer know.
		</StatusScreen>
	);
}
