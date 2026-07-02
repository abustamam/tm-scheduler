// src/routes/club.$clubId_.meeting.$meetingId.print.tsx
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import {
	type AgendaLayout,
	MeetingAgendaPrint,
} from "#/components/agenda/meeting-agenda-print";
import { buildLegend, expandRunSheet } from "#/lib/agenda-runsheet";
import { buildTimeline } from "#/lib/agenda-timing";
import { formatMeetingDate } from "#/lib/format";
import { getClubByIdentifier } from "#/server/clubs";
import { getMeeting } from "#/server/meetings";

const LAYOUTS: AgendaLayout[] = ["timing", "spacious", "editorial", "grid"];

export const Route = createFileRoute("/club/$clubId_/meeting/$meetingId/print")(
	{
		validateSearch: (
			search: Record<string, unknown>,
		): { layout: AgendaLayout } => {
			const l = search.layout;
			return {
				layout: LAYOUTS.includes(l as AgendaLayout)
					? (l as AgendaLayout)
					: "timing",
			};
		},
		loader: async ({ params, location }) => {
			const club = await getClubByIdentifier({ data: params.clubId });
			if (params.clubId !== club.slug) {
				throw redirect({
					href:
						location.pathname.replace(/^\/club\/[^/]+/, `/club/${club.slug}`) +
						location.searchStr,
				});
			}
			const data = await getMeeting({ data: params.meetingId });
			if (data.meeting.clubId !== club.id) throw notFound();
			return data;
		},
		component: PrintAgenda,
	},
);

function PrintAgenda() {
	const { layout } = Route.useSearch();
	const { meeting, slots, timezone, clubName } = Route.useLoaderData();

	const rows = buildTimeline(
		expandRunSheet(slots),
		meeting.scheduledAt,
		timezone,
	);
	const legend = buildLegend(slots);
	const header = {
		clubName,
		date: formatMeetingDate(meeting.scheduledAt, timezone),
		theme: meeting.theme,
		wordOfTheDay: meeting.wordOfTheDay,
		location: meeting.location,
	};

	return (
		<div>
			<button
				type="button"
				className="no-print"
				onClick={() => window.print()}
				style={{
					position: "fixed",
					top: 12,
					right: 12,
					padding: "8px 14px",
					background: "#173a40",
					color: "#fff",
					border: 0,
					borderRadius: 8,
					cursor: "pointer",
				}}
			>
				Print
			</button>
			<style>{`@media print { .no-print { display: none !important; } @page { size: letter portrait; margin: 0.4in; } }`}</style>
			<MeetingAgendaPrint
				layout={layout}
				header={header}
				legend={legend}
				rows={rows}
			/>
		</div>
	);
}
