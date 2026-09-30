import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { ClubAgendasPanel } from "#/components/club/club-agendas-panel";
import { PageContainer } from "#/components/page-container";
import {
	effectiveAdminClub,
	effectiveAdminClubFor,
} from "#/lib/effective-admin";
import { listClubAgendas } from "#/server/club-agendas";

/** The one search key this route reads — see `validateSearch`. */
type AgendasSearch = { club?: string };

/**
 * The club's Agendas page (#910): its own templates, its default agenda, and
 * adopting the standard agenda. Officer-only like every `/admin/*` page; the
 * server fns are the real gate (`requireClubTemplateEditor`, which also
 * refuses an archived club).
 *
 * `?club=<uuid>` mirrors `/admin/club-settings` (#685), whose locked General
 * Evaluator checkbox links here for the club it is showing. Matched against
 * the viewer's OWN admin clubs and refused when it does not resolve, never
 * swapped for the workspace club.
 */
export const Route = createFileRoute("/_authed/admin/agendas")({
	validateSearch: (search: Record<string, unknown>): AgendasSearch => ({
		club: typeof search.club === "string" ? search.club : undefined,
	}),
	beforeLoad: ({ context, search }) => {
		const adminClub = search.club
			? effectiveAdminClubFor(context, search.club)
			: effectiveAdminClub(context);
		if (!adminClub) throw redirect({ to: "/dashboard" });
		return { agendasClubId: adminClub.clubId };
	},
	loader: async ({ context }) => {
		const agendas = await listClubAgendas({
			data: { clubId: context.agendasClubId },
		});
		return { clubId: context.agendasClubId, agendas };
	},
	component: AgendasPage,
});

function AgendasPage() {
	const { clubId, agendas } = Route.useLoaderData();
	const router = useRouter();
	return (
		<PageContainer>
			<ClubAgendasPanel
				clubId={clubId}
				agendas={agendas}
				onChanged={() => router.invalidate()}
			/>
		</PageContainer>
	);
}
