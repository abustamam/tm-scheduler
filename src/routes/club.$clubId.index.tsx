import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { CalendarDays, Loader2, Mic } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { SeasonGrid } from "#/components/club/season-grid";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { formatMeetingDate, formatMeetingTimeRange } from "#/lib/format";
import { useCurrentMember } from "#/lib/member-identity";
import type { Orientation } from "#/lib/season-grid-view";
import { listMemberCommitments } from "#/server/meetings";
import {
	getPublicSeasonGrid,
	type SeasonGridCount,
} from "#/server/season-grid";
import { releaseSlot } from "#/server/slots";

type Search = { view: Orientation; count: SeasonGridCount };

export const Route = createFileRoute("/club/$clubId/")({
	// Default to the Roles × Meetings sign-up sheet — the interactive orientation.
	validateSearch: (search: Record<string, unknown>): Search => ({
		view: search.view === "members" ? "members" : "roles",
		count:
			search.count === 4 || search.count === "4"
				? 4
				: search.count === "all"
					? "all"
					: 8,
	}),
	loaderDeps: ({ search }) => ({ count: search.count }),
	loader: ({ context, deps }) =>
		getPublicSeasonGrid({
			data: { clubId: context.clubUuid, count: deps.count },
		}),
	component: ClubHome,
});

function ClubHome() {
	const { clubId } = Route.useParams();
	const { clubUuid } = Route.useRouteContext();
	const grid = Route.useLoaderData();
	const { view, count } = Route.useSearch();
	const { member, clearMember } = useCurrentMember(clubId);
	const router = useRouter();
	const navigate = Route.useNavigate();
	const [busySlotId, setBusySlotId] = useState<string | null>(null);

	const commitments = useQuery({
		queryKey: ["commitments", member?.id],
		queryFn: () => {
			if (!member) return Promise.resolve([]);
			return listMemberCommitments({ data: member.id });
		},
		enabled: !!member,
	});

	async function refetchAll() {
		await router.invalidate();
		await commitments.refetch();
	}

	async function doRelease(slotId: string) {
		if (!member) return;
		setBusySlotId(slotId);
		try {
			await releaseSlot({ data: { slotId, actorMemberId: member.id } });
			toast.success("Role released.");
			await refetchAll();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusySlotId(null);
		}
	}

	return (
		<div className="mx-auto w-full max-w-5xl space-y-6 p-4 pb-8 md:p-6">
			{/* Header */}
			<div className="flex items-center justify-between pt-2">
				<h1 className="font-display text-2xl font-semibold tracking-tight">
					Hi {member?.name ?? "there"} 👋
				</h1>
				{member ? (
					<button
						type="button"
						onClick={clearMember}
						className="text-sm text-muted-foreground underline underline-offset-2"
					>
						not you?
					</button>
				) : null}
			</div>

			{/* Sign-up sheet — the primary surface. Claim an OPEN role or release
			    your own right in the grid; everyone else is greyed out. */}
			<section className="space-y-3">
				<div>
					<h2 className="text-base font-semibold">Sign-up sheet</h2>
					<p className="text-sm text-muted-foreground">
						Tap an <span className="font-medium text-emerald-700">open</span>{" "}
						role to claim it, or your own to release it.
					</p>
				</div>
				<SeasonGrid
					data={grid}
					orientation={view}
					count={count}
					currentMemberId={member?.id ?? null}
					clubId={clubUuid}
					clubSlug={clubId}
					onOrientationChange={(v) =>
						navigate({ search: (prev) => ({ ...prev, view: v }) })
					}
					onCountChange={(c) =>
						navigate({ search: (prev) => ({ ...prev, count: c }) })
					}
					onChanged={refetchAll}
				/>
			</section>

			{/* Your upcoming roles — a compact summary of your commitments. */}
			<section className="space-y-3">
				<h2 className="text-base font-semibold">Your upcoming roles</h2>
				{!member || commitments.isPending ? (
					<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
						{commitments.isFetching ? (
							<span className="flex items-center gap-2">
								<Loader2 className="size-4 animate-spin" aria-hidden />
								Loading your roles…
							</span>
						) : (
							"Loading your roles…"
						)}
					</div>
				) : commitments.data && commitments.data.length > 0 ? (
					<ul className="grid gap-3 md:grid-cols-2">
						{commitments.data.map((c) => (
							<li
								key={c.slotId}
								className="rounded-xl border bg-card p-4 shadow-sm"
							>
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<p className="font-semibold">{c.roleName}</p>
											{c.isSpeakerRole ? (
												<Mic className="size-4 text-primary" aria-hidden />
											) : null}
										</div>
										{c.isSpeakerRole && c.speechTitle ? (
											<p className="text-sm text-muted-foreground">
												&ldquo;{c.speechTitle}&rdquo;
											</p>
										) : null}
										<Link
											to="/club/$clubId/meeting/$meetingId"
											params={{ clubId, meetingId: c.meetingId }}
											className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
										>
											<CalendarDays className="size-4" aria-hidden />
											{formatMeetingDate(c.scheduledAt, c.timezone)} &middot;{" "}
											{formatMeetingTimeRange(
												c.scheduledAt,
												c.lengthMinutes,
												c.timezone,
											)}
											{c.theme ? (
												<span className="truncate"> &middot; {c.theme}</span>
											) : null}
										</Link>
									</div>
									<div className="flex shrink-0 flex-col items-end gap-2">
										<Badge
											variant={
												c.status === "confirmed" ? "default" : "secondary"
											}
										>
											{c.status}
										</Badge>
										<Button
											size="sm"
											variant="outline"
											onClick={() => doRelease(c.slotId)}
											disabled={busySlotId === c.slotId}
										>
											{busySlotId === c.slotId ? (
												<Loader2 className="size-4 animate-spin" />
											) : (
												"Release"
											)}
										</Button>
									</div>
								</div>
							</li>
						))}
					</ul>
				) : (
					<p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
						No roles yet — tap an open role in the sheet above to claim one.
					</p>
				)}
			</section>
		</div>
	);
}
