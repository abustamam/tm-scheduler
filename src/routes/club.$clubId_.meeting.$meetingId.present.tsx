import { createFileRoute, notFound } from "@tanstack/react-router";
import { MeetingPresent } from "#/components/agenda/meeting-present";
import { buildSlideDeck } from "#/lib/agenda-slides";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { getMeeting } from "#/server/meetings";

export const Route = createFileRoute(
	"/club/$clubId_/meeting/$meetingId/present",
)({
	loader: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		const data = await getMeeting({ data: params.meetingId });
		if (data.meeting.clubId !== club.id) throw notFound();
		return data;
	},
	component: PresentPage,
});

function PresentPage() {
	const data = Route.useLoaderData();
	const deck = buildSlideDeck(
		data.meeting,
		{
			name: data.clubName,
			clubNumber: data.clubNumber,
			district: data.clubDistrict,
			timezone: data.timezone,
			meetingSchedule: data.clubMeetingSchedule,
		},
		data.slots,
	);
	return <MeetingPresent deck={deck} />;
}
