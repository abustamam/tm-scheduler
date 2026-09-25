import { Link } from "@tanstack/react-router";
import { PILOT_PRICING_LINE } from "#/lib/brand";
import { cn } from "#/lib/utils";

/**
 * The "this could be your club" card for readers who are not customers yet
 * (#870, #610's original ask). `ResourcesShell` renders it under every public
 * article, in its non-app-shell branch only.
 *
 * Copy rule (#610): say what GavelUp does, never characterise alternatives or
 * TI's own tooling. `marketing-cta.test.tsx` bans the words that drift there.
 */
export function MarketingCta({ className }: { className?: string }) {
	return (
		<aside
			aria-label="GavelUp for your club"
			className={cn(
				"rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-6 sm:p-8",
				className,
			)}
		>
			<h2 className="font-display text-2xl font-semibold tracking-[-0.02em]">
				Your club could run its meetings here.
			</h2>
			<p className="mt-2 max-w-2xl text-base leading-relaxed text-[var(--sea-ink-soft)]">
				Members claim roles from one shared sheet with no account, and the
				agenda prints and projects itself.
			</p>
			<div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2">
				<Link
					to="/tour"
					className="font-semibold text-[var(--sea-ink)] no-underline hover:underline"
				>
					See how it works →
				</Link>
				<Link
					to="/districts"
					className="text-sm font-semibold text-[var(--sea-ink-soft)] no-underline hover:underline"
				>
					Running a district? →
				</Link>
			</div>
			<p className="mt-4 text-xs text-[var(--sea-ink-soft)]">
				{PILOT_PRICING_LINE}
			</p>
		</aside>
	);
}
