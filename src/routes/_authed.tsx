import {
	createFileRoute,
	Link,
	Outlet,
	redirect,
	useRouter,
	useRouterState,
} from "@tanstack/react-router";
import {
	BookOpen,
	CalendarDays,
	Grid3x3,
	LayoutGrid,
	List,
	ListChecks,
	LogOut,
	ScrollText,
	Settings,
} from "lucide-react";
import type { ComponentType } from "react";
import { BrandMark } from "#/components/brand-mark";
import { MemberAvatar } from "#/components/club/member-avatar";
import { ThemeToggle } from "#/components/club/theme-toggle";
import { Input } from "#/components/ui/input";
import { Toaster } from "#/components/ui/sonner";
import { authClient } from "#/lib/auth-client";
import { initialsOf } from "#/lib/avatar";
import { getAuthContext } from "#/server/auth-context";

export const Route = createFileRoute("/_authed")({
	beforeLoad: async ({ location }) => {
		const ctx = await getAuthContext();
		if (!ctx.user) {
			throw redirect({
				to: "/signin",
				search: { redirect: location.href },
			});
		}
		return {
			authUser: ctx.user,
			clubs: ctx.clubs,
			currentMemberId: ctx.currentMemberId,
		};
	},
	component: WorkspaceLayout,
});

const CLUB_ROLE_LABELS: Record<string, string> = {
	admin: "Officer",
	vpe: "VP Education",
	president: "President",
	member: "Member",
};

function crumbFor(pathname: string): string {
	if (pathname === "/") return "Manage · Roster";
	if (pathname.startsWith("/schedule")) return "Manage · Season grid";
	if (pathname.startsWith("/agenda")) return "Manage · Agenda & roles";
	if (pathname.startsWith("/activity")) return "Manage · Activity";
	if (pathname.startsWith("/dashboard")) return "Me · My dashboard";
	if (pathname.startsWith("/resources")) return "Me · Resources";
	if (pathname.startsWith("/members")) return "Roster · Member profile";
	if (pathname.startsWith("/meetings")) return "Manage · Meeting";
	if (pathname === "/me") return "Me · My roles";
	if (pathname.startsWith("/admin/roles")) return "Manage · Meeting roles";
	if (pathname.startsWith("/admin/club-settings"))
		return "Manage · Club settings";
	if (pathname.startsWith("/admin")) return "Manage · Admin";
	return "Workspace";
}

function WorkspaceLayout() {
	const { authUser, clubs } = Route.useRouteContext();
	const router = useRouter();
	const pathname = useRouterState({ select: (s) => s.location.pathname });

	const clubName = clubs[0]?.name ?? "Toastmasters";
	const clubNumber = clubs[0]?.clubNumber ?? null;
	const isOfficer = clubs.some(
		(c) => c.clubRole === "admin" || c.clubRole === "vpe",
	);
	const roleLabel = clubs[0]?.clubRole
		? (CLUB_ROLE_LABELS[clubs[0].clubRole] ?? "Member")
		: "Member";
	const displayName = authUser.name || authUser.email;
	const initials = initialsOf(displayName);

	async function handleSignOut() {
		await authClient.signOut();
		await router.navigate({ to: "/signin", search: { redirect: "/" } });
	}

	return (
		<div className="flex min-h-svh w-full font-sans text-[var(--sea-ink)]">
			<aside className="sticky top-0 flex h-svh w-[248px] shrink-0 flex-col gap-1.5 border-r border-[var(--line)] bg-[linear-gradient(180deg,var(--surface-strong),var(--surface))] px-3.5 py-[18px] backdrop-blur-[6px]">
				{/* Brand */}
				<div className="px-2 pt-1.5 pb-4">
					<BrandMark
						size="md"
						subtitle={
							clubNumber ? `${clubName} · Club ${clubNumber}` : clubName
						}
					/>
				</div>

				<NavGroup label="Manage">
					<NavItem to="/schedule" icon={Grid3x3} label="Season grid" />
					<NavItem to="/" exact icon={List} label="Roster" />
					<NavItem to="/agenda" icon={CalendarDays} label="Agenda & roles" />
					<NavItem to="/activity" icon={ScrollText} label="Activity" />
					{isOfficer ? (
						<>
							<NavItem
								to="/admin/roles"
								icon={ListChecks}
								label="Meeting roles"
							/>
							<NavItem
								to="/admin/club-settings"
								icon={Settings}
								label="Club settings"
							/>
						</>
					) : null}
				</NavGroup>

				<NavGroup label="Me">
					<NavItem to="/dashboard" icon={LayoutGrid} label="My dashboard" />
					<NavItem to="/resources" icon={BookOpen} label="Resources" />
				</NavGroup>

				{/* Footer mini-profile */}
				<div className="mt-auto flex items-center gap-2.5 rounded-xl border border-[var(--line)] bg-[var(--foam)] p-2.5">
					<MemberAvatar tone="palm" initials={initials} size={34} />
					<div className="min-w-0 leading-tight">
						<div className="truncate text-[13px] font-bold">{displayName}</div>
						<div className="text-[11px] text-[var(--sea-ink-soft)]">
							{roleLabel}
						</div>
					</div>
					<button
						type="button"
						onClick={handleSignOut}
						title="Sign out"
						className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--sea-ink-soft)] transition-colors hover:bg-[var(--surface-strong)] hover:text-[var(--sea-ink)]"
					>
						<LogOut className="size-4" aria-hidden />
						<span className="sr-only">Sign out</span>
					</button>
				</div>
			</aside>

			<main className="flex min-w-0 flex-1 flex-col">
				<header className="sticky top-0 z-10 flex items-center gap-3.5 border-b border-[var(--line)] bg-[var(--surface)] px-7 py-4 backdrop-blur-[6px]">
					<div className="text-[12.5px] font-semibold tracking-[0.01em] text-[var(--sea-ink-soft)]">
						{crumbFor(pathname)}
					</div>
					<div className="flex-1" />
					<div className="w-[248px] max-w-[34vw]">
						<Input
							type="search"
							placeholder="Search members, roles…"
							className="h-9 rounded-[10px] border-[var(--line)] bg-[var(--surface-strong)]"
						/>
					</div>
					<ThemeToggle />
					<MemberAvatar tone="palm" initials={initials} size={36} />
				</header>

				<section className="min-w-0 flex-1 overflow-x-hidden">
					<Outlet />
				</section>
			</main>
			<Toaster position="top-center" />
		</div>
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
			<div className="px-2.5 pt-3.5 pb-0.5 text-[10.5px] font-extrabold tracking-[0.12em] text-[var(--sea-ink-soft)] uppercase opacity-70 first:pt-1">
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
}: {
	to: string;
	label: string;
	icon: ComponentType<{ className?: string }>;
	exact?: boolean;
}) {
	return (
		<Link
			to={to}
			activeOptions={{ exact }}
			className="flex w-full items-center gap-[11px] rounded-[10px] px-3 py-[9px] text-left text-[13.5px] tracking-[0.01em] transition-colors"
			activeProps={{
				className:
					"bg-[var(--sand)] font-bold text-[var(--sea-ink)] [&_svg]:opacity-100",
			}}
			inactiveProps={{
				className:
					"font-medium text-[var(--sea-ink-soft)] hover:bg-[var(--foam)] [&_svg]:opacity-70",
			}}
		>
			<Icon className="size-[17px]" />
			{label}
		</Link>
	);
}
