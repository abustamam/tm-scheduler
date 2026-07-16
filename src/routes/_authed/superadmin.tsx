import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

/**
 * Superadmin console layout (#182). Gates every child route on the platform
 * superadmin flag (ADR-0016): a normal admin/member who navigates here is
 * bounced to the app. This is the CLIENT redirect; every server fn behind these
 * pages independently enforces `requireSuperadmin`, so the gate is
 * defense-in-depth, not the only check.
 */
export const Route = createFileRoute("/_authed/superadmin")({
	beforeLoad: ({ context }) => {
		if (!context.isSuperadmin) {
			throw redirect({ to: "/roster" });
		}
	},
	component: () => <Outlet />,
});
