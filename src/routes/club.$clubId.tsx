import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { RequireMember } from "#/components/club/require-member";
import { Button } from "#/components/ui/button";
import { Toaster } from "#/components/ui/sonner";
import { resolveClubOrRedirect } from "#/lib/club-route";

export const Route = createFileRoute("/club/$clubId")({
	beforeLoad: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		return { clubUuid: club.id, clubSlug: club.slug };
	},
	component: ClubShell,
	notFoundComponent: ClubNotFound,
});

function ClubShell() {
	const { clubId } = Route.useParams();
	const { clubUuid } = Route.useRouteContext();
	return (
		<div className="mx-auto flex min-h-svh w-full max-w-md flex-col bg-background">
			<RequireMember clubUuid={clubUuid} clubSlug={clubId}>
				<Outlet />
			</RequireMember>
			<Toaster position="top-center" />
		</div>
	);
}

function ClubNotFound() {
	return (
		<div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
			<p className="font-semibold text-lg">Club not found</p>
			<p className="text-muted-foreground text-sm">
				This club doesn't exist, or the link is out of date.
			</p>
			<Button asChild variant="outline">
				<Link to="/">Go home</Link>
			</Button>
		</div>
	);
}
