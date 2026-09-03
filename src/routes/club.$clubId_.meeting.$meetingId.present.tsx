import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { MeetingPresent } from "#/components/agenda/meeting-present";
import { OfflineBadge } from "#/components/agenda/offline-badge";
import { resolveAgendaRows } from "#/lib/agenda-runsheet";
import { buildSlideDeck } from "#/lib/agenda-slides";
import { buildTemplateSlideDeck } from "#/lib/agenda-template-slides";
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
	// The absolute ballot URL is derived in the browser (#510), same as the
	// guest-book QR on the VP Membership page: SSR has no origin, and a QR
	// baked from a relative path is not a URL a phone's camera can resolve.
	// Blank until the effect fires, which is why every vote slide's `ballotUrl`
	// is `""` for that first render — `MeetingPresent` shows a loading state
	// rather than a QR that can't scan.
	const [origin, setOrigin] = useState("");
	useEffect(() => setOrigin(window.location.origin), []);
	const ballotUrl = origin
		? `${origin}/club/${clubId}/meeting/${meetingId}/vote`
		: "";
	const club = {
		name: data.clubName,
		clubNumber: data.clubNumber,
		district: data.clubDistrict,
		timezone: data.timezone,
		meetingSchedule: data.clubMeetingSchedule,
		logoUrl: data.logoUrl,
		tableTopicsMinSeconds: data.tableTopicsMinSeconds,
		tableTopicsMaxSeconds: data.tableTopicsMaxSeconds,
	};
	// Which BUILDER, not whether to build (#agenda-templates PR 2 replaced the
	// notice this used to render). A templated meeting gets the beat-driven deck
	// off the printed run sheet's own rows; a standard one gets the standard
	// deck. Never a mix — the standard builder's slides bind to the seven
	// standard role keys, which a contest does not have.
	const deck = data.template
		? buildTemplateSlideDeck({
				meeting: data.meeting,
				club,
				rows: resolveAgendaRows({
					geIntroducesFunctionaries: data.geIntroducesFunctionaries,
					tableTopicsLimits: {
						minSeconds: data.tableTopicsMinSeconds,
						maxSeconds: data.tableTopicsMaxSeconds,
					},
					template: data.template,
					slots: data.slots,
				}),
				nextMeetingAt: data.nextMeetingAt,
				meetingNumber: data.meetingNumber,
			})
		: buildSlideDeck({
				meeting: data.meeting,
				club,
				slots: data.slots,
				nextMeetingAt: data.nextMeetingAt,
				meetingNumber: data.meetingNumber,
				geIntroducesFunctionaries: data.geIntroducesFunctionaries,
				ballotUrl,
			});
	return (
		<MeetingPresent
			deck={deck}
			clubName={data.clubName}
			// The real DB id, not the pretty URL key above — `getVoteParticipation`
			// keys on it (#510), matching the Ballot Counter console's own query.
			meetingId={data.meeting.id}
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
