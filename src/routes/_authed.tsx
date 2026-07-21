import {
	createFileRoute,
	Outlet,
	redirect,
	useRouter,
} from "@tanstack/react-router";
import { toast } from "sonner";
import { AppShell } from "#/components/app-shell";
import { NoClubScreen } from "#/components/no-club-screen";
import { authClient } from "#/lib/auth-client";
import { initialsOf } from "#/lib/avatar";
import { officerPositionLabel, officerRank } from "#/lib/officers";
import { getAuthContext } from "#/server/auth-context";
import { endImpersonation } from "#/server/impersonation";

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
			activeClubId: ctx.activeClubId,
			officerPositions: ctx.officerPositions,
			isSuperadmin: ctx.isSuperadmin,
			impersonating: ctx.impersonating,
		};
	},
	component: WorkspaceLayout,
});

const CLUB_ROLE_LABELS: Record<string, string> = {
	admin: "Officer",
	member: "Member",
};

function WorkspaceLayout() {
	const {
		authUser,
		clubs,
		activeClubId,
		officerPositions,
		isSuperadmin,
		impersonating,
	} = Route.useRouteContext();
	const router = useRouter();

	// The club the workspace is currently acting in (cookie-backed, #10).
	const activeClub = clubs.find((c) => c.clubId === activeClubId) ?? clubs[0];
	const clubName = activeClub?.name ?? "Toastmasters";
	const clubNumber = activeClub?.clubNumber ?? null;
	// Holds an elected office in the active club → gets the Officer home (#202).
	const hasOffice = officerPositions.length > 0;
	// Effective admin (#202): a stored admin OR any elected officer sees the
	// admin nav items.
	const isOfficer = activeClub?.clubRole === "admin" || hasOffice;
	// Prefer the office label (highest-ranked) for an officer; else the club role.
	const topOffice = hasOffice
		? [...officerPositions].sort((a, b) => officerRank(a) - officerRank(b))[0]
		: undefined;
	const roleLabel = topOffice
		? officerPositionLabel(topOffice)
		: activeClub?.clubRole
			? (CLUB_ROLE_LABELS[activeClub.clubRole] ?? "Member")
			: "Member";
	const displayName = authUser.name || authUser.email;
	const initials = initialsOf(displayName);

	async function handleSignOut() {
		await authClient.signOut();
		await router.navigate({ to: "/signin", search: { redirect: "/" } });
	}

	async function handleExitImpersonation() {
		try {
			await endImpersonation();
			await router.navigate({ to: "/superadmin" });
			await router.invalidate();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't exit the session.",
			);
		}
	}

	// No club (and not impersonating one) → the workspace nav dead-ends into empty
	// pages, so show a purposeful "you're not in a club yet" screen instead (#267).
	if (clubs.length === 0) {
		return (
			<NoClubScreen
				email={authUser.email}
				onSignOut={handleSignOut}
				isSuperadmin={isSuperadmin}
			/>
		);
	}

	// Which workspace pages the global search may surface for this user.
	const searchGrants = { hasOffice, isOfficer, isSuperadmin };

	return (
		<AppShell
			clubs={clubs}
			activeClubId={activeClubId}
			clubName={clubName}
			clubNumber={clubNumber}
			isOfficer={isOfficer}
			hasOffice={hasOffice}
			isSuperadmin={isSuperadmin}
			roleLabel={roleLabel}
			displayName={displayName}
			initials={initials}
			impersonating={impersonating}
			searchGrants={searchGrants}
			onSignOut={handleSignOut}
			onExitImpersonation={handleExitImpersonation}
		>
			<Outlet />
		</AppShell>
	);
}
