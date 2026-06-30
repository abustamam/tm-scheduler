import { createFileRoute } from "@tanstack/react-router";
import { SeasonGrid } from "#/components/club/season-grid";
import type { Orientation } from "#/lib/season-grid-view";
import { getSeasonGrid, type SeasonGridCount } from "#/server/season-grid";

type Search = { view: Orientation; count: SeasonGridCount };

export const Route = createFileRoute("/_authed/schedule")({
	validateSearch: (search: Record<string, unknown>): Search => ({
		view: search.view === "roles" ? "roles" : "members",
		count:
			search.count === 4 || search.count === "4"
				? 4
				: search.count === "all"
					? "all"
					: 8,
	}),
	loaderDeps: ({ search }) => ({ count: search.count }),
	loader: async ({ context, deps }) => {
		const clubId = context.clubs[0]?.clubId;
		if (!clubId) return { data: null };
		return {
			data: await getSeasonGrid({ data: { clubId, count: deps.count } }),
		};
	},
	component: SeasonGridPage,
});

function SeasonGridPage() {
	const { data } = Route.useLoaderData();
	const { view, count } = Route.useSearch();

	return (
		<div className="space-y-4 p-7">
			<h1 className="text-2xl font-bold tracking-tight">Season grid</h1>
			{data ? (
				<SeasonGrid data={data} orientation={view} count={count} />
			) : (
				<p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
					No club found.
				</p>
			)}
		</div>
	);
}
