import { Link } from "@tanstack/react-router";
import { FOUNDER_BLURB } from "#/lib/brand";
import { cn } from "#/lib/utils";

/**
 * The short founder line for marketing pages (#865). Muted and small: it is a
 * credential, not a pitch. It ends in a link to `/about` (#869), where the
 * longer answer to "who is behind this" lives. The blurb keeps its own span so
 * it stays findable as exactly `FOUNDER_BLURB`.
 */
export function FounderNote({ className }: { className?: string }) {
	return (
		<p
			className={cn("text-sm leading-relaxed text-muted-foreground", className)}
		>
			<span>{FOUNDER_BLURB}</span>{" "}
			<Link
				to="/about"
				className="font-semibold text-foreground no-underline hover:underline"
			>
				More about GavelUp →
			</Link>
		</p>
	);
}
