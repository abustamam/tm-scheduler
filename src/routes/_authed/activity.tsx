import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageContainer } from "#/components/page-container";
import { formatActivity } from "#/lib/activity-format";
import { formatMeetingDate, formatMeetingTime } from "#/lib/format";
import { listActivity } from "#/server/activity-feed";
import { listClubMembers } from "#/server/club";
import { listUpcomingMeetings } from "#/server/meetings";

export const Route = createFileRoute("/_authed/activity")({
	loader: async ({ context }) => {
		const clubId = context.activeClubId;
		if (!clubId) {
			return { activity: [], meetings: [], members: [] };
		}
		const [activity, meetings, members] = await Promise.all([
			listActivity({ data: { clubId } }),
			listUpcomingMeetings({ data: clubId }),
			listClubMembers({ data: clubId }),
		]);
		return { activity, meetings, members };
	},
	component: ActivityLog,
});

const ALL = "all";

function dayKey(value: Date | string) {
	return formatMeetingDate(value);
}

function ActivityLog() {
	const { activity, meetings, members } = Route.useLoaderData();
	const { activeClubId } = Route.useRouteContext();
	const clubId = activeClubId;

	const [meetingId, setMeetingId] = useState<string>(ALL);
	const [actorMemberId, setActorMemberId] = useState<string>(ALL);

	const filtered = meetingId !== ALL || actorMemberId !== ALL;

	const { data: entries = [], isFetching } = useQuery({
		queryKey: ["activity", clubId, meetingId, actorMemberId],
		queryFn: () =>
			listActivity({
				data: {
					// biome-ignore lint/style/noNonNullAssertion: query is gated on clubId being present
					clubId: clubId!,
					meetingId: meetingId === ALL ? undefined : meetingId,
					actorMemberId: actorMemberId === ALL ? undefined : actorMemberId,
				},
			}),
		enabled: Boolean(clubId),
		initialData: filtered ? undefined : activity,
	});

	// Group entries into consecutive day buckets (rows are already newest-first).
	const groups: { day: string; rows: typeof entries }[] = [];
	for (const entry of entries) {
		const day = dayKey(entry.createdAt);
		const last = groups[groups.length - 1];
		if (last && last.day === day) {
			last.rows.push(entry);
		} else {
			groups.push({ day, rows: [entry] });
		}
	}

	const selectClass =
		"h-9 min-w-[180px] rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] px-3 text-sm font-medium text-[var(--sea-ink)] transition-colors hover:border-[var(--lagoon-deep)]";

	return (
		<PageContainer>
			{/* Header */}
			<div className="mb-5">
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Activity log
				</h1>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					Every change, newest first — read-only.
				</p>
			</div>

			{/* Filters */}
			<div className="mb-5 flex flex-wrap items-center gap-2.5">
				<label className="flex items-center gap-2 text-xs font-semibold text-[var(--sea-ink-soft)]">
					<span className="sr-only">Filter by meeting</span>
					<select
						className={selectClass}
						value={meetingId}
						onChange={(e) => setMeetingId(e.target.value)}
					>
						<option value={ALL}>All meetings</option>
						{meetings.map((m) => (
							<option key={m.id} value={m.id}>
								{formatMeetingDate(m.scheduledAt, m.timezone)}
								{m.theme ? ` · ${m.theme}` : ""}
							</option>
						))}
					</select>
				</label>

				<label className="flex items-center gap-2 text-xs font-semibold text-[var(--sea-ink-soft)]">
					<span className="sr-only">Filter by member</span>
					<select
						className={selectClass}
						value={actorMemberId}
						onChange={(e) => setActorMemberId(e.target.value)}
					>
						<option value={ALL}>All members</option>
						{members.map((m) => (
							<option key={m.id} value={m.id}>
								{m.name}
							</option>
						))}
					</select>
				</label>

				{isFetching ? (
					<span className="text-xs font-medium text-[var(--sea-ink-soft)]">
						Loading…
					</span>
				) : null}
			</div>

			{/* Feed */}
			<div className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] shadow-[0_1px_0_var(--inset-glint)_inset,0_10px_24px_rgba(23,58,64,.05)]">
				{entries.length === 0 ? (
					<p className="px-5 py-16 text-center text-sm text-[var(--sea-ink-soft)]">
						No activity yet.
					</p>
				) : (
					groups.map((group) => (
						<div key={group.day}>
							<div className="border-b border-[var(--line)] bg-[var(--foam)] px-5 py-2 text-xs font-extrabold tracking-[0.08em] text-[var(--sea-ink-soft)] uppercase">
								{group.day}
							</div>
							{group.rows.map((entry) => {
								const { actor, summary } = formatActivity(entry);
								return (
									<div
										key={entry.id}
										className="flex items-start gap-3 border-b border-[var(--line)] px-5 py-3 transition-colors last:border-b-0 hover:bg-[var(--foam)]"
									>
										<span
											className="mt-2 size-2 shrink-0 rounded-full"
											style={{ background: "var(--palm)" }}
											aria-hidden
										/>
										<div className="min-w-0 flex-1 leading-[1.35]">
											<div className="text-sm">
												<span className="font-bold text-[var(--sea-ink)]">
													{actor}
												</span>{" "}
												<span className="text-[var(--sea-ink)]">{summary}</span>
											</div>
											{entry.meetingScheduledAt ? (
												<div className="mt-0.5 text-xs text-[var(--sea-ink-soft)]">
													Meeting ·{" "}
													{formatMeetingDate(entry.meetingScheduledAt)}
												</div>
											) : null}
										</div>
										<time className="shrink-0 text-xs font-medium text-[var(--sea-ink-soft)]">
											{formatMeetingTime(entry.createdAt)}
										</time>
									</div>
								);
							})}
						</div>
					))
				)}
			</div>
		</PageContainer>
	);
}
