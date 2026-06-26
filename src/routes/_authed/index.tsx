import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarDays, ChevronRight, MapPin } from "lucide-react";
import { Badge } from "#/components/ui/badge";
import { formatMeetingDate, formatMeetingTime } from "#/lib/format";
import { listUpcomingMeetings } from "#/server/meetings";

export const Route = createFileRoute("/_authed/")({
	loader: async ({ context }) => {
		const clubId = context.clubs[0]?.clubId;
		if (!clubId) {
			return { meetings: [] };
		}
		const meetings = await listUpcomingMeetings({ data: clubId });
		return { meetings };
	},
	component: Schedule,
});

function Schedule() {
	const { meetings } = Route.useLoaderData();

	return (
		<div className="space-y-4">
			<h1 className="text-2xl font-bold tracking-tight">Upcoming meetings</h1>

			{meetings.length === 0 ? (
				<p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
					No upcoming meetings yet.
				</p>
			) : (
				<ul className="space-y-3">
					{meetings.map((m) => (
						<li key={m.id}>
							<Link
								to="/meetings/$id"
								params={{ id: m.id }}
								className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition-colors hover:bg-accent active:bg-accent"
							>
								<div className="flex size-12 shrink-0 flex-col items-center justify-center rounded-lg bg-primary/10 text-primary">
									<CalendarDays className="size-5" aria-hidden />
								</div>
								<div className="min-w-0 flex-1">
									<p className="font-semibold">
										{formatMeetingDate(m.scheduledAt)}
										<span className="font-normal text-muted-foreground">
											{" · "}
											{formatMeetingTime(m.scheduledAt)}
										</span>
									</p>
									<p className="truncate text-sm text-muted-foreground">
										{m.theme ?? "Theme TBD"}
									</p>
									{m.location ? (
										<p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
											<MapPin className="size-3" aria-hidden />
											{m.location}
										</p>
									) : null}
								</div>
								<div className="flex shrink-0 flex-col items-end gap-1">
									{m.openSlots > 0 ? (
										<Badge variant="secondary">{m.openSlots} open</Badge>
									) : (
										<Badge variant="outline">Full</Badge>
									)}
									<ChevronRight
										className="size-4 text-muted-foreground"
										aria-hidden
									/>
								</div>
							</Link>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
