import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { CalendarPlus } from "lucide-react";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { getNextMeeting } from "#/server/meetings";

/**
 * Shortcut to the club's next meeting. Resolves the active club's soonest upcoming
 * meeting and redirects to its `/meetings/$id` page; when nothing is scheduled
 * (or the user has no club), renders the empty state instead. There is no
 * standalone "agenda" screen — a meeting IS its agenda (#141).
 */
export const Route = createFileRoute("/_authed/next")({
	loader: async ({ context }) => {
		const clubId = context.activeClubId;
		if (!clubId) return { canManage: false };
		const data = await getNextMeeting({ data: clubId });
		if (data.meeting) {
			throw redirect({
				to: "/meetings/$id",
				params: { id: data.meeting.id },
			});
		}
		return { canManage: data.canManage };
	},
	component: NoUpcomingMeeting,
});

function NoUpcomingMeeting() {
	const { canManage } = Route.useLoaderData();
	return (
		<PageContainer>
			<h1 className="font-display text-[30px] font-semibold tracking-[-0.02em]">
				Next meeting
			</h1>
			<div className="mt-7 rounded-2xl border border-dashed border-[var(--line)] bg-[var(--surface)] px-6 py-16 text-center">
				<p className="text-sm text-[var(--sea-ink-soft)]">
					No upcoming meeting is scheduled yet.
				</p>
				{canManage ? (
					<Button asChild size="sm" className="mt-4">
						<Link to="/admin/meetings/new">
							<CalendarPlus className="size-4" aria-hidden />
							Schedule a meeting
						</Link>
					</Button>
				) : null}
			</div>
		</PageContainer>
	);
}
