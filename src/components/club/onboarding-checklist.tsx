import { Link } from "@tanstack/react-router";
import { CheckCircle2, Circle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ShareLinkButton } from "#/components/share-link-button";
import {
	buildOnboardingChecklistItems,
	onboardingDismissKey,
} from "#/lib/onboarding-checklist";
import type { OnboardingChecklistStatus } from "#/server/onboarding-checklist-logic";

/**
 * First-admin setup checklist (#265): shown on `/officers` while a club still
 * looks new (`status.isNewClub`, computed server-side from real data — see
 * `onboarding-checklist-logic.ts`), and dismissible per-club via localStorage
 * (no schema change). Each item deep-links to the real screen that completes
 * it and is auto-checked from data, not a stored step flag. Renders nothing
 * once the club has graduated OR the admin has dismissed it.
 */
export function OnboardingChecklist({
	clubId,
	status,
}: {
	clubId: string;
	status: OnboardingChecklistStatus;
}) {
	const [dismissed, setDismissed] = useState(false);
	// Gate the localStorage read behind mount so SSR and the first client
	// render agree (see ThemeToggle) — a returning, previously-dismissed admin
	// may see a brief flash before this settles, which is an acceptable
	// tradeoff for "no schema change."
	const [mounted, setMounted] = useState(false);
	const storageKey = onboardingDismissKey(clubId);

	useEffect(() => {
		try {
			setDismissed(localStorage.getItem(storageKey) === "1");
		} catch {
			// localStorage unavailable (private mode) — never block showing it.
		}
		setMounted(true);
	}, [storageKey]);

	if (!status.isNewClub) return null;
	if (mounted && dismissed) return null;

	const items = buildOnboardingChecklistItems(status);
	const doneCount = items.filter((item) => item.complete).length;

	function handleDismiss() {
		setDismissed(true);
		try {
			localStorage.setItem(storageKey, "1");
		} catch {
			// Best-effort persistence — the dismiss still applies to this render.
		}
	}

	return (
		<section
			aria-label="Setup checklist"
			className="space-y-3.5 rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-5 shadow-[0_1px_0_var(--inset-glint)_inset,0_8px_20px_rgba(23,58,64,.05)]"
		>
			<div className="flex items-start justify-between gap-3">
				<div>
					<h2 className="font-display text-lg font-semibold tracking-[-0.01em]">
						Get your club set up
					</h2>
					<p className="mt-0.5 text-xs text-[var(--sea-ink-soft)]">
						{doneCount} of {items.length} done
					</p>
				</div>
				<button
					type="button"
					onClick={handleDismiss}
					aria-label="Dismiss setup checklist"
					className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--sea-ink-soft)] transition-colors hover:bg-[var(--foam)] hover:text-[var(--sea-ink)]"
				>
					<X className="size-4" aria-hidden />
				</button>
			</div>

			<ul className="space-y-1">
				{items.map((item) => (
					<li key={item.key}>
						<Link
							to={item.to}
							className="group flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-[var(--foam)]"
						>
							{item.complete ? (
								<CheckCircle2
									className="size-5 shrink-0 text-[var(--lagoon-deep)]"
									aria-hidden
								/>
							) : (
								<Circle
									className="size-5 shrink-0 text-[var(--sea-ink-soft)] opacity-40"
									aria-hidden
								/>
							)}
							<div className="min-w-0 flex-1">
								<div
									className={
										item.complete
											? "text-sm font-semibold text-[var(--sea-ink-soft)] line-through"
											: "text-sm font-semibold text-[var(--sea-ink)]"
									}
								>
									{item.label}
								</div>
								<div className="truncate text-xs text-[var(--sea-ink-soft)]">
									{item.description}
								</div>
							</div>
						</Link>
					</li>
				))}
			</ul>

			<div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-[var(--line)] px-3 py-2.5">
				<div className="min-w-0 flex-1">
					<div className="text-sm font-semibold text-[var(--sea-ink)]">
						Share your sign-up link
					</div>
					<div className="truncate text-xs text-[var(--sea-ink-soft)]">
						Send members straight to the sign-up sheet.
					</div>
				</div>
				<ShareLinkButton path={`/club/${status.clubSlug}`} label="Copy link" />
			</div>
		</section>
	);
}
