import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { BrandMark } from "#/components/brand-mark";
import { RequireMember } from "#/components/club/require-member";
import { Button } from "#/components/ui/button";
import { Toaster } from "#/components/ui/sonner";
import { resolveClubOrRedirect } from "#/lib/club-route";

export const Route = createFileRoute("/club/$clubId")({
	beforeLoad: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		return {
			clubUuid: club.id,
			clubSlug: club.slug,
			clubName: club.name,
			clubNumber: club.clubNumber,
		};
	},
	component: ClubShell,
	notFoundComponent: ClubNotFound,
});

function ClubShell() {
	const { clubId } = Route.useParams();
	const { clubUuid, clubName, clubNumber } = Route.useRouteContext();
	return (
		<div className="mx-auto flex min-h-svh w-full max-w-md flex-col bg-background">
			<header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
				<BrandMark size="sm" />
				<span className="truncate text-right text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
					{clubNumber ? `${clubName} · Club ${clubNumber}` : clubName}
				</span>
			</header>
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
