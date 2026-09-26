import { Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
	addToStoredSet,
	bannerEntry,
	dismissedBannerKey,
	readStoredSet,
	WHATS_NEW_ENTRIES,
} from "#/lib/whats-new";

/**
 * "What's new" for a club member without an account (#947 decision 4).
 *
 * The single dismissible banner on the public club and meeting pages. Shown
 * only when `show` (the caller passes "a member picked their name here and is
 * not signed in"), for the newest public entry aimed at members or everyone
 * that this browser has not dismissed for this club. Storage that cannot be
 * read shows nothing.
 */
export function WhatsNewBanner({
	clubId,
	show,
}: {
	clubId: string;
	show: boolean;
}) {
	// null until mounted (and when storage is unavailable): render nothing, so
	// the server render and first client render agree.
	const [dismissed, setDismissed] = useState<Set<string> | null>(null);
	const [now, setNow] = useState<Date | null>(null);
	useEffect(() => {
		setNow(new Date());
		setDismissed(readStoredSet(dismissedBannerKey(clubId)));
	}, [clubId]);

	if (!show || !now) return null;
	const entry = bannerEntry({ entries: WHATS_NEW_ENTRIES, dismissed, now });
	if (!entry) return null;

	function dismiss() {
		if (!entry) return;
		addToStoredSet(dismissedBannerKey(clubId), entry.id);
		setDismissed((prev) => new Set([...(prev ?? []), entry.id]));
	}

	return (
		<aside
			aria-label="What's new"
			className="flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm"
		>
			<Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
			<p className="min-w-0 flex-1">
				<span className="font-semibold text-foreground">
					New: {entry.title}.
				</span>{" "}
				<a
					href="/whats-new"
					className="font-semibold text-primary no-underline hover:underline"
				>
					See what's new
				</a>
			</p>
			<button
				type="button"
				onClick={dismiss}
				className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
			>
				<X className="size-4" aria-hidden />
				<span className="sr-only">Dismiss</span>
			</button>
		</aside>
	);
}
