import { Eye, X } from "lucide-react";
import { useEffect, useState } from "react";

/** Milliseconds remaining → "M:SS" (clamped at 0:00). Pure, so it's unit-tested. */
export function formatRemaining(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Persistent read-only impersonation banner (#185 / ADR-0020). Rendered on every
 * authed page while a superadmin has an active "View as this club" session, with
 * a live countdown to expiry and an Exit that ends the session. Deliberately loud
 * (warning color) so the superadmin always knows they're viewing someone's club.
 */
export function ImpersonationBanner({
	clubName,
	expiresAt,
	onExit,
}: {
	clubName: string;
	expiresAt: Date | string;
	onExit: () => void;
}) {
	const expiryMs = (
		typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt
	).getTime();
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, []);
	const remaining = expiryMs - now;

	return (
		<div className="sticky top-0 z-20 flex h-9 items-center gap-2 bg-[var(--warning-strong,#b45309)] px-4 text-xs font-semibold text-white shadow-sm">
			<Eye className="size-3.5 shrink-0" aria-hidden />
			<span className="truncate">
				Viewing <strong>{clubName}</strong> as platform support · read-only
			</span>
			<span className="ml-auto shrink-0 tabular-nums opacity-90">
				{remaining > 0 ? `expires in ${formatRemaining(remaining)}` : "expired"}
			</span>
			<button
				type="button"
				onClick={onExit}
				className="flex shrink-0 items-center gap-1 rounded bg-white/15 px-2 py-0.5 transition-colors hover:bg-white/25"
			>
				<X className="size-3" aria-hidden /> Exit
			</button>
		</div>
	);
}
