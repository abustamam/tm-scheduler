import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, ChevronLeft, ChevronRight, Lock } from "lucide-react";
import { PageContainer } from "#/components/page-container";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { formatArchiveDate, formatMeetingTime } from "#/lib/format";
import { listPastMeetings } from "#/server/meetings";

/** Rows per page. Deliberately NOT the season grid's `PAST_LOOKBACK` — that
 *  2-meeting window is a layout constraint on a role×meeting matrix and has
 *  nothing to do with how deep an archive pages. */
const PAGE_SIZE = 25;

type Search = { page: number };

/**
 * The club's meeting archive (#375), newest first — the surface that answers
 * "find the meeting from three months ago". Every listing surface before this
 * one (`listUpcomingMeetings` behind the club landing page, /activity, /roster,
 * and the meeting nav strip) filtered `scheduledAt >= now`, so a meeting became
 * unreachable the moment it ended unless you still had the URL.
 *
 * Rows link to the CANONICAL meeting page `/club/:clubId/meeting/:key` (#317),
 * not `/meetings/:id` — that sibling route only redirects there.
 */
export const Route = createFileRoute("/_authed/meetings/")({
	validateSearch: (search: Record<string, unknown>): Search => {
		const raw = Number(search.page);
		return { page: Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1 };
	},
	loaderDeps: ({ search }) => ({ page: search.page }),
	loader: async ({ context, deps }) => {
		const clubId = context.activeClubId;
		if (!clubId) return { data: null, page: deps.page };
		return {
			data: await listPastMeetings({
				data: {
					clubId,
					limit: PAGE_SIZE,
					offset: (deps.page - 1) * PAGE_SIZE,
				},
			}),
			page: deps.page,
		};
	},
	component: PastMeetingsPage,
});

function PastMeetingsPage() {
	const { data, page } = Route.useLoaderData();

	return (
		<PageContainer className="space-y-5">
			<div>
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Past meetings
				</h1>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					Every meeting your club has held, newest first.
				</p>
			</div>

			{!data ? (
				<p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
					No club found.
				</p>
			) : data.meetings.length === 0 ? (
				<p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
					{page > 1
						? "Nothing further back than this."
						: "No past meetings yet — once a meeting is over it shows up here."}
				</p>
			) : (
				<ul className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] shadow-[0_1px_0_var(--inset-glint)_inset,0_10px_24px_rgba(23,58,64,.05)]">
					{data.meetings.map((m) => (
						<li
							key={m.id}
							className="border-b border-[var(--line)] last:border-b-0"
						>
							<Link
								to="/club/$clubId/meeting/$meetingId"
								params={{
									clubId: data.clubSlug ?? "",
									meetingId: m.urlKey,
								}}
								className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-3.5 transition-colors hover:bg-[var(--foam)]"
							>
								<span className="min-w-[11.5rem] font-semibold text-sm">
									{formatArchiveDate(m.scheduledAt, data.timezone)}
								</span>
								<span className="min-w-0 flex-1 truncate text-sm text-[var(--sea-ink-soft)]">
									{m.theme ?? (
										<span className="italic">
											{formatMeetingTime(m.scheduledAt, data.timezone)}
										</span>
									)}
								</span>
								{m.meetingNumber != null ? (
									<Badge variant="outline">#{m.meetingNumber}</Badge>
								) : null}
								{m.totalSlots > 0 ? (
									<span className="text-xs text-[var(--sea-ink-soft)]">
										{m.totalSlots - m.openSlots}/{m.totalSlots} roles filled
									</span>
								) : null}
								{m.hasMinutes ? (
									<Badge variant="secondary">
										<CheckCircle2 aria-hidden />
										Minutes
									</Badge>
								) : null}
								{m.status === "completed" ? (
									<Badge variant="outline">
										<Lock aria-hidden />
										Closed out
									</Badge>
								) : null}
							</Link>
						</li>
					))}
				</ul>
			)}

			{data && (page > 1 || data.hasMore) ? (
				<div className="flex items-center justify-between gap-3">
					{page > 1 ? (
						<Button asChild variant="outline" size="sm">
							<Link to="/meetings" search={{ page: page - 1 }}>
								<ChevronLeft aria-hidden />
								Newer
							</Link>
						</Button>
					) : (
						<span />
					)}
					<span className="text-xs text-[var(--sea-ink-soft)]">
						Page {page}
					</span>
					{data.hasMore ? (
						<Button asChild variant="outline" size="sm">
							<Link to="/meetings" search={{ page: page + 1 }}>
								Older
								<ChevronRight aria-hidden />
							</Link>
						</Button>
					) : (
						<span />
					)}
				</div>
			) : null}
		</PageContainer>
	);
}
