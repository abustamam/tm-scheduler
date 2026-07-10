import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { CalendarDays, Loader2, Mic } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { formatMeetingDate, formatMeetingTimeRange } from "#/lib/format";
import { useCurrentMember } from "#/lib/member-identity";
import { listMemberCommitments, listUpcomingMeetings } from "#/server/meetings";
import { releaseSlot } from "#/server/slots";

export const Route = createFileRoute("/club/$clubId/")({
	loader: ({ context }) => listUpcomingMeetings({ data: context.clubUuid }),
	component: ClubHome,
});

function ClubHome() {
	const { clubId } = Route.useParams();
	const upcomingMeetings = Route.useLoaderData();
	const { member, clearMember } = useCurrentMember(clubId);
	const router = useRouter();
	const [busySlotId, setBusySlotId] = useState<string | null>(null);

	const commitments = useQuery({
		queryKey: ["commitments", member?.id],
		queryFn: () => {
			if (!member) return Promise.resolve([]);
			return listMemberCommitments({ data: member.id });
		},
		enabled: !!member,
	});

	async function doRelease(slotId: string) {
		if (!member) return;
		setBusySlotId(slotId);
		try {
			await releaseSlot({ data: { slotId, actorMemberId: member.id } });
			toast.success("Role released.");
			await router.invalidate();
			await commitments.refetch();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusySlotId(null);
		}
	}

	const meetingsWithOpenings = upcomingMeetings.filter((m) => m.openSlots > 0);

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

			{/* Your upcoming roles */}
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
						No roles yet — claim one below.
					</p>
				)}
			</section>

			{/* Meetings with open roles */}
			{meetingsWithOpenings.length > 0 ? (
				<section className="space-y-3">
					<h2 className="text-base font-semibold">Meetings with open roles</h2>
					<ul className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
						{meetingsWithOpenings.map((m) => (
							<li key={m.id}>
								<Link
									to="/club/$clubId/meeting/$meetingId"
									params={{ clubId, meetingId: m.id }}
									className="flex items-center justify-between rounded-xl border bg-card p-4 shadow-sm hover:bg-accent transition-colors"
								>
									<div className="min-w-0">
										<p className="font-medium">
											{formatMeetingDate(m.scheduledAt, m.timezone)}
										</p>
										{m.theme ? (
											<p className="truncate text-sm text-muted-foreground">
												{m.theme}
											</p>
										) : null}
									</div>
									<Badge variant="secondary" className="ml-3 shrink-0">
										{m.openSlots} open
									</Badge>
								</Link>
							</li>
						))}
					</ul>
				</section>
			) : null}

			{/* Browse all meetings */}
			<section className="space-y-3">
				<h2 className="text-base font-semibold">All meetings</h2>
				{upcomingMeetings.length === 0 ? (
					<p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
						No upcoming meetings scheduled.
					</p>
				) : (
					<ul className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
						{upcomingMeetings.map((m) => (
							<li key={m.id}>
								<Link
									to="/club/$clubId/meeting/$meetingId"
									params={{ clubId, meetingId: m.id }}
									className="flex items-center justify-between rounded-xl border bg-card p-4 shadow-sm hover:bg-accent transition-colors"
								>
									<div className="min-w-0">
										<p className="font-medium">
											{formatMeetingDate(m.scheduledAt, m.timezone)}
										</p>
										{m.theme ? (
											<p className="truncate text-sm text-muted-foreground">
												{m.theme}
											</p>
										) : null}
									</div>
									<span className="ml-3 shrink-0 text-sm text-muted-foreground">
										{m.totalSlots - m.openSlots}/{m.totalSlots} filled
									</span>
								</Link>
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}
