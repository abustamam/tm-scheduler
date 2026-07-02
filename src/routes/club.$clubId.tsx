import {
	createFileRoute,
	Link,
	Outlet,
	redirect,
} from "@tanstack/react-router";
import { RequireMember } from "#/components/club/require-member";
import { Button } from "#/components/ui/button";
import { Toaster } from "#/components/ui/sonner";
import { getClubByIdentifier } from "#/server/clubs";

export const Route = createFileRoute("/club/$clubId")({
	beforeLoad: async ({ params, location }) => {
		const club = await getClubByIdentifier({ data: params.clubId });
		// Canonicalize: number/UUID (or wrong-case slug) → the slug URL.
		if (params.clubId !== club.slug) {
			throw redirect({
				href:
					location.pathname.replace(/^\/club\/[^/]+/, `/club/${club.slug}`) +
					location.searchStr,
			});
		}
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
