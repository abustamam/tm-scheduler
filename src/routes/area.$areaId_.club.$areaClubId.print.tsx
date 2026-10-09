import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import {
	PRINT_PAGE_CSS,
	PrintButton,
	PrintToolbar,
} from "#/components/agenda/print-theme";
import { AreaClubSummarySheet } from "#/components/area/area-club-summary-sheet";
import { isAreaRefusal } from "#/lib/area-refusal";
import { getAreaClubSummary } from "#/server/area-visits";
import { getAuthContext } from "#/server/auth-context";

/**
 * An Area Director's one-page summary of one club (#1120, ADR-0032): its
 * numbers and both visit dates, laid out to print.
 *
 * Outside `_authed` on purpose, like the meeting print pages: it renders
 * without the app shell, so the sheet is the page. That also means nothing from
 * `_authed.tsx` runs, so `beforeLoad` does its one job here, sending a
 * signed-out visitor to `/signin` and back. `getAreaClubSummary` then checks the
 * caller holds a CURRENT term on THIS area and that the club is in it; a
 * refusal of either renders the standard not-found, the page a link that never
 * existed shows.
 */
export const Route = createFileRoute("/area/$areaId_/club/$areaClubId/print")({
	beforeLoad: async ({ location }) => {
		const ctx = await getAuthContext();
		if (!ctx.user) {
			throw redirect({
				to: "/signin",
				search: { redirect: location.href },
			});
		}
	},
	loader: async ({ params }) => {
		try {
			return await getAreaClubSummary({
				data: { areaId: params.areaId, areaClubId: params.areaClubId },
			});
		} catch (err) {
			if (isAreaRefusal(err)) throw notFound();
			throw err;
		}
	},
	component: AreaClubSummaryPage,
	// The <title> becomes the browser's default "Save as PDF" filename.
	head: ({ loaderData }) => ({
		meta: [
			{
				title: loaderData
					? `${loaderData.club.name} — Club visit summary`
					: "Club visit summary — GavelUp",
			},
			{ name: "robots", content: "noindex, nofollow" },
		],
	}),
});

function AreaClubSummaryPage() {
	const summary = Route.useLoaderData();
	return (
		<div>
			<PrintToolbar>
				<PrintButton />
			</PrintToolbar>
			<style>{PRINT_PAGE_CSS}</style>
			<AreaClubSummarySheet summary={summary} />
		</div>
	);
}
