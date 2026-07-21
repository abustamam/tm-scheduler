import { Link, useRouterState } from "@tanstack/react-router";
import {
	BookOpen,
	CalendarDays,
	CalendarPlus,
	CalendarRange,
	ClipboardPaste,
	Compass,
	GraduationCap,
	Grid3x3,
	LayoutGrid,
	List,
	ListChecks,
	LogOut,
	Menu,
	Mic,
	RefreshCw,
	ScrollText,
	Settings,
	ShieldCheck,
	Trophy,
	UserPlus,
	Wallet,
} from "lucide-react";
import { type ComponentType, type ReactNode, useRef, useState } from "react";
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
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";

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

function crumbFor(pathname: string): string {
	if (pathname === "/roster") return "Manage · Roster";
	if (pathname.startsWith("/officers")) return "Your office · Officer home";
	if (pathname.startsWith("/schedule")) return "Manage · Sign-up sheet";
	if (pathname.startsWith("/next")) return "Manage · Next meeting";
	if (pathname.startsWith("/activity")) return "Manage · Activity";
	if (pathname.startsWith("/dashboard")) return "Me · My dashboard";
	if (pathname.startsWith("/resources")) return "Me · Resources";
	if (pathname.startsWith("/members")) return "Roster · Member profile";
	if (pathname.startsWith("/admin/meetings/new")) return "Manage · New meeting";
	if (pathname.startsWith("/admin/meetings/batch"))
		return "Manage · Batch meetings";
	if (pathname.startsWith("/meetings")) return "Manage · Meeting";
	if (pathname === "/me") return "Me · My roles";
	if (pathname.startsWith("/admin/dcp")) return "Manage · DCP scoreboard";
	if (pathname.startsWith("/admin/roles")) return "Manage · Meeting roles";
	if (pathname.startsWith("/admin/club-settings"))
		return "Manage · Club settings";
	if (pathname.startsWith("/admin/sync-tokens"))
		return "Manage · Base Camp sync";
	if (pathname.startsWith("/admin/pathways-sync"))
		return "Manage · Manual Pathways sync";
	if (pathname.startsWith("/admin/vpe-dashboard"))
		return "Manage · VP Education";
	if (pathname.startsWith("/admin/vp-membership"))
		return "Manage · VP Membership";
	if (pathname.startsWith("/admin/dues")) return "Manage · Dues";
	if (pathname.startsWith("/admin")) return "Manage · Admin";
	if (pathname.startsWith("/superadmin")) return "Platform · Superadmin";
	return "Workspace";
}

export function AppShell({
	clubs,
	activeClubId,
	clubName,
	clubNumber,
	isOfficer,
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
			isOfficer={isOfficer}
			isSuperadmin={isSuperadmin}
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
			{/* Desktop sidebar (lg+) */}
			<aside className="sticky top-0 hidden h-svh w-[248px] shrink-0 flex-col gap-1.5 border-r border-[var(--line)] bg-[linear-gradient(180deg,var(--surface-strong),var(--surface))] px-3.5 py-4 backdrop-blur-[6px] lg:flex">
				{sidebar()}
			</aside>

			{/* Mobile nav drawer (below lg) */}
			<Sheet open={navOpen} onOpenChange={setNavOpen}>
				<SheetContent
					side="left"
					className="w-[284px] max-w-[86vw] gap-1.5 overflow-y-auto border-[var(--line)] bg-[linear-gradient(180deg,var(--surface-strong),var(--surface))] px-3.5 py-4 sm:max-w-[86vw] lg:hidden"
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
					<ClubSwitcher clubs={clubs} activeClubId={activeClubId} />
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
					<ClubSwitcher clubs={clubs} activeClubId={activeClubId} />
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
	isOfficer,
	isSuperadmin,
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
	isOfficer: boolean;
	isSuperadmin: boolean;
	displayName: string;
	roleLabel: string;
	initials: string;
	onSignOut: () => void;
	onNavigate?: () => void;
	showThemeToggle?: boolean;
	/** Global search rendered below the brand (mobile drawer only, #221). */
	searchSlot?: ReactNode;
}) {
	return (
		<>
			{/* Brand */}
			<div className="px-2 pt-1.5 pb-4">
				<BrandMark
					size="md"
					subtitle={clubNumber ? `${clubName} · Club ${clubNumber}` : clubName}
				/>
			</div>

			{searchSlot ? <div className="px-0.5 pb-2">{searchSlot}</div> : null}

			{isOfficer ? (
				<NavGroup label="Your office">
					<NavItem
						to="/officers"
						icon={Compass}
						label="Officer home"
						onNavigate={onNavigate}
					/>
				</NavGroup>
			) : null}

			<NavGroup label="Manage">
				<NavItem
					to="/schedule"
					icon={Grid3x3}
					label="Sign-up sheet"
					onNavigate={onNavigate}
				/>
				<NavItem
					to="/roster"
					icon={List}
					label="Roster"
					onNavigate={onNavigate}
				/>
				<NavItem
					to="/next"
					icon={CalendarDays}
					label="Next meeting"
					onNavigate={onNavigate}
				/>
				<NavItem
					to="/activity"
					icon={ScrollText}
					label="Activity"
					onNavigate={onNavigate}
				/>
				{isOfficer ? (
					<>
						<NavItem
							to="/admin/vpe-dashboard"
							icon={GraduationCap}
							label="VP Education"
							onNavigate={onNavigate}
						/>
						<NavItem
							to="/admin/vp-membership"
							icon={UserPlus}
							label="VP Membership"
							onNavigate={onNavigate}
						/>
						<NavItem
							to="/admin/dcp"
							icon={Trophy}
							label="DCP scoreboard"
							onNavigate={onNavigate}
						/>
						<NavItem
							to="/admin/dues"
							icon={Wallet}
							label="Dues"
							onNavigate={onNavigate}
						/>
						<NavItem
							to="/admin/meetings/new"
							icon={CalendarPlus}
							label="New meeting"
							onNavigate={onNavigate}
						/>
						<NavItem
							to="/admin/meetings/batch"
							icon={CalendarRange}
							label="Batch meetings"
							onNavigate={onNavigate}
						/>
						<NavItem
							to="/admin/schedule"
							icon={CalendarDays}
							label="Recurring schedule"
							onNavigate={onNavigate}
						/>
						<NavItem
							to="/admin/roles"
							icon={ListChecks}
							label="Meeting roles"
							onNavigate={onNavigate}
						/>
						<NavItem
							to="/admin/club-settings"
							icon={Settings}
							label="Club settings"
							onNavigate={onNavigate}
						/>
						<NavItem
							to="/admin/sync-tokens"
							icon={RefreshCw}
							label="Base Camp sync"
							onNavigate={onNavigate}
						/>
						<NavItem
							to="/admin/pathways-sync"
							icon={ClipboardPaste}
							label="Manual Pathways sync"
							onNavigate={onNavigate}
						/>
					</>
				) : null}
			</NavGroup>

			<NavGroup label="Me">
				<NavItem
					to="/dashboard"
					icon={LayoutGrid}
					label="My dashboard"
					onNavigate={onNavigate}
				/>
				<NavItem to="/me" icon={Mic} label="My roles" onNavigate={onNavigate} />
				<NavItem
					to="/resources"
					icon={BookOpen}
					label="Resources"
					onNavigate={onNavigate}
				/>
			</NavGroup>

			{isSuperadmin ? (
				<NavGroup label="Platform">
					<NavItem
						to="/superadmin"
						icon={ShieldCheck}
						label="Superadmin"
						onNavigate={onNavigate}
					/>
				</NavGroup>
			) : null}

			{/* Footer mini-profile */}
			<div className="mt-auto flex items-center gap-2.5 rounded-xl border border-[var(--line)] bg-[var(--foam)] p-2.5">
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

function NavGroup({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<>
			<div className="px-2.5 pt-3.5 pb-0.5 text-xs font-extrabold tracking-[0.12em] text-[var(--sea-ink-soft)] uppercase opacity-70 first:pt-1">
				{label}
			</div>
			{children}
		</>
	);
}

function NavItem({
	to,
	label,
	icon: Icon,
	exact = false,
	onNavigate,
}: {
	to: string;
	label: string;
	icon: ComponentType<{ className?: string }>;
	exact?: boolean;
	onNavigate?: () => void;
}) {
	return (
		<Link
			to={to}
			onClick={onNavigate}
			activeOptions={{ exact }}
			className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm tracking-[0.01em] transition-colors"
			activeProps={{
				className:
					"bg-[var(--sand)] font-bold text-[var(--sea-ink)] [&_svg]:opacity-100",
			}}
			inactiveProps={{
				className:
					"font-medium text-[var(--sea-ink-soft)] hover:bg-[var(--foam)] [&_svg]:opacity-70",
			}}
		>
			<Icon className="size-4" />
			{label}
		</Link>
	);
}
