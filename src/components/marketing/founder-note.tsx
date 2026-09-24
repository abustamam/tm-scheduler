import { FOUNDER_BLURB } from "#/lib/brand";
import { cn } from "#/lib/utils";

/**
 * The short founder line for marketing pages (#865). Muted and small: it is a
 * credential, not a pitch. No link yet — the `/about` issue adds one once that
 * route exists.
 */
export function FounderNote({ className }: { className?: string }) {
	return (
		<p
			className={cn(
				"text-sm leading-relaxed text-[var(--sea-ink-soft)]",
				className,
			)}
		>
			{FOUNDER_BLURB}
		</p>
	);
}
