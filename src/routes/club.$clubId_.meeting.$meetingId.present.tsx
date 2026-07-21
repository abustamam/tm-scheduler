import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { MeetingPresent } from "#/components/agenda/meeting-present";
import { OfflineBadge } from "#/components/agenda/offline-badge";
import { buildSlideDeck } from "#/lib/agenda-slides";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { getPublicMeeting } from "#/server/meetings";

export const Route = createFileRoute(
	"/club/$clubId_/meeting/$meetingId/present",
)({
	loader: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		const data = await getPublicMeeting({ data: params.meetingId });
		if (data.meeting.clubId !== club.id) throw notFound();
		return data;
	},
	component: PresentPage,
});

function PresentPage() {
	const data = Route.useLoaderData();
	const { clubId, meetingId } = Route.useParams();
	const navigate = useNavigate();
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
		data.nextMeetingAt,
	);
	return (
		<>
			<OfflineBadge id={meetingId} />
			<MeetingPresent
				deck={deck}
				clubName={data.clubName}
				onExit={() =>
					navigate({
						to: "/club/$clubId/meeting/$meetingId",
						params: { clubId, meetingId },
					})
				}
			/>
		</>
	);
}
