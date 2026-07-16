import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	type ReactNode,
	type Ref,
	useId,
	useImperativeHandle,
	useState,
} from "react";
import { MemberAvatar } from "#/components/club/member-avatar";
import { Input } from "#/components/ui/input";
import { initialsOf, toneFromSeed } from "#/lib/avatar";
import { officerPositionLabel } from "#/lib/officers";
import { listMembers } from "#/server/members";

/** Roster row shape returned by `listMembers` (name + current offices). */
type MemberRow = Awaited<ReturnType<typeof listMembers>>[number];

/** Grants deciding which workspace pages are searchable for this user. */
export interface SearchGrants {
	hasOffice: boolean;
	isOfficer: boolean;
	isSuperadmin: boolean;
}

/** Searchable workspace destinations — mirrors the sidebar nav (plus /me). */
const WORKSPACE_PAGES = [
	{ label: "Officer home", to: "/officers", grant: "office" },
	{ label: "Sign-up sheet", to: "/schedule" },
	{ label: "Roster", to: "/roster" },
	{ label: "Next meeting", to: "/next" },
	{ label: "Activity", to: "/activity" },
	{ label: "VP Education", to: "/admin/vpe-dashboard", grant: "officer" },
	{ label: "New meeting", to: "/admin/meetings/new", grant: "officer" },
	{ label: "Meeting roles", to: "/admin/roles", grant: "officer" },
	{ label: "Club settings", to: "/admin/club-settings", grant: "officer" },
	{ label: "Base Camp sync", to: "/admin/sync-tokens", grant: "officer" },
	{ label: "My dashboard", to: "/dashboard" },
	{ label: "My roles", to: "/me" },
	{ label: "Resources", to: "/resources" },
	{ label: "Superadmin", to: "/superadmin", grant: "superadmin" },
] as const;

type WorkspacePage = (typeof WORKSPACE_PAGES)[number];

const MAX_MEMBER_RESULTS = 8;

/** Pure result filtering — members match on name or current office label
 *  ("Search members, roles…"), pages on their nav label, gated by grants. */
export function searchWorkspace(
	rawQuery: string,
	members: readonly MemberRow[],
	grants: SearchGrants,
): { members: MemberRow[]; pages: WorkspacePage[] } {
	const q = rawQuery.trim().toLowerCase();
	if (!q) return { members: [], pages: [] };
	const memberHits = members
		.filter(
			(m) =>
				m.name.toLowerCase().includes(q) ||
				m.officerPositions.some((p) =>
					officerPositionLabel(p).toLowerCase().includes(q),
				),
		)
		.slice(0, MAX_MEMBER_RESULTS);
	const pageHits = WORKSPACE_PAGES.filter((p) => {
		const grant = "grant" in p ? p.grant : undefined;
		if (grant === "office" && !grants.hasOffice) return false;
		if (grant === "officer" && !grants.isOfficer) return false;
		if (grant === "superadmin" && !grants.isSuperadmin) return false;
		return p.label.toLowerCase().includes(q);
	});
	return { members: memberHits, pages: pageHits };
}

export interface GlobalSearchHandle {
	/** Clear open results; returns true if there was anything to clear.
	 *  Lets the drawer route Escape to results-first, drawer-second. */
	clearResults(): boolean;
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

	const active = query.trim().length > 0;
	// Roster fetch is lazy (first keystroke) and shares the ["members", clubId]
	// key with other pickers, so it is usually already cached.
	const { data: members = [] } = useQuery({
		queryKey: ["members", clubId],
		queryFn: () => listMembers({ data: clubId }),
		enabled: active && !!clubId,
	});

	const results = searchWorkspace(query, members, grants);
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
			onFocus={() => setFocusWithin(true)}
			onBlur={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget)) setFocusWithin(false);
			}}
		>
			<Input
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
				className="h-9 rounded-lg border-[var(--line)] bg-[var(--surface-strong)]"
			/>
			{open ? (
				<div
					id={listId}
					className={
						variant === "popover"
							? "absolute inset-x-0 top-full z-50 mt-1.5 max-h-[min(420px,60vh)] overflow-y-auto rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] p-1 shadow-lg backdrop-blur-[6px]"
							: "mt-1.5 max-h-[45svh] overflow-y-auto rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] p-1"
					}
				>
					{results.members.length === 0 && results.pages.length === 0 ? (
						<div className="px-2.5 py-2 text-xs text-[var(--sea-ink-soft)]">
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
												className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--foam)]"
											>
												<MemberAvatar
													tone={toneFromSeed(m.id)}
													initials={initialsOf(m.name)}
													size={28}
												/>
												<span className="min-w-0 leading-tight">
													<span className="block truncate text-sm font-semibold text-[var(--sea-ink)]">
														{m.name}
													</span>
													{m.officerPositions.length > 0 ? (
														<span className="block truncate text-xs text-[var(--sea-ink-soft)]">
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
							{results.pages.length > 0 ? (
								<ResultGroup label="Pages">
									{results.pages.map((p) => (
										<li key={p.to}>
											<button
												type="button"
												onClick={() => choose(() => navigate({ to: p.to }))}
												className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-sm font-medium text-[var(--sea-ink)] transition-colors hover:bg-[var(--foam)]"
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
			<div className="px-2.5 pt-2 pb-0.5 text-xs font-extrabold tracking-[0.12em] text-[var(--sea-ink-soft)] uppercase opacity-70 first:pt-1">
				{label}
			</div>
			<ul aria-label={label}>{children}</ul>
		</>
	);
}
