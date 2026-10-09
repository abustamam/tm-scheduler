import {
	createFileRoute,
	Outlet,
	redirect,
	useRouter,
	useRouterState,
} from "@tanstack/react-router";
import { toast } from "sonner";
import { AppShell, shellPropsFromContext } from "#/components/app-shell";
import { ConnectedAppsSection } from "#/components/connected-apps-section";
import { ClublessFrame, NoClubScreen } from "#/components/no-club-screen";
import { authClient } from "#/lib/auth-client";
import { clublessMayOpen } from "#/lib/clubless-routes";
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
			archivedClubCount: ctx.archivedClubCount,
			areas: ctx.areas,
		};
	},
	component: WorkspaceLayout,
});

function WorkspaceLayout() {
	const {
		authUser,
		clubs,
		currentMemberId,
		activeClubId,
		officerPositions,
		isSuperadmin,
		impersonating,
		archivedClubCount,
		areas,
	} = Route.useRouteContext();
	const router = useRouter();
	// Chosen on the ROUTES the router matched, not the URL's text: it matches
	// case-insensitively, so `/AREA/<id>` is the area page (`clubless-routes.ts`).
	// A boolean out of `select`, so the layout re-renders when the answer changes
	// and not on every router update.
	const clublessMayOpenPage = useRouterState({
		select: (s) =>
			clublessMayOpen(
				s.matches.map((m) => m.routeId),
				{
					hasAreas: areas.length > 0,
					isSuperadmin,
				},
			),
	});

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
		// The exceptions (#1119): an Area Director's `/area/<id>` and a
		// superadmin's `/superadmin` need no club, so they render in a minimal
		// frame. The pages keep their own gates; this only picks the frame.
		if (clublessMayOpenPage) {
			return (
				<ClublessFrame onSignOut={handleSignOut}>
					<Outlet />
				</ClublessFrame>
			);
		}
		return (
			<NoClubScreen
				email={authUser.email}
				onSignOut={handleSignOut}
				isSuperadmin={isSuperadmin}
				areas={areas}
				hasArchivedClub={archivedClubCount > 0}
				// A club-less person never reaches `/me`, so a grant they still
				// hold would otherwise be undisconnectable (#851).
				accountControls={<ConnectedAppsSection hideWhenEmpty />}
			/>
		);
	}

	// Derive the shell's display props once (shared with the public wrappers, #317).
	const shellProps = shellPropsFromContext({
		user: authUser,
		clubs,
		currentMemberId,
		activeClubId,
		officerPositions,
		isSuperadmin,
		impersonating,
		areas,
	});

	return (
		<AppShell
			{...shellProps}
			onSignOut={handleSignOut}
			onExitImpersonation={handleExitImpersonation}
		>
			<Outlet />
		</AppShell>
	);
}
