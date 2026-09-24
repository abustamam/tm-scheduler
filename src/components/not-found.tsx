import { Link } from "@tanstack/react-router";
import { BrandMark } from "#/components/brand-mark";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";

/**
 * The branded frame shared by the router-level status pages — this 404 and the
 * generic error page (`RouteError`, `src/components/route-error.tsx`) — so the
 * two read as one family. It takes no loader data and no session: either page
 * can render when every layout above it failed. Colours come from theme tokens
 * (`bg-background`, `text-muted-foreground`), so it follows light and dark.
 */
export function StatusScreen({
	title,
	children,
	actions,
	className,
}: {
	title: string;
	children: React.ReactNode;
	actions: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6 text-center",
				className,
			)}
		>
			<BrandMark />
			<div className="flex flex-col gap-2">
				<p className="font-semibold text-lg">{title}</p>
				<p className="text-muted-foreground text-sm">{children}</p>
			</div>
			<div className="flex flex-wrap items-center justify-center gap-3">
				{actions}
			</div>
		</div>
	);
}

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
