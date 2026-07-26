import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import { cn } from "#/lib/utils";

/**
 * The TI non-affiliation disclaimer for the ANONYMOUS public surfaces (#381).
 *
 * Signed-in pages get the disclaimer from `<AppShell>`'s footer; the public
 * club surfaces — the shared sign-up sheet, a guest's meeting agenda, the guest
 * book, the role sheet — render their own lightweight chrome and so had no
 * footer at all. Those are the highest-traffic non-member surfaces in the
 * product, and precisely where an implied-endorsement reading would arise.
 *
 * Same treatment as the `AppShell` / `no-club-screen` footers: small, muted,
 * bottom of page. Wording comes from the one canonical constant in
 * `#/lib/brand` — never inline the text (see ADR-0024, #256).
 */
export function PublicFooter({
	className,
	style,
}: {
	className?: string;
	style?: React.CSSProperties;
}) {
	return (
		<footer
			className={cn(
				"mt-auto border-t border-[var(--line)] px-5 py-4 text-center text-[11px] leading-relaxed text-[var(--sea-ink-soft)] sm:px-8",
				className,
			)}
			style={style}
		>
			{TOASTMASTERS_DISCLAIMER}
		</footer>
	);
}
