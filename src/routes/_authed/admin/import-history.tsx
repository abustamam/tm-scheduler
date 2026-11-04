import { createFileRoute, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PageContainer } from "#/components/page-container";
import { effectiveAdminClub } from "#/lib/effective-admin";
import { navPageTitle } from "#/lib/page-title";

// Moves a club's Easy-Speak history in (#1492). The page gate is the same
// effective-admin test as the other admin pages, and it only decides who SEES the
// page: every server fn behind the panel re-asks `requireHistoryImportRunner`
// for this club. Loaded on demand so the page does not pull in the import's
// server fns until an admin opens it.
const ImportHistoryPanel = lazy(() =>
	import("#/components/club/import-history-panel").then((m) => ({
		default: m.ImportHistoryPanel,
	})),
);

export const Route = createFileRoute("/_authed/admin/import-history")({
	beforeLoad: ({ context }) => {
		const adminClub = effectiveAdminClub(context);
		if (!adminClub) {
			throw redirect({ to: "/dashboard" });
		}
		return { adminClub };
	},
	component: ImportHistory,
	head: ({ match }) => ({
		meta: [{ title: navPageTitle("/admin/import-history", match.context) }],
	}),
});

function ImportHistory() {
	const { adminClub } = Route.useRouteContext();
	return (
		<PageContainer className="space-y-6">
			<div>
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Import from Easy-Speak
				</h1>
				<p className="text-sm text-muted-foreground">
					Bring {adminClub.name}'s meeting history over from Easy-Speak.
				</p>
			</div>
			<Suspense
				fallback={<p className="text-sm text-muted-foreground">Loading...</p>}
			>
				<ImportHistoryPanel
					clubId={adminClub.clubId}
					clubName={adminClub.name}
					isSuperadmin={false}
				/>
			</Suspense>
		</PageContainer>
	);
}
