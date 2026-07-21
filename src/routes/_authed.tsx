import {
	createFileRoute,
	Outlet,
	redirect,
	useRouter,
} from "@tanstack/react-router";
import { toast } from "sonner";
import { AppShell, shellPropsFromContext } from "#/components/app-shell";
import { NoClubScreen } from "#/components/no-club-screen";
import { authClient } from "#/lib/auth-client";
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

function WorkspaceLayout() {
	const {
		authUser,
		clubs,
		currentMemberId,
		activeClubId,
		officerPositions,
		isSuperadmin,
		impersonating,
	} = Route.useRouteContext();
	const router = useRouter();

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

	// Derive the shell's display props once (shared with the public wrappers, #317).
	const shellProps = shellPropsFromContext({
		user: authUser,
		clubs,
		currentMemberId,
		activeClubId,
		officerPositions,
		isSuperadmin,
		impersonating,
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
