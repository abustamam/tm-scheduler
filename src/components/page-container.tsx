import type { ReactNode } from "react";
import { cn } from "#/lib/utils";

/**
 * Shared page shell for the _authed workspace routes. Caps the content width
 * and applies the standard gutters so every page lines up under the sidebar
 * and header. Pass extra classes (e.g. `space-y-4`) via `className`.
 *
 * Deliberately a per-page opt-in component rather than padding baked into the
 * `_authed` shell: some routes (season grid, print/full-bleed) need to escape
 * the max-width cap, and the shell has no way to know which.
 */
export function PageContainer({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}) {
	return (
		<div className={cn("max-w-[1180px] px-7 pt-[26px] pb-10", className)}>
			{children}
		</div>
	);
}
