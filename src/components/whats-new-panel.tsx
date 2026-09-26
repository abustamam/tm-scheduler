import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Sparkles } from "lucide-react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import ReactMarkdown from "react-markdown";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "#/components/ui/sheet";
import { formatArchiveDate } from "#/lib/format";
import {
	addToStoredSet,
	eligibleEntries,
	featureSeenKey,
	hasUnseenEntries,
	isFeatureKey,
	isFeatureNew,
	publicEntries,
	readStoredSet,
	WHATS_NEW_ENTRIES,
	type WhatsNewEntry,
} from "#/lib/whats-new";
import {
	getWhatsNewState,
	markFeatureSeen,
	markWhatsNewSeen,
	type WhatsNewState,
} from "#/server/whats-new";

/**
 * The "What's new" surfaces (#947): the header button and panel for a signed-in
 * user, the entry list both the panel and `/whats-new` render, and `useIsNew` /
 * `<NewBadge>` for marking a feature's own entry point. The public-page banner
 * is `whats-new-banner.tsx`, kept apart so the public club and meeting pages do
 * not import the signed-in half (and its server fns) to show one line.
 *
 * Every read of seen state fails SILENT: a request that errors or storage that
 * throws means "nothing is new", never an error on the page and never a badge
 * that cannot be cleared.
 */

export const WHATS_NEW_QUERY_KEY = ["whats-new-state"] as const;

// ---------------------------------------------------------------------------
// Signed-in context
// ---------------------------------------------------------------------------

interface SessionWhatsNew {
	eligible: WhatsNewEntry[];
	state: WhatsNewState | undefined;
	/** Record the entries the panel just showed as seen. */
	markPanelSeen: (entryIds: readonly string[]) => void;
	/** Clear a feature's badge (named apart from the `markFeatureSeen` fn). */
	clearFeature: (featureKey: string) => void;
}

const SessionWhatsNewContext = createContext<SessionWhatsNew | null>(null);

/**
 * Seen state for a signed-in user, shared by the header button and every
 * `useIsNew` below it. Mounted by `<AppShell>`, which only ever renders for a
 * session, so anything outside it is a visitor without an account.
 */
export function WhatsNewProvider({
	isAdmin,
	children,
}: {
	/** Admin OR officer of the current club (the shell's `isOfficer`): sees
	 *  `admins` + `everyone`. Officers count, deliberately — they run the
	 *  features the admin entries describe. */
	isAdmin: boolean;
	children: ReactNode;
}) {
	const queryClient = useQueryClient();
	const { data: state } = useQuery({
		queryKey: WHATS_NEW_QUERY_KEY,
		queryFn: () => getWhatsNewState(),
		// A failure shows nothing new; retrying only delays saying so.
		retry: false,
		staleTime: 5 * 60 * 1000,
	});
	// `now` is fixed per mount: an entry dated in the future waits for the next
	// page load after its date, which is soon enough.
	const eligible = useMemo(
		() => eligibleEntries(WHATS_NEW_ENTRIES, { isAdmin, now: new Date() }),
		[isAdmin],
	);

	const markPanelSeen = useCallback(
		(entryIds: readonly string[]) => {
			queryClient.setQueryData<WhatsNewState>(WHATS_NEW_QUERY_KEY, (prev) =>
				prev
					? {
							...prev,
							seenIds: [...new Set([...prev.seenIds, ...entryIds])],
						}
					: prev,
			);
			markWhatsNewSeen({ data: { entryIds: [...entryIds] } }).catch(() => {
				// Not remembered this time; the dot comes back on the next load.
			});
		},
		[queryClient],
	);

	const clearFeature = useCallback(
		(featureKey: string) => {
			if (!isFeatureKey(featureKey)) return;
			queryClient.setQueryData<WhatsNewState>(WHATS_NEW_QUERY_KEY, (prev) =>
				prev && !prev.featuresSeen.includes(featureKey)
					? { ...prev, featuresSeen: [...prev.featuresSeen, featureKey] }
					: prev,
			);
			markFeatureSeen({ data: { featureKey } }).catch(() => {});
		},
		[queryClient],
	);

	const value = useMemo(
		() => ({ eligible, state, markPanelSeen, clearFeature }),
		[eligible, state, markPanelSeen, clearFeature],
	);
	return (
		<SessionWhatsNewContext.Provider value={value}>
			{children}
		</SessionWhatsNewContext.Provider>
	);
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

/**
 * Whether a feature's entry point should show "New", and how to clear it.
 * Call `markSeen` when the feature is used.
 *
 * Signed in (under `<WhatsNewProvider>`): read from and written to the user's
 * account. Otherwise, pass the club's id and it is kept in this browser's
 * `localStorage` for that club; with no club id there is nowhere to remember a
 * dismissal, so nothing is ever new. A key not in `FEATURE_KEYS` is never new,
 * which is what lets the sidebar ask about every destination.
 */
export function useIsNew(
	featureKey: string,
	options: { clubId?: string | null } = {},
): { isNew: boolean; markSeen: () => void } {
	const session = useContext(SessionWhatsNewContext);
	const clubId = options.clubId ?? null;
	// Browser-only state for the visitor path, read after mount so the server
	// render and the first client render agree (both "not new").
	const [localSeen, setLocalSeen] = useState<Set<string> | null>(null);
	const [now, setNow] = useState<Date | null>(null);
	useEffect(() => {
		setNow(new Date());
		if (!session && clubId) setLocalSeen(readStoredSet(featureSeenKey(clubId)));
	}, [session, clubId]);

	let isNew = false;
	if (now && isFeatureKey(featureKey)) {
		if (session) {
			isNew = isFeatureNew({
				eligible: session.eligible,
				featureKey,
				seen: session.state ? new Set(session.state.featuresSeen) : null,
				now,
			});
		} else if (clubId) {
			// A visitor is not an officer.
			isNew = isFeatureNew({
				eligible: eligibleEntries(WHATS_NEW_ENTRIES, { isAdmin: false, now }),
				featureKey,
				seen: localSeen,
				now,
			});
		}
	}

	const markSeen = useCallback(() => {
		if (!isFeatureKey(featureKey)) return;
		if (session) {
			session.clearFeature(featureKey);
			return;
		}
		if (!clubId) return;
		addToStoredSet(featureSeenKey(clubId), featureKey);
		setLocalSeen((prev) => (prev ? new Set([...prev, featureKey]) : prev));
	}, [session, clubId, featureKey]);

	return { isNew, markSeen };
}

/**
 * The small "New" pill. Renders nothing unless `isNew`. It has no close button
 * of its own — the badges sit inside links, where a nested button is invalid —
 * so it clears when the feature is used (`useIsNew().markSeen`).
 */
export function NewBadge({
	isNew,
	className = "",
}: {
	isNew: boolean;
	className?: string;
}) {
	if (!isNew) return null;
	return (
		<span
			className={`inline-flex items-center rounded-full bg-primary px-1.5 py-px text-[10px] font-bold tracking-[0.04em] text-primary-foreground uppercase ${className}`}
		>
			New
		</span>
	);
}

// ---------------------------------------------------------------------------
// Entry list (panel + /whats-new)
// ---------------------------------------------------------------------------

function entryDate(entry: WhatsNewEntry): string {
	// The date is a calendar day, not an instant: format it in UTC so a
	// viewer west of Greenwich does not see the day before.
	return formatArchiveDate(`${entry.date}T00:00:00Z`, "UTC");
}

export function WhatsNewEntryList({
	entries,
	onNavigate,
	emptyText = "Nothing new yet.",
}: {
	entries: readonly WhatsNewEntry[];
	/** Called with the entry whose "Try it" was followed. */
	onNavigate?: (entry: WhatsNewEntry) => void;
	emptyText?: string;
}) {
	if (entries.length === 0) {
		return <p className="text-sm text-muted-foreground">{emptyText}</p>;
	}
	return (
		<ol className="space-y-4">
			{entries.map((entry) => (
				<li
					key={entry.id}
					data-entry-id={entry.id}
					className="rounded-xl border bg-card p-4"
				>
					<p className="text-xs font-semibold text-muted-foreground">
						<time dateTime={entry.date}>{entryDate(entry)}</time>
					</p>
					<h3 className="mt-1 font-semibold">{entry.title}</h3>
					<div className="mt-1 text-sm text-muted-foreground [&_strong]:text-foreground">
						<ReactMarkdown>{entry.body}</ReactMarkdown>
					</div>
					{entry.link ? (
						// A plain anchor: `link` is a content string, not a typed route.
						<a
							href={entry.link}
							onClick={() => onNavigate?.(entry)}
							className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-primary no-underline hover:underline"
						>
							Try it
							<ArrowRight className="size-3.5" aria-hidden />
						</a>
					) : null}
				</li>
			))}
		</ol>
	);
}

/**
 * The `/whats-new` page's list: `public: true` entries ONLY, whoever is
 * looking. An officer reading the page sees exactly what a stranger does;
 * admin-only features live in the signed-in panel (#947 decision 1).
 */
export function WhatsNewPublicList({
	entries = WHATS_NEW_ENTRIES,
}: {
	entries?: readonly WhatsNewEntry[];
}) {
	return <WhatsNewEntryList entries={publicEntries(entries, new Date())} />;
}

// ---------------------------------------------------------------------------
// Header button + panel (signed in)
// ---------------------------------------------------------------------------

/**
 * The header's "What's new" button. The dot shows while an entry the user is
 * eligible for is not among the ids they have seen; opening the panel records
 * what it shows. Outside `<WhatsNewProvider>` it renders nothing.
 */
export function WhatsNewButton() {
	const session = useContext(SessionWhatsNewContext);
	const [open, setOpen] = useState(false);
	if (!session) return null;
	const { eligible, state, markPanelSeen, clearFeature } = session;
	// Undefined state (loading or failed) shows no dot: fail silent.
	const unseen = hasUnseenEntries(
		eligible,
		state ? new Set(state.seenIds) : null,
	);

	function onOpenChange(next: boolean) {
		setOpen(next);
		if (next && unseen) markPanelSeen(eligible.map((e) => e.id));
	}

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<button
				type="button"
				onClick={() => onOpenChange(true)}
				aria-label={unseen ? "What's new (new updates)" : "What's new"}
				className="relative flex size-9 shrink-0 items-center justify-center rounded-lg border border-[var(--line)] text-[var(--sea-ink-soft)] transition-colors hover:bg-[var(--foam)] hover:text-[var(--sea-ink)]"
			>
				<Sparkles className="size-4" aria-hidden />
				{unseen ? (
					<span
						data-testid="whats-new-dot"
						className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary ring-2 ring-[var(--surface)]"
						aria-hidden
					/>
				) : null}
			</button>
			{/* The sheet is a fixed-height flex column and NOT the scroller: the
			    body below is, so the header stays pinned. `min-h-0` is what lets a
			    flex child shrink below its content and scroll instead of growing. */}
			<SheetContent side="right" className="gap-0 overflow-hidden">
				<SheetHeader className="shrink-0">
					<SheetTitle>What's new</SheetTitle>
					<SheetDescription>Recent additions to GavelUp.</SheetDescription>
				</SheetHeader>
				<div
					data-testid="whats-new-body"
					className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6"
				>
					<WhatsNewEntryList
						entries={eligible}
						onNavigate={(entry) => {
							// Following "Try it" is using the feature.
							if (entry.featureKey) clearFeature(entry.featureKey);
							setOpen(false);
						}}
					/>
				</div>
			</SheetContent>
		</Sheet>
	);
}
