import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { MeetingPresent } from "#/components/agenda/meeting-present";
import { OfflineBadge } from "#/components/agenda/offline-badge";
import { buildSlideDeck } from "#/lib/agenda-slides";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { getPublicMeetingByKey } from "#/server/meetings";

export const Route = createFileRoute(
	"/club/$clubId_/meeting/$meetingId/present",
)({
	loader: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		const data = await getPublicMeetingByKey({
			data: { clubId: club.id, key: params.meetingId },
		});
		if (data.meeting.clubId !== club.id) throw notFound();
		return data;
	},
	component: PresentPage,
	head: () => ({
		meta: [{ name: "robots", content: "noindex, nofollow" }],
	}),
});

function PresentPage() {
	const data = Route.useLoaderData();
	const { clubId, meetingId } = Route.useParams();
	const navigate = useNavigate();
	const deck = buildSlideDeck({
		meeting: data.meeting,
		club: {
			name: data.clubName,
			clubNumber: data.clubNumber,
			district: data.clubDistrict,
			timezone: data.timezone,
			meetingSchedule: data.clubMeetingSchedule,
		},
		slots: data.slots,
		nextMeetingAt: data.nextMeetingAt,
		meetingNumber: data.meetingNumber,
		geIntroducesFunctionaries: data.geIntroducesFunctionaries,
	});
	return (
		<MeetingPresent
			deck={deck}
			clubName={data.clubName}
			// Rendered inside the deck's top-right chrome instead of floating over
			// the slide (#361); the offline banner still pins itself top-center.
			offlineBadge={<OfflineBadge id={meetingId} />}
			onExit={() =>
				navigate({
					to: "/club/$clubId/meeting/$meetingId",
					params: { clubId, meetingId },
				})
			}
		/>
	);
}
