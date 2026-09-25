import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronRight, LogOut, Menu } from "lucide-react";
import {
	type ComponentType,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { BrandMark } from "#/components/brand-mark";
import { ClubSwitcher } from "#/components/club/club-switcher";
import {
	GlobalSearch,
	type GlobalSearchHandle,
} from "#/components/club/global-search";
import { ImpersonationBanner } from "#/components/club/impersonation-banner";
import { MemberAvatar } from "#/components/club/member-avatar";
import { ThemeToggle } from "#/components/club/theme-toggle";
import { Sheet, SheetContent, SheetTitle } from "#/components/ui/sheet";
import { Toaster } from "#/components/ui/sonner";
import { initialsOf } from "#/lib/avatar";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import {
	crumbOf,
	destinationFor,
	NAV_GROUPS,
	type NavGrants,
	type NavGroup as NavGroupDef,
	navDestination,
	navGroup,
	type RegisteredDestination,
	visibleDestinations,
} from "#/lib/nav-destinations";
import {
	type OfficerPosition,
	officerPositionLabel,
	officerRank,
} from "#/lib/officers";

export interface AppShellProps {
	clubs: readonly {
		clubId: string;
		name: string;
		clubNumber: string | null;
		clubRole: "admin" | "member";
	}[];
	activeClubId: string | null;
	clubName: string;
	clubNumber: string | null;
	isOfficer: boolean;
	hasOffice: boolean;
	isSuperadmin: boolean;
	roleLabel: string;
	displayName: string;
	initials: string;
	impersonating: {
		clubName?: string;
		expiresAt: string | Date;
		mode: "read_only" | "read_write";
	} | null;
	searchGrants: {
		hasOffice: boolean;
		isOfficer: boolean;
		isSuperadmin: boolean;
	};
	onSignOut: () => void;
	onExitImpersonation: () => void;
	children: React.ReactNode;
}

/**
 * The auth-context shape the shell derives its display props from — the
 * `getAuthContext()` result. `_authed.tsx` and the public shell-wrappers both
 * pass this to `shellPropsFromContext`, so the shell's display fields are derived
 * in exactly ONE place (#317 anti-drift).
 */
export interface ShellContext {
	user: { id: string; name: string; email: string } | null;
	clubs: readonly {
		clubId: string;
		name: string;
		clubNumber: string | null;
		clubRole: "admin" | "member";
	}[];
	currentMemberId: string | null;
	activeClubId: string | null;
	officerPositions: readonly OfficerPosition[];
	isSuperadmin: boolean;
	impersonating: {
		clubName?: string;
		expiresAt: string | Date;
		mode: "read_only" | "read_write";
	} | null;
}

/** The `AppShell` display props — every field except the render/callback props. */
export type AppShellDisplayProps = Omit<
	AppShellProps,
	"children" | "onSignOut" | "onExitImpersonation"
>;

const CLUB_ROLE_LABELS: Record<string, string> = {
	admin: "Officer",
	member: "Member",
};

/**
 * Derive the shell's display props from an auth-context result. The SINGLE
 * source of truth for the shell chrome's display fields, shared by `_authed.tsx`
 * and the public shell-wrappers so the two shells never drift (#317). Only ever
 * called for a signed-in user, so `ctx.user` is non-null (guarded).
 */
export function shellPropsFromContext(ctx: ShellContext): AppShellDisplayProps {
	if (!ctx.user) {
		throw new Error("shellPropsFromContext requires a signed-in user");
	}
	const { clubs, activeClubId, officerPositions, isSuperadmin, impersonating } =
		ctx;
	// The club the workspace is acting in (cookie-backed active club, else first).
	const activeClub = clubs.find((c) => c.clubId === activeClubId) ?? clubs[0];
	const clubName = activeClub?.name ?? "Toastmasters";
	const clubNumber = activeClub?.clubNumber ?? null;
	// Holds an elected office in the active club → gets the Officer home (#202).
	const hasOffice = officerPositions.length > 0;
	// Effective admin (#202): a stored admin OR any elected officer.
	const isOfficer = activeClub?.clubRole === "admin" || hasOffice;
	// Prefer the highest-ranked office label for an officer; else the club role.
	const topOffice = hasOffice
		? [...officerPositions].sort((a, b) => officerRank(a) - officerRank(b))[0]
		: undefined;
	const roleLabel = topOffice
		? officerPositionLabel(topOffice)
		: activeClub?.clubRole
			? (CLUB_ROLE_LABELS[activeClub.clubRole] ?? "Member")
			: "Member";
	const displayName = ctx.user.name || ctx.user.email;
	const initials = initialsOf(displayName);
	return {
		clubs,
		activeClubId,
		clubName,
		clubNumber,
		isOfficer,
		hasOffice,
		isSuperadmin,
		roleLabel,
		displayName,
		initials,
		impersonating,
		searchGrants: { hasOffice, isOfficer, isSuperadmin },
	};
}

/**
 * The page title in the top bar. A nav destination is titled from the registry
 * (`${group} · ${label}`), so it cannot disagree with the sidebar; the arms
 * here are only for pages that are not nav destinations.
 */
export function crumbFor(pathname: string): string {
	const meetings = navGroup("meetings").label;
	if (pathname.startsWith("/members/"))
		return `${navDestination("roster").label} · Member profile`;
	if (/^\/club\/[^/]+\/meeting(\/|$)/.test(pathname))
		return `${meetings} · Meeting`;
	// The archive index (#375) is Past meetings; deeper `/meetings/:id` is the
	// redirect to a meeting.
	if (/^\/meetings\/[^/]/.test(pathname)) return `${meetings} · Meeting`;
	const destination = destinationFor(pathname);
	if (destination) return crumbOf(destination);
	// `/superadmin/:clubId` — Superadmin is `exact` in the nav, so a club's
	// page under it does not highlight it, but it is still that console.
	if (pathname.startsWith("/superadmin/"))
		return crumbOf(navDestination("superadmin"));
	if (pathname.startsWith("/admin"))
		return `${navGroup("setup").label} · Admin`;
	return "Workspace";
}

export function AppShell({
	clubs,
	activeClubId,
	clubName,
	clubNumber,
	isOfficer,
	hasOffice,
	isSuperadmin,
	roleLabel,
	displayName,
	initials,
	impersonating,
	searchGrants,
	onSignOut,
	onExitImpersonation,
	children,
}: AppShellProps) {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	// Mobile nav drawer (shown below `lg`; the sidebar is fixed at `lg+`).
	const [navOpen, setNavOpen] = useState(false);
	// Lets Escape clear open drawer-search results before closing the drawer.
	const drawerSearchRef = useRef<GlobalSearchHandle>(null);

	const sidebar = (
		onNavigate?: () => void,
		showThemeToggle = false,
		searchSlot?: ReactNode,
	) => (
		<SidebarInner
			clubName={clubName}
			clubNumber={clubNumber}
			grants={{ hasOffice, isOfficer, isSuperadmin }}
			pathname={pathname}
			displayName={displayName}
			roleLabel={roleLabel}
			initials={initials}
			onSignOut={onSignOut}
			onNavigate={onNavigate}
			showThemeToggle={showThemeToggle}
			searchSlot={searchSlot}
		/>
	);

	return (
		<div className="flex min-h-svh w-full font-sans text-[var(--sea-ink)]">
			{/* Desktop sidebar (lg+). A fixed-height flex column and NOT itself a
			    scroller — `SidebarInner` puts the scroller on its middle band so the
			    brand and the sign-out footer stay put. The height is load-bearing
			    either way: pinned at `h-svh` this box can never grow, and `sticky`
			    means the document scroll cannot reveal what spills out of it, so an
			    officer+superadmin nav (~28 items) had ~700px of items reachable by
			    nothing at all. */}
			<aside className="sticky top-0 hidden h-svh w-[248px] shrink-0 flex-col gap-1.5 border-r border-[var(--line)] bg-[linear-gradient(180deg,var(--surface-strong),var(--surface))] px-3.5 py-4 backdrop-blur-[6px] lg:flex">
				{sidebar()}
			</aside>

			{/* Mobile nav drawer (below lg) */}
			<Sheet open={navOpen} onOpenChange={setNavOpen}>
				<SheetContent
					side="left"
					// `overflow-hidden`, not `overflow-y-auto`: the drawer used to be
					// the scroller, which scrolled the search box and sign-out away
					// with the nav. `SidebarInner`'s middle band scrolls instead, and
					// the drawer has to stop scrolling for that band to be the thing
					// that overflows.
					className="w-[284px] max-w-[86vw] gap-1.5 overflow-hidden border-[var(--line)] bg-[linear-gradient(180deg,var(--surface-strong),var(--surface))] px-3.5 py-4 sm:max-w-[86vw] lg:hidden"
					onEscapeKeyDown={(e) => {
						// Escape clears open search results first; only a second
						// Escape (nothing left to clear) closes the drawer.
						if (drawerSearchRef.current?.clearResults()) e.preventDefault();
					}}
					onOpenAutoFocus={(e) => {
						// The search input is now the drawer's first tabbable —
						// don't autofocus it (that pops the phone keyboard over
						// the nav). Focus the drawer itself; Tab reaches search.
						e.preventDefault();
						(e.currentTarget as HTMLElement | null)?.focus();
					}}
				>
					<SheetTitle className="sr-only">Navigation</SheetTitle>
					{sidebar(
						() => setNavOpen(false),
						true,
						<GlobalSearch
							ref={drawerSearchRef}
							variant="inline"
							clubId={activeClubId}
							grants={searchGrants}
							onNavigate={() => setNavOpen(false)}
						/>,
					)}
				</SheetContent>
			</Sheet>

			<main className="flex min-w-0 flex-1 flex-col">
				{impersonating ? (
					<ImpersonationBanner
						clubName={clubName}
						expiresAt={impersonating.expiresAt}
						mode={impersonating.mode}
						onExit={onExitImpersonation}
					/>
				) : null}
				{/* Desktop header (lg+) */}
				<header
					className={`sticky z-10 ${impersonating ? "top-9" : "top-0"} hidden items-center gap-3.5 border-b border-[var(--line)] bg-[var(--surface)] px-7 py-4 backdrop-blur-[6px] lg:flex`}
				>
					<div className="text-xs font-semibold tracking-[0.01em] text-[var(--sea-ink-soft)]">
						{crumbFor(pathname)}
					</div>
					<div className="flex-1" />
					<div className="w-[248px] max-w-[34vw]">
						<GlobalSearch clubId={activeClubId} grants={searchGrants} />
					</div>
					<ClubSwitcher
						clubs={clubs}
						activeClubId={activeClubId}
						impersonating={impersonating != null}
					/>
					<ThemeToggle />
					<MemberAvatar tone="palm" initials={initials} size={36} />
				</header>

				{/* Mobile top app-bar (below lg) */}
				<header
					className={`sticky z-10 ${impersonating ? "top-9" : "top-0"} flex items-center gap-2.5 border-b border-[var(--line)] bg-[var(--surface)] px-4 py-3 backdrop-blur-[6px] lg:hidden`}
				>
					<button
						type="button"
						onClick={() => setNavOpen(true)}
						aria-label="Open navigation"
						className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[var(--line)] text-[var(--sea-ink-soft)] transition-colors hover:bg-[var(--foam)] hover:text-[var(--sea-ink)]"
					>
						<Menu className="size-4" aria-hidden />
					</button>
					<div className="min-w-0 flex-1 truncate text-xs font-semibold tracking-[0.01em] text-[var(--sea-ink-soft)]">
						{crumbFor(pathname)}
					</div>
					<ClubSwitcher
						clubs={clubs}
						activeClubId={activeClubId}
						impersonating={impersonating != null}
					/>
				</header>

				<section className="min-w-0 flex-1 overflow-x-hidden">
					{children}
				</section>
				<footer className="border-t border-[var(--line)] px-7 py-3 text-center text-[11px] leading-relaxed text-[var(--sea-ink-soft)]">
					{TOASTMASTERS_DISCLAIMER}
				</footer>
			</main>
			<Toaster position="top-center" />
		</div>
	);
}

function SidebarInner({
	clubName,
	clubNumber,
	grants,
	pathname,
	displayName,
	roleLabel,
	initials,
	onSignOut,
	onNavigate,
	showThemeToggle,
	searchSlot,
}: {
	clubName: string;
	clubNumber: string | null;
	grants: NavGrants;
	pathname: string;
	displayName: string;
	roleLabel: string;
	initials: string;
	onSignOut: () => void;
	onNavigate?: () => void;
	showThemeToggle?: boolean;
	/** Global search rendered below the brand (mobile drawer only, #221). */
	searchSlot?: ReactNode;
}) {
	// Three bands, and the middle one is the only scroller: brand (and the
	// drawer's search) pinned at the top, the nav groups scrolling between
	// them, the mini-profile pinned at the bottom. Both hosts — the `lg+`
	// `<aside>` and the mobile `SheetContent` — are fixed-height flex columns,
	// so this shape works unchanged in either.
	//
	// Scrolling the WHOLE column instead is what this replaced, and it took
	// sign-out with it: at ~28 nav items (officer + superadmin) the profile
	// footer sits ~700px down a 600px-tall rail, so the one control that ends
	// a session was behind a scroll on every page. `min-h-0` on the middle
	// band is what makes it a scroller rather than a growing box — a flex item
	// defaults to `min-height: auto`, which refuses to shrink below its
	// content and hands the overflow back to the column.
	return (
		<>
			{/* Brand */}
			<div className="shrink-0 px-2 pt-1.5 pb-4">
				<BrandMark
					size="md"
					subtitle={clubNumber ? `${clubName} · Club ${clubNumber}` : clubName}
				/>
			</div>

			{searchSlot ? (
				<div className="shrink-0 px-0.5 pb-2">{searchSlot}</div>
			) : null}

			<div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overscroll-contain">
				<SidebarNav
					grants={grants}
					pathname={pathname}
					onNavigate={onNavigate}
				/>
			</div>

			{/* Footer mini-profile. `shrink-0`, not `mt-auto`: the scrolling band
			    above already absorbs the free space, so this sits at the bottom
			    whether the nav overflows or not — and must not be squeezed when it
			    does. */}
			<div className="flex shrink-0 items-center gap-2.5 rounded-xl border border-[var(--line)] bg-[var(--foam)] p-2.5">
				<MemberAvatar tone="palm" initials={initials} size={34} />
				<div className="min-w-0 leading-tight">
					<div className="truncate text-sm font-bold">{displayName}</div>
					<div className="text-xs text-[var(--sea-ink-soft)]">{roleLabel}</div>
				</div>
				<div className="ml-auto flex shrink-0 items-center gap-1">
					{showThemeToggle ? <ThemeToggle /> : null}
					<button
						type="button"
						onClick={onSignOut}
						title="Sign out"
						className="flex size-7 items-center justify-center rounded-md text-[var(--sea-ink-soft)] transition-colors hover:bg-[var(--surface-strong)] hover:text-[var(--sea-ink)]"
					>
						<LogOut className="size-4" aria-hidden />
						<span className="sr-only">Sign out</span>
					</button>
				</div>
			</div>
		</>
	);
}

/**
 * The nav groups and their items, read from the registry
 * (`#/lib/nav-destinations`). A group this user can see nothing in renders
 * nothing — no orphan header. Exported for its tests; `SidebarInner` is the only
 * caller.
 */
export function SidebarNav({
	grants,
	pathname,
	onNavigate,
}: {
	grants: NavGrants;
	pathname: string;
	onNavigate?: () => void;
}) {
	const visible = visibleDestinations(grants);
	const current = destinationFor(pathname);
	return (
		<>
			{NAV_GROUPS.map((group) => {
				const items = visible.filter((d) => d.group === group.key);
				if (items.length === 0) return null;
				return (
					<NavGroup
						key={group.key}
						group={group}
						// A group holding the page you are on is shown open whatever
						// its stored state, so the highlighted entry is never hidden.
						forcedOpen={items.some((d) => d.key === current?.key)}
					>
						{items.map((d) => (
							<NavItem
								key={d.key}
								destination={d}
								active={d.key === current?.key}
								onNavigate={onNavigate}
							/>
						))}
					</NavGroup>
				);
			})}
		</>
	);
}

/** Per-browser memory of a collapsible group's open state, `nav.<key>.open`. */
export function navGroupStorageKey(key: string): string {
	return `nav.${key}.open`;
}

function readStoredOpen(storageKey: string): boolean {
	try {
		return window.localStorage.getItem(storageKey) === "1";
	} catch {
		return false;
	}
}

function writeStoredOpen(storageKey: string, open: boolean): void {
	try {
		window.localStorage.setItem(storageKey, open ? "1" : "0");
	} catch {
		// Storage blocked (private window, sandbox): the toggle still works for
		// this page view, it just is not remembered.
	}
}

const GROUP_LABEL_CLASS =
	"text-xs font-extrabold tracking-[0.12em] text-[var(--sea-ink-soft)] uppercase opacity-70";

function NavGroup({
	group,
	forcedOpen,
	children,
}: {
	group: NavGroupDef;
	forcedOpen: boolean;
	children: React.ReactNode;
}) {
	const panelId = useId();
	const storageKey = navGroupStorageKey(group.key);
	// Collapsed on the server and on the first client render, so hydration
	// agrees; the remembered choice is applied after mount.
	const [storedOpen, setStoredOpen] = useState(false);
	useEffect(() => {
		if (group.collapsible) setStoredOpen(readStoredOpen(storageKey));
	}, [group.collapsible, storageKey]);

	if (!group.collapsible) {
		return (
			<>
				{/* No `first:pt-1` here. It never matched while these labels were direct
				    children of the sidebar column (the brand div was always the first
				    child), and giving the nav its own scrolling band would have made the
				    first label `:first-child` for the first time — silently tightening
				    the gap under the brand by 10px as a side effect of a scroll fix. */}
				<div className={`px-2.5 pt-3.5 pb-0.5 ${GROUP_LABEL_CLASS}`}>
					{group.label}
				</div>
				{children}
			</>
		);
	}

	const open = forcedOpen || storedOpen;
	return (
		<>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={panelId}
				// Forced open because the current page is inside it: collapsing would
				// hide the highlighted entry, and the forced state is never stored.
				disabled={forcedOpen}
				onClick={() => {
					const next = !storedOpen;
					setStoredOpen(next);
					writeStoredOpen(storageKey, next);
				}}
				className={`flex w-full items-center gap-1.5 rounded-md px-2.5 pt-3.5 pb-0.5 text-left transition-opacity enabled:hover:opacity-100 ${GROUP_LABEL_CLASS}`}
			>
				<span>{group.label}</span>
				<ChevronRight
					className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`}
					aria-hidden
				/>
			</button>
			<div
				id={panelId}
				hidden={!open}
				className={open ? "flex flex-col gap-1.5" : "hidden"}
			>
				{children}
			</div>
		</>
	);
}

function NavItem({
	destination,
	active,
	onNavigate,
}: {
	destination: RegisteredDestination;
	/** From `destinationFor`, not the router's own match, so an
	 *  `alsoActiveOn` sibling page highlights its entry too. */
	active: boolean;
	onNavigate?: () => void;
}) {
	const Icon: ComponentType<{ className?: string }> = destination.icon;
	return (
		<Link
			to={destination.to}
			onClick={onNavigate}
			// The router's own match still stamps `aria-current` on an active link,
			// so its idea of "active" must agree with `destinationFor`'s: `exact`
			// keeps Superadmin from matching under Duplicate people.
			activeOptions={{ exact: "exact" in destination && destination.exact }}
			aria-current={active ? "page" : undefined}
			className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm tracking-[0.01em] transition-colors ${
				active
					? "bg-[var(--sand)] font-bold text-[var(--sea-ink)] [&_svg]:opacity-100"
					: "font-medium text-[var(--sea-ink-soft)] hover:bg-[var(--foam)] [&_svg]:opacity-70"
			}`}
		>
			<Icon className="size-4" />
			{destination.label}
		</Link>
	);
}
