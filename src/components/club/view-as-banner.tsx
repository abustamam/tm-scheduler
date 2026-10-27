import { Eye, X } from "lucide-react";

/**
 * "Previewing as a member" banner (#1113). Same height and slot as
 * `ImpersonationBanner` (`h-9`, sticky), so `shellStickyVars` stays one banner
 * high. Never rendered together with it: a superadmin session plus a preview is
 * ONE `ImpersonationBanner` carrying both facts.
 */
export function ViewAsBanner({ onExit }: { onExit: () => void }) {
	return (
		// success-foreground flips with the theme: white on the dark light-mode
		// palm, dark ink on the pale dark-mode palm (white there was ~2:1).
		<div className="sticky top-0 z-20 flex h-9 items-center gap-2 bg-success px-4 text-xs font-semibold text-success-foreground shadow-sm">
			<Eye className="size-3.5 shrink-0" aria-hidden />
			<span className="truncate">Previewing as a member</span>
			<button
				type="button"
				onClick={onExit}
				className="ml-auto flex shrink-0 items-center gap-1 rounded bg-white/15 px-2 py-0.5 transition-colors hover:bg-white/25"
			>
				<X className="size-3" aria-hidden /> Exit
			</button>
		</div>
	);
}
