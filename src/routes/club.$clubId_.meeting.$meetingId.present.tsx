import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { MeetingPresent } from "#/components/agenda/meeting-present";
import { OfflineBadge } from "#/components/agenda/offline-badge";
import { buildSlideDeck } from "#/lib/agenda-slides";
import { clubLogoUrl } from "#/lib/club-logo-url";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import { getClubLogoMeta } from "#/server/club-logo";
import { getPublicMeetingByKey } from "#/server/meetings";

export const Route = createFileRoute(
	"/club/$clubId_/meeting/$meetingId/present",
)({
	loader: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		// An unknown meeting key is a 404, not a 500: `getPublicMeetingByKey`
		// signals it by throwing, and without this the visitor gets the error
		// boundary instead of the router's not-found page. Same translation the
		// canonical meeting route does.
		// The logo lookup needs only `club.id`, so it runs alongside the meeting
		// fetch rather than after it. `.catch(() => null)` for the same reason the
		// print route has one: the logo is decorative, and an unhandled rejection
		// in this Promise.all would take down the projected deck itself.
		const [data, logoMeta] = await Promise.all([
			getPublicMeetingByKey({
				data: { clubId: club.id, key: params.meetingId },
			}).catch((err) => {
				if (isMeetingNotFoundError(err)) throw notFound();
				throw err;
			}),
			getClubLogoMeta({ data: { clubId: club.id } }).catch(() => null),
		]);
		if (data.meeting.clubId !== club.id) throw notFound();
		return { ...data, logoUrl: clubLogoUrl(club.id, logoMeta?.updatedAt) };
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
			logoUrl: data.logoUrl,
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
