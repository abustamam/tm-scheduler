import { createFileRoute, Outlet } from "@tanstack/react-router";
import { RequireMember } from "#/components/club/require-member";
import { Toaster } from "#/components/ui/sonner";

export const Route = createFileRoute("/club/$clubId")({ component: ClubShell });

function ClubShell() {
	const { clubId } = Route.useParams();
	return (
		<div className="mx-auto flex min-h-svh w-full max-w-md flex-col bg-background">
			<RequireMember clubId={clubId}>
				<Outlet />
			</RequireMember>
			<Toaster position="top-center" />
		</div>
	);
}
