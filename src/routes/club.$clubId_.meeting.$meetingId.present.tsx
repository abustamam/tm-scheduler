import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { MeetingPresent } from "#/components/agenda/meeting-present";
import { OfflineBadge } from "#/components/agenda/offline-badge";
import { useNextMeetingRefresh } from "#/components/agenda/use-next-meeting-refresh";
import { MeetingNotFound } from "#/components/meeting-not-found";
import { resolveAgendaRows } from "#/lib/agenda-runsheet";
import { buildSlideDeck } from "#/lib/agenda-slides";
import { buildTemplateSlideDeck } from "#/lib/agenda-template-slides";
import { clubLogoUrl } from "#/lib/club-logo-url";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { ballotUrlFor } from "#/lib/digital-voting";
import {
	inRoomMeetingPayload,
	inRoomNextMeeting,
} from "#/lib/in-room-meeting-payload";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import { signupUrlFor } from "#/lib/next-meeting-summary";
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
		// Dehydrated into the served document, and this page is public and
		// unauthenticated — so the projection is the withholding, not what the
		// deck below happens to render (#754). See `inRoomMeetingPayload`.
		//
		// That projection covers `nextMeeting` too (#932): the next meeting's
		// line-up rides this payload, narrowed to names and schedule.
		return {
			...inRoomMeetingPayload(data),
			logoUrl: clubLogoUrl(club.id, logoMeta?.updatedAt),
		};
	},
	component: PresentPage,
	notFoundComponent: PresentNotFound,
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
	// Unknown until the effect fires, which is why every vote slide's
	// `ballotUrl` is `""` for that first render — `MeetingPresent` shows a
	// loading state rather than a QR that can't scan. Null when the club or
	// this meeting runs no digital vote (#770): the vote slides still show the
	// nominees for a paper ballot, with no QR and no count.
	const [origin, setOrigin] = useState<string | null>(null);
	useEffect(() => setOrigin(window.location.origin), []);
	const ballotUrl = ballotUrlFor(
		data.digitalVoting,
		{ clubKey: clubId, meetingKey: meetingId },
		origin,
	);
	// What's on tap next (#932): the loader's snapshot, silently refreshed while
	// the deck is up — see `useNextMeetingRefresh` for why a failure never shows.
	// The refresh re-reads the same public payload the loader did (and narrows
	// it the same way), rather than a server fn of its own: that read is already
	// archive-gated, and a second public endpoint would be a second thing to gate.
	const nextMeeting = useNextMeetingRefresh(
		data.nextMeeting ?? null,
		[data.meeting.clubId, meetingId],
		async () =>
			inRoomNextMeeting(
				(
					await getPublicMeetingByKey({
						data: { clubId: data.meeting.clubId, key: meetingId },
					})
				).nextMeeting ?? null,
			),
	);
	// Same origin rule as the ballot: no QR until the browser says where we are.
	const nextMeetingSignupUrl = signupUrlFor(clubId, nextMeeting, origin);
	// The Thank-You splash names the same meeting the slide before it does.
	const nextMeetingAt = nextMeeting
		? new Date(nextMeeting.scheduledAt)
		: data.nextMeetingAt;
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
				nextMeetingAt,
				meetingNumber: data.meetingNumber,
				nextMeeting,
				nextMeetingSignupUrl,
			})
		: buildSlideDeck({
				meeting: data.meeting,
				club,
				slots: data.slots,
				nextMeetingAt,
				meetingNumber: data.meetingNumber,
				nextMeeting,
				nextMeetingSignupUrl,
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

/** A key naming no meeting (#877): the same page every meeting sub-route shows. */
function PresentNotFound() {
	const { clubId } = Route.useParams();
	return <MeetingNotFound clubId={clubId} />;
}
