import { Link } from "@tanstack/react-router";
import { CheckCircle2, Circle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ShareLinkButton } from "#/components/share-link-button";
import {
	buildOnboardingChecklistItems,
	isNewClubFor,
	type OnboardingPath,
	onboardingDismissKey,
	onboardingPathKey,
	resolveOnboardingPath,
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
	// SSR and the first client render use the stored-choice-free path; the
	// stored choice is read with the dismiss key after mount.
	const [storedPath, setStoredPath] = useState<string | null>(null);
	const storageKey = onboardingDismissKey(clubId);
	const pathKey = onboardingPathKey(clubId);

	useEffect(() => {
		try {
			setDismissed(localStorage.getItem(storageKey) === "1");
		} catch {
			// localStorage unavailable (private mode) — never block showing it.
		}
		try {
			setStoredPath(localStorage.getItem(pathKey));
		} catch {
			// Same: fall back to the data-derived path.
		}
		setMounted(true);
	}, [storageKey, pathKey]);

	const path: OnboardingPath = resolveOnboardingPath(status, storedPath);
	if (!isNewClubFor(status, path)) return null;
	if (mounted && dismissed) return null;

	const items = buildOnboardingChecklistItems(status, path);
	const doneCount = items.filter((item) => item.complete).length;
	const nextKey = items.find((item) => !item.complete)?.key;

	function choosePath(choice: "easy-speak" | "fresh") {
		setStoredPath(choice === "easy-speak" ? "easy-speak" : null);
		try {
			if (choice === "easy-speak") localStorage.setItem(pathKey, "easy-speak");
			else localStorage.removeItem(pathKey);
		} catch {
			// Best-effort persistence — the switch still applies to this render.
		}
	}

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
			className="space-y-3.5 rounded-2xl border border-border bg-surface-raised p-5 shadow-[0_8px_20px_rgba(23,58,64,.05)]"
		>
			<div className="flex items-start justify-between gap-3">
				<div>
					<h2 className="font-display text-lg font-semibold tracking-[-0.01em]">
						{path === "easy-speak"
							? "Move your club to GavelUp"
							: "Get your club set up"}
					</h2>
					<p className="mt-0.5 text-xs text-muted-foreground">
						{doneCount} of {items.length} done
					</p>
					{status.hasImport ? null : (
						<p className="mt-1 text-xs text-muted-foreground">
							{path === "easy-speak"
								? "Not moving from Easy-Speak? "
								: "Moving from Easy-Speak? "}
							<button
								type="button"
								onClick={() =>
									choosePath(path === "easy-speak" ? "fresh" : "easy-speak")
								}
								className="font-semibold text-foreground underline"
							>
								{path === "easy-speak"
									? "Show the standard steps"
									: "Show the migration steps"}
							</button>
						</p>
					)}
				</div>
				<button
					type="button"
					onClick={handleDismiss}
					aria-label="Dismiss setup checklist"
					className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-soft hover:text-foreground"
				>
					<X className="size-4" aria-hidden />
				</button>
			</div>

			<ul className="space-y-1">
				{items.map((item, index) => {
					const body = (
						<>
							{item.complete ? (
								<CheckCircle2
									className="size-5 shrink-0 text-success"
									aria-hidden
								/>
							) : (
								<Circle
									className="size-5 shrink-0 text-muted-foreground opacity-40"
									aria-hidden
								/>
							)}
							<div className="min-w-0 flex-1">
								<div
									className={
										item.complete
											? "text-sm font-semibold text-muted-foreground line-through"
											: "text-sm font-semibold text-foreground"
									}
								>
									<span data-testid="checklist-number" className="mr-1">
										{index + 1}.
									</span>
									<span>{item.label}</span>
									{item.key === nextKey ? (
										<span
											data-testid="checklist-next"
											className="ml-2 rounded-full bg-surface-soft px-2 py-0.5 text-xs font-semibold text-foreground no-underline"
										>
											Next
										</span>
									) : null}
								</div>
								<div className="truncate text-xs text-muted-foreground">
									{item.locked ?? item.description}
								</div>
							</div>
						</>
					);
					return (
						<li key={item.key}>
							{item.locked ? (
								<div className="flex items-center gap-3 rounded-lg px-2.5 py-2">
									{body}
								</div>
							) : (
								<Link
									to={item.to}
									className="group flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-surface-soft"
								>
									{body}
								</Link>
							)}
						</li>
					);
				})}
			</ul>

			<div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-border px-3 py-2.5">
				<div className="min-w-0 flex-1">
					<div className="text-sm font-semibold text-foreground">
						Share your sign-up link
					</div>
					<div className="truncate text-xs text-muted-foreground">
						Send members straight to the sign-up sheet.
					</div>
				</div>
				<ShareLinkButton path={`/club/${status.clubSlug}`} label="Copy link" />
			</div>
		</section>
	);
}
