import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Sparkles, X } from "lucide-react";
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
	type WhenContext,
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
	markPanelSeen: () => void;
	markFeatureSeen: (featureKey: string) => void;
}

const SessionWhatsNewContext = createContext<SessionWhatsNew | null>(null);

/**
 * Seen state for a signed-in user, shared by the header button and every
 * `useIsNew` below it. Mounted by `<AppShell>`, which only ever renders for a
 * session, so anything outside it is a visitor without an account.
 */
export function WhatsNewProvider({
	isAdmin,
	when,
	children,
}: {
	/** Admin or officer of the current club: sees `admins` + `everyone`. */
	isAdmin: boolean;
	when?: WhenContext;
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
	const eligible = useMemo(
		() => eligibleEntries(WHATS_NEW_ENTRIES, { isAdmin, when }),
		[isAdmin, when],
	);

	const markPanelSeen = useCallback(() => {
		const optimistic = new Date().toISOString();
		queryClient.setQueryData<WhatsNewState>(WHATS_NEW_QUERY_KEY, (prev) =>
			prev ? { ...prev, seenAt: optimistic } : prev,
		);
		markWhatsNewSeen().catch(() => {
			// Not remembered this time; the dot comes back on the next load.
		});
	}, [queryClient]);

	const markFeature = useCallback(
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
		() => ({
			eligible,
			state,
			markPanelSeen,
			markFeatureSeen: markFeature,
		}),
		[eligible, state, markPanelSeen, markFeature],
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
 * Call `markSeen` when the feature is used, or from the badge's dismiss.
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
			// A visitor is not an officer, and has no club context for `when`.
			isNew = isFeatureNew({
				eligible: eligibleEntries(WHATS_NEW_ENTRIES, { isAdmin: false }),
				featureKey,
				seen: localSeen,
				now,
			});
		}
	}

	const markSeen = useCallback(() => {
		if (!isFeatureKey(featureKey)) return;
		if (session) {
			session.markFeatureSeen(featureKey);
			return;
		}
		if (!clubId) return;
		addToStoredSet(featureSeenKey(clubId), featureKey);
		setLocalSeen((prev) => (prev ? new Set([...prev, featureKey]) : prev));
	}, [session, clubId, featureKey]);

	return { isNew, markSeen };
}

/**
 * The small "New" pill. Renders nothing unless `isNew`. With `onDismiss` it
 * carries its own close button — do not pass one when the badge sits inside a
 * link or button (a button inside a link is invalid markup); clear it on use
 * instead.
 */
export function NewBadge({
	isNew,
	onDismiss,
	className = "",
}: {
	isNew: boolean;
	onDismiss?: () => void;
	className?: string;
}) {
	if (!isNew) return null;
	return (
		<span
			className={`inline-flex items-center gap-0.5 rounded-full bg-primary px-1.5 py-px text-[10px] font-bold tracking-[0.04em] text-primary-foreground uppercase ${className}`}
		>
			New
			{onDismiss ? (
				<button
					type="button"
					onClick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						onDismiss();
					}}
					className="-mr-0.5 rounded-full p-px hover:bg-primary-foreground/20"
				>
					<X className="size-2.5" aria-hidden />
					<span className="sr-only">Dismiss</span>
				</button>
			) : null}
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
	onNavigate?: () => void;
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
							onClick={onNavigate}
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
	return <WhatsNewEntryList entries={publicEntries(entries)} />;
}

// ---------------------------------------------------------------------------
// Header button + panel (signed in)
// ---------------------------------------------------------------------------

/**
 * The header's "What's new" button. The dot shows while an entry the user is
 * eligible for is dated after the last time they opened the panel; opening it
 * clears the dot. Outside `<WhatsNewProvider>` it renders nothing.
 */
export function WhatsNewButton() {
	const session = useContext(SessionWhatsNewContext);
	const [open, setOpen] = useState(false);
	if (!session) return null;
	const { eligible, state, markPanelSeen } = session;
	// Undefined state (loading or failed) shows no dot: fail silent.
	const unseen = state ? hasUnseenEntries(eligible, state.seenAt) : false;

	function onOpenChange(next: boolean) {
		setOpen(next);
		if (next && unseen) markPanelSeen();
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
			<SheetContent side="right" className="gap-0 overflow-y-auto">
				<SheetHeader>
					<SheetTitle>What's new</SheetTitle>
					<SheetDescription>Recent additions to GavelUp.</SheetDescription>
				</SheetHeader>
				<div className="px-4 pb-6">
					<WhatsNewEntryList
						entries={eligible}
						onNavigate={() => setOpen(false)}
					/>
				</div>
			</SheetContent>
		</Sheet>
	);
}
