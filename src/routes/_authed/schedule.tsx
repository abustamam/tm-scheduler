import { createFileRoute, useRouter } from "@tanstack/react-router";
import { SeasonGrid } from "#/components/club/season-grid";
import { PageContainer } from "#/components/page-container";
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
		const clubId = context.activeClubId;
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
	const { currentMemberId } = Route.useRouteContext();
	const router = useRouter();
	const navigate = Route.useNavigate();

	return (
		<PageContainer className="space-y-4">
			<h1 className="font-display text-[30px] font-semibold tracking-[-0.02em]">
				Season grid
			</h1>
			{data ? (
				<SeasonGrid
					data={data}
					orientation={view}
					count={count}
					currentMemberId={currentMemberId}
					onOrientationChange={(v) =>
						navigate({ search: (prev) => ({ ...prev, view: v }) })
					}
					onCountChange={(c) =>
						navigate({ search: (prev) => ({ ...prev, count: c }) })
					}
					onChanged={() => router.invalidate()}
				/>
			) : (
				<p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
					No club found.
				</p>
			)}
		</PageContainer>
	);
}
