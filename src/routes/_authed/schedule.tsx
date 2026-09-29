import { createFileRoute, useRouter } from "@tanstack/react-router";
import { SeasonGrid } from "#/components/club/season-grid";
import { PageContainer } from "#/components/page-container";
import { ShareLinkButton } from "#/components/share-link-button";
import { effectiveAdminClub } from "#/lib/effective-admin";
import {
	DEFAULT_PAST_COUNT,
	type Orientation,
	parsePastCount,
	type SeasonGridPast,
} from "#/lib/season-grid-view";
import { getSeasonGrid, type SeasonGridCount } from "#/server/season-grid";

/** `past` is OPTIONAL and absent at the default (#1048): links elsewhere build
 *  `/schedule` search without it, and a default lookback keeps the URL as it
 *  was before the control existed. */
type Search = {
	view: Orientation;
	count: SeasonGridCount;
	past?: SeasonGridPast;
};

export const Route = createFileRoute("/_authed/schedule")({
	validateSearch: (search: Record<string, unknown>): Search => ({
		view: search.view === "roles" ? "roles" : "members",
		count:
			search.count === 4 || search.count === "4"
				? 4
				: search.count === "all"
					? "all"
					: 8,
		...pastSearch(parsePastCount(search.past)),
	}),
	loaderDeps: ({ search }) => ({
		count: search.count,
		past: search.past ?? DEFAULT_PAST_COUNT,
	}),
	loader: async ({ context, deps }) => {
		const clubId = context.activeClubId;
		if (!clubId) return { data: null };
		return {
			data: await getSeasonGrid({
				data: { clubId, count: deps.count, pastCount: deps.past },
			}),
		};
	},
	component: SeasonGridPage,
});

/** `past` as a search fragment: the key is dropped at the default. */
function pastSearch(past: SeasonGridPast): { past?: SeasonGridPast } {
	return past === DEFAULT_PAST_COUNT ? {} : { past };
}

function SeasonGridPage() {
	const { data } = Route.useLoaderData();
	const { view, count, past } = Route.useSearch();
	const context = Route.useRouteContext();
	const { currentMemberId, activeClubId } = context;
	// Officers/admins may mark ANY member unavailable, not just their own row.
	const canManageOthers = !!effectiveAdminClub(context);
	const router = useRouter();
	const navigate = Route.useNavigate();

	return (
		<PageContainer className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Sign-up sheet
				</h1>
				{data?.clubSlug ? (
					<ShareLinkButton
						path={`/club/${data.clubSlug}`}
						label="Copy sign-up sheet link"
					/>
				) : null}
			</div>
			{data ? (
				<SeasonGrid
					data={data}
					orientation={view}
					count={count}
					pastCount={past ?? DEFAULT_PAST_COUNT}
					showContact
					currentMemberId={currentMemberId}
					// Always a session here — this route is under `_authed`, and
					// `currentMemberId` comes from the auth context rather than from a
					// name-pick. Passed explicitly because the grid defaults to the
					// narrow side (#762), so an officer who omitted it would silently
					// lose the release and the un-decline.
					currentMemberSource="session"
					canManageOthers={canManageOthers}
					clubId={activeClubId ?? undefined}
					onOrientationChange={(v) =>
						navigate({ search: (prev) => ({ ...prev, view: v }) })
					}
					onCountChange={(c) =>
						navigate({ search: (prev) => ({ ...prev, count: c }) })
					}
					onPastCountChange={(p) =>
						navigate({
							// Spread `prev` so `view` and `count` ride along. `undefined`
							// at the default drops the key from the URL.
							search: (prev) => ({
								...prev,
								past: pastSearch(p).past,
							}),
						})
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
