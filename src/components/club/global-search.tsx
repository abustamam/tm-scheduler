import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	type ReactNode,
	type Ref,
	useEffect,
	useId,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { MemberAvatar } from "#/components/club/member-avatar";
import { Input } from "#/components/ui/input";
import { initialsOf, toneFromSeed } from "#/lib/avatar";
import { APP_LOCALE, formatMeetingDate } from "#/lib/format";
import {
	type NavGrants,
	type RegisteredDestination,
	visibleDestinations,
} from "#/lib/nav-destinations";
import { officerPositionLabel } from "#/lib/officers";
import { isBlankQuery, searchPeople } from "#/lib/person-search";
import { listPastMeetings, listUpcomingMeetings } from "#/server/meetings";
import { listMembers } from "#/server/members";

/** Roster row shape returned by `listMembers` (name + current offices). */
type MemberRow = Awaited<ReturnType<typeof listMembers>>[number];

/** Grants deciding which workspace pages are searchable for this user. */
export type SearchGrants = NavGrants;

/** A searchable workspace page: every nav destination this user can see,
 *  under the label the sidebar shows it with (#911). */
type WorkspacePage = RegisteredDestination;

const MAX_MEMBER_RESULTS = 8;
const MAX_MEETING_RESULTS = 5;
/** About a year of weekly meetings; older ones are not searchable (#1421). */
const PAST_MEETING_SEARCH_DEPTH = 52;

/** A meeting the search can find, upcoming or past. */
export interface SearchableMeeting {
	id: string;
	scheduledAt: Date | string;
	theme: string | null;
	urlKey: string;
	timezone: string;
	/** Only past rows carry one (upcoming rows do not select it). */
	meetingNumber?: number | null;
	upcoming: boolean;
}

/** The day number, full month name and 3-letter month of the meeting's
 *  club-local date, lower-cased: the words a date query can name. */
function dateWords(m: SearchableMeeting): string[] {
	const parts = new Intl.DateTimeFormat(APP_LOCALE, {
		day: "numeric",
		month: "long",
		timeZone: m.timezone,
	}).formatToParts(new Date(m.scheduledAt));
	const day = parts.find((p) => p.type === "day")?.value ?? "";
	const month = (
		parts.find((p) => p.type === "month")?.value ?? ""
	).toLowerCase();
	return [day, month, month.slice(0, 3)];
}

/** Meetings matching `rawQuery`: every query word must be the meeting's day
 *  number, month (full or 3-letter) or number ("412", "#412"), or the whole
 *  query is a substring of the theme. Upcoming first (soonest first), then past
 *  newest-first. Capped at five. */
export function searchMeetings(
	rawQuery: string,
	meetings: readonly SearchableMeeting[],
): SearchableMeeting[] {
	const q = rawQuery.trim().toLowerCase();
	if (!q) return [];
	const words = q.split(/\s+/);
	const hits = meetings.filter((m) => {
		if (m.theme?.toLowerCase().includes(q)) return true;
		const date = dateWords(m);
		const number = m.meetingNumber != null ? String(m.meetingNumber) : null;
		return words.every(
			(w) =>
				date.includes(w) || (number != null && w.replace(/^#/, "") === number),
		);
	});
	const time = (m: SearchableMeeting) => new Date(m.scheduledAt).getTime();
	const upcoming = hits
		.filter((m) => m.upcoming)
		.sort((a, b) => time(a) - time(b));
	const past = hits
		.filter((m) => !m.upcoming)
		.sort((a, b) => time(b) - time(a));
	return [...upcoming, ...past].slice(0, MAX_MEETING_RESULTS);
}

/** Pure result filtering — members match on name, preferred name or current
 *  office label via the shared matcher (#1333), pages on their nav label, gated by grants.
 *  `meetings` is optional: only a caller that passes it gets a `meetings` key. */
export function searchWorkspace(
	rawQuery: string,
	members: readonly MemberRow[],
	grants: SearchGrants,
	meetings?: readonly SearchableMeeting[],
): {
	members: MemberRow[];
	pages: WorkspacePage[];
	meetings?: SearchableMeeting[];
} {
	const q = rawQuery.trim().toLowerCase();
	if (!q) return { members: [], pages: [] };
	// A punctuation-only query ("%", ".") folds to no words, which the matcher
	// reads as "everyone": no members for it. Pages keep their label match.
	const memberHits = isBlankQuery(rawQuery)
		? []
		: searchPeople(
				rawQuery,
				members.map((m) => ({
					...m,
					extraTerms: m.officerPositions.map(officerPositionLabel),
				})),
			)
				.slice(0, MAX_MEMBER_RESULTS)
				.map(({ extraTerms: _extra, ...m }) => m as MemberRow);
	const pageHits = visibleDestinations(grants).filter((p) =>
		p.label.toLowerCase().includes(q),
	);
	return {
		members: memberHits,
		pages: pageHits,
		...(meetings ? { meetings: searchMeetings(rawQuery, meetings) } : {}),
	};
}

export interface GlobalSearchHandle {
	/** Clear open results; returns true if there was anything to clear.
	 *  Lets the drawer route Escape to results-first, drawer-second. */
	clearResults(): boolean;
	/** Focus the search input (the ⌘K / `/` shortcuts and the phone button). */
	focus(): void;
}

/**
 * The authed workspace's global search ("Search members, roles…"), shared by
 * the desktop top bar and the mobile nav drawer (#221).
 *
 * - `popover`: results in a dropdown anchored under the input (desktop).
 * - `inline`: results render in-flow below the input — used inside the nav
 *   drawer, where an anchored overlay would fight the Sheet's fixed/overflow
 *   stacking context. Behavior (results, selection → navigate) is identical.
 */
export function GlobalSearch({
	clubId,
	grants,
	variant = "popover",
	onNavigate,
	ref,
}: {
	clubId: string | null;
	grants: SearchGrants;
	variant?: "popover" | "inline";
	/** Called when a result is chosen (the mobile drawer closes itself here). */
	onNavigate?: () => void;
	ref?: Ref<GlobalSearchHandle>;
}) {
	const navigate = useNavigate();
	const listId = useId();
	const [query, setQuery] = useState("");
	const [focusWithin, setFocusWithin] = useState(false);
	// Meetings are fetched once the input has been focused, and kept after.
	const [everFocused, setEverFocused] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	// Hint text is settled after mount: the server cannot know the platform.
	const [hint, setHint] = useState("Ctrl K");
	useEffect(() => {
		if (/mac|iphone|ipad/i.test(navigator.platform)) setHint("⌘K");
	}, []);

	const active = query.trim().length > 0;
	// Roster fetch is lazy (first keystroke) and shares the ["members", clubId]
	// key with other pickers, so it is usually already cached.
	const { data: members = [] } = useQuery({
		queryKey: ["members", clubId],
		queryFn: () => listMembers({ data: clubId }),
		enabled: active && !!clubId,
	});

	const meetingsEnabled = everFocused && !!clubId;
	const { data: upcoming } = useQuery({
		queryKey: ["search-meetings", "upcoming", clubId],
		queryFn: () => listUpcomingMeetings({ data: clubId as string }),
		enabled: meetingsEnabled,
	});
	const { data: past } = useQuery({
		queryKey: ["search-meetings", "past", clubId],
		queryFn: () =>
			listPastMeetings({
				data: { clubId: clubId as string, limit: PAST_MEETING_SEARCH_DEPTH },
			}),
		enabled: meetingsEnabled,
	});
	const clubSlug = past?.clubSlug ?? null;
	const searchable: SearchableMeeting[] | undefined =
		clubSlug && (upcoming || past)
			? [
					...(upcoming ?? []).map((m) => ({ ...m, upcoming: true })),
					...(past?.meetings ?? []).map((m) => ({
						...m,
						timezone: past?.timezone ?? "UTC",
						upcoming: false,
					})),
				]
			: undefined;

	const results = searchWorkspace(query, members, grants, searchable);
	const meetingHits = results.meetings ?? [];
	// The popover only shows while focus is inside (blur dismisses it without
	// losing the typed text); inline results just follow the query.
	const open = active && (variant === "inline" || focusWithin);

	useImperativeHandle(
		ref,
		() => ({
			clearResults: () => {
				if (!query) return false;
				setQuery("");
				return true;
			},
			focus: () => inputRef.current?.focus(),
		}),
		[query],
	);

	function choose(go: () => void) {
		setQuery("");
		onNavigate?.();
		go();
	}

	return (
		<search
			className={variant === "popover" ? "relative" : undefined}
			onFocus={() => {
				setFocusWithin(true);
				setEverFocused(true);
			}}
			onBlur={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget)) setFocusWithin(false);
			}}
		>
			<Input
				ref={inputRef}
				type="search"
				role="combobox"
				aria-expanded={open}
				aria-controls={listId}
				aria-label="Search members, roles…"
				placeholder="Search members, roles…"
				autoComplete="off"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={(e) => {
					// Escape clears open results first; a second Escape falls
					// through (closing the drawer via the Sheet's own handling).
					if (e.key === "Escape" && query) {
						e.preventDefault();
						setQuery("");
					}
				}}
				className="h-9 rounded-lg border-border bg-surface-raised"
			/>
			{variant === "popover" && !active ? (
				<kbd
					aria-hidden
					className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border border-border px-1.5 text-xs font-semibold text-muted-foreground lg:block"
				>
					{hint}
				</kbd>
			) : null}
			{open ? (
				<div
					id={listId}
					className={
						variant === "popover"
							? "absolute inset-x-0 top-full z-50 mt-1.5 max-h-[min(420px,60vh)] overflow-y-auto rounded-lg border border-border bg-surface-raised p-1 shadow-lg backdrop-blur-[6px]"
							: "mt-1.5 max-h-[45svh] overflow-y-auto rounded-lg border border-border bg-surface-raised p-1"
					}
				>
					{results.members.length === 0 &&
					results.pages.length === 0 &&
					meetingHits.length === 0 ? (
						<div className="px-2.5 py-2 text-xs text-muted-foreground">
							No matches for “{query.trim()}”
						</div>
					) : (
						<>
							{results.members.length > 0 ? (
								<ResultGroup label="Members">
									{results.members.map((m) => (
										<li key={m.id}>
											<button
												type="button"
												onClick={() =>
													choose(() =>
														navigate({
															to: "/members/$id",
															params: { id: m.id },
														}),
													)
												}
												className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-soft"
											>
												<MemberAvatar
													tone={toneFromSeed(m.id)}
													initials={initialsOf(m.name)}
													size={28}
												/>
												<span className="min-w-0 leading-tight">
													<span className="block truncate text-sm font-semibold text-foreground">
														{m.name}
													</span>
													{m.officerPositions.length > 0 ? (
														<span className="block truncate text-xs text-muted-foreground">
															{m.officerPositions
																.map(officerPositionLabel)
																.join(", ")}
														</span>
													) : null}
												</span>
											</button>
										</li>
									))}
								</ResultGroup>
							) : null}
							{meetingHits.length > 0 ? (
								<ResultGroup label="Meetings">
									{meetingHits.map((m) => (
										<li key={m.id}>
											<button
												type="button"
												onClick={() =>
													choose(() =>
														navigate({
															to: "/club/$clubId/meeting/$meetingId",
															params: {
																clubId: clubSlug ?? "",
																meetingId: m.urlKey,
															},
														}),
													)
												}
												className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-soft"
											>
												<span className="min-w-0 leading-tight">
													<span className="block truncate text-sm font-semibold text-foreground">
														{formatMeetingDate(m.scheduledAt, m.timezone)}
														{m.meetingNumber != null
															? ` · #${m.meetingNumber}`
															: ""}
													</span>
													{m.theme ? (
														<span className="block truncate text-xs text-muted-foreground">
															{m.theme}
														</span>
													) : null}
												</span>
											</button>
										</li>
									))}
								</ResultGroup>
							) : null}
							{results.pages.length > 0 ? (
								<ResultGroup label="Pages">
									{results.pages.map((p) => (
										<li key={p.to}>
											<button
												type="button"
												onClick={() => choose(() => navigate({ to: p.to }))}
												className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-sm font-semibold text-foreground transition-colors hover:bg-surface-soft"
											>
												{p.label}
											</button>
										</li>
									))}
								</ResultGroup>
							) : null}
						</>
					)}
				</div>
			) : null}
		</search>
	);
}

function ResultGroup({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<>
			<div className="px-2.5 pt-2 pb-0.5 text-xs font-bold tracking-[0.12em] text-muted-foreground uppercase first:pt-1">
				{label}
			</div>
			<ul aria-label={label}>{children}</ul>
		</>
	);
}
