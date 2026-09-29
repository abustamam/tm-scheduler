import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { CharterDashboard } from "#/components/club/charter-dashboard";
import { PageContainer } from "#/components/page-container";
import { effectiveAdminClub } from "#/lib/effective-admin";
import { getCharterDashboard } from "#/server/charter";

// The charter dashboard (#943). Admin-only, like every `/admin/*` page; the
// server fn is the real gate (`requireClubAdminView`). A chartered club gets
// the official-requirements note and a line saying the dashboard is closed —
// its rows are kept, not shown.
export const Route = createFileRoute("/_authed/admin/charter")({
	beforeLoad: ({ context }) => {
		const club = effectiveAdminClub(context);
		if (!club) throw redirect({ to: "/dashboard" });
		return { charterClubId: club.clubId };
	},
	loader: async ({ context }) => {
		const dashboard = await getCharterDashboard({
			data: { clubId: context.charterClubId },
		});
		return { clubId: context.charterClubId, dashboard };
	},
	component: CharterPage,
});

function CharterPage() {
	const { clubId, dashboard } = Route.useLoaderData();
	const router = useRouter();
	return (
		<PageContainer>
			<CharterDashboard
				// Remount the forms on a fresh load so their fields show what saved.
				key={JSON.stringify(dashboard)}
				clubId={clubId}
				dashboard={dashboard}
				onChanged={() => router.invalidate()}
			/>
		</PageContainer>
	);
}
