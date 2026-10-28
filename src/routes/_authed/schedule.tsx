import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { CalendarX, Printer, Share2 } from "lucide-react";
import { useSyncExternalStore } from "react";
import { SeasonGrid } from "#/components/club/season-grid";
import { PageContainer } from "#/components/page-container";
import { copyShareLink } from "#/components/share-link-button";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { effectiveAdminClub } from "#/lib/effective-admin";
import { formatMeetingDate } from "#/lib/format";
import {
	DEFAULT_PAST_COUNT,
	type Orientation,
	readPastCount,
	type SeasonGridPast,
} from "#/lib/season-grid-view";
import {
	type CancelledMeetingRow,
	listCancelledMeetings,
} from "#/server/meetings";
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
		...pastSearch(readPastCount(search.past)),
	}),
	loaderDeps: ({ search }) => ({
		count: search.count,
		past: search.past ?? DEFAULT_PAST_COUNT,
	}),
	loader: async ({ context, deps }) => {
		const clubId = context.activeClubId;
		const none: CancelledMeetingRow[] = [];
		if (!clubId) return { data: null, cancelled: none };
		// Cancelled meetings (#1057) ride BESIDE the grid, not inside it: every
		// other reader hides them, and the grid is what members and the public
		// sheet read. Asked for only when the viewer is an effective admin — a
		// stored admin or an open office — and the server fn applies the same
		// rule (`requireClubRole(…, ["admin"])`), so a member who called it by
		// hand is refused. The catch is for the officer whose term closed between
		// loads: a schedule with no strip, not a failed page.
		const [data, cancelled] = await Promise.all([
			getSeasonGrid({
				data: { clubId, count: deps.count, pastCount: deps.past },
			}),
			effectiveAdminClub(context)
				? listCancelledMeetings({ data: { clubId } }).catch(() => none)
				: Promise.resolve(none),
		]);
		return { data, cancelled };
	},
	component: SeasonGridPage,
});

/** `past` as a search fragment. A value the viewer picked is ALWAYS written,
 *  2 and 0 included (#1316); only "never picked" leaves the key out, and that
 *  is what lets the responsive default apply. */
function pastSearch(past: SeasonGridPast | undefined): {
	past?: SeasonGridPast;
} {
	return past === undefined ? {} : { past };
}

const PHONE_QUERY = "(max-width: 767px)";
function subscribePhone(cb: () => void) {
	const mq = window.matchMedia(PHONE_QUERY);
	mq.addEventListener("change", cb);
	return () => mq.removeEventListener("change", cb);
}

/** Below `md`. The server snapshot is false, so SSR renders the desktop default
 *  and a phone corrects after hydration as an ordinary update (#1316). */
function useIsPhone(): boolean {
	return useSyncExternalStore(
		subscribePhone,
		() => window.matchMedia(PHONE_QUERY).matches,
		() => false,
	);
}

function SeasonGridPage() {
	const { data, cancelled } = Route.useLoaderData();
	const { view, count, past } = Route.useSearch();
	const context = Route.useRouteContext();
	const { currentMemberId, activeClubId } = context;
	// Officers/admins may mark ANY member unavailable, not just their own row.
	const canManageOthers = !!effectiveAdminClub(context);
	const router = useRouter();
	const navigate = Route.useNavigate();
	// The club key the meeting route takes: the slug when the grid has it, the
	// uuid otherwise. Either resolves (`club.$clubId.tsx`).
	const clubKey = data?.clubSlug ?? activeClubId;
	const isPhone = useIsPhone();

	return (
		<PageContainer className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Sign-up sheet
				</h1>
				{data?.clubSlug ? (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" variant="outline" size="sm">
								<Share2 className="size-4" aria-hidden />
								Share
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem
								onSelect={() => {
									void copyShareLink(`/club/${data.clubSlug}`);
								}}
							>
								Copy sign-up sheet link
							</DropdownMenuItem>
							<DropdownMenuItem
								onSelect={() => {
									void copyShareLink(
										`/club/${data.clubSlug}/next`,
										"Link copied: it always opens the next meeting",
									);
								}}
							>
								Copy next-meeting link
							</DropdownMenuItem>
							<DropdownMenuItem asChild>
								<Link
									to="/club/$clubId/next/tent"
									params={{ clubId: data.clubSlug }}
								>
									<Printer className="size-4" aria-hidden />
									Print table tent
								</Link>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				) : null}
			</div>
			{/* Cancelled meetings (#1057), officers only — the loader asks for
			    them only for an effective admin and the server refuses anyone
			    else, so `cancelled` is empty for a member by construction and
			    `canManageOthers` here is the client half of the same rule. Each
			    is struck through and links by its canonical key (#1396), which
			    reaches it even beside a live meeting that day; reaching it is where
			    Restore lives. */}
			{canManageOthers && cancelled.length > 0 && clubKey ? (
				<section
					aria-label="Cancelled meetings"
					data-testid="cancelled-meetings"
					className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed px-3 py-2 text-sm"
				>
					<span className="flex items-center gap-1.5 font-medium text-muted-foreground">
						<CalendarX className="size-4" aria-hidden />
						Cancelled
					</span>
					{cancelled.map((m) => (
						<Link
							key={m.id}
							to="/club/$clubId/meeting/$meetingId"
							params={{ clubId: clubKey, meetingId: m.urlKey }}
							// `decoration-current` so the strike is the text's own colour;
							// no `hover:underline`, which REPLACES `line-through` (one
							// `text-decoration-line`) and un-strikes the date on hover;
							// `inline-flex min-h-6 items-center` for a 24px target.
							className="inline-flex min-h-6 items-center text-muted-foreground line-through decoration-current hover:text-foreground"
						>
							{formatMeetingDate(m.scheduledAt, m.timezone)}
						</Link>
					))}
				</section>
			) : null}
			{data ? (
				<SeasonGrid
					data={data}
					orientation={view}
					count={count}
					pastCount={past ?? (isPhone ? 0 : DEFAULT_PAST_COUNT)}
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
							// Spread `prev` so `view` and `count` ride along. A picked
							// value is always written, so it beats the phone default.
							search: (prev) => ({
								...prev,
								past: p,
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
