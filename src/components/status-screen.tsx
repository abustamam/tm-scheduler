import { BrandMark } from "#/components/brand-mark";
import { cn } from "#/lib/utils";

/**
 * The branded frame shared by the router-level status pages — the 404
 * (`NotFound`, `src/components/not-found.tsx`) and the generic error page
 * (`RouteError`, `src/components/route-error.tsx`) — so the two read as one
 * family. It takes no loader data and no session: either page can render when
 * every layout above it failed. Colours come from theme tokens
 * (`bg-background`, `text-muted-foreground`), so it follows light and dark.
 *
 * The body is a `<div>`, not a `<p>`, so a caller may pass block content
 * without producing invalid nesting (and a hydration warning with it).
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
				<div className="text-muted-foreground text-sm">{children}</div>
			</div>
			<div className="flex flex-wrap items-center justify-center gap-3">
				{actions}
			</div>
		</div>
	);
}
