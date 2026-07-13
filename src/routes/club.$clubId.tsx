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
		<div className="flex min-h-svh w-full flex-col bg-background">
			<header className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3 md:px-6">
				<BrandMark size="sm" />
				<span className="min-w-0 flex-1 truncate text-right text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
					{clubNumber ? `${clubName} · Club ${clubNumber}` : clubName}
				</span>
				{/* Bridge to the full signed-in workspace (dashboard, Pathways,
				    resources) — the sign-up sheet stays usable without it. */}
				<Link
					to="/signin"
					search={{ redirect: "/" }}
					className="shrink-0 text-xs font-semibold text-muted-foreground underline underline-offset-2 hover:text-foreground"
				>
					Sign in
				</Link>
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
