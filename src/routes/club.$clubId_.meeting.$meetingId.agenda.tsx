// src/routes/club.$clubId_.meeting.$meetingId.agenda.tsx
//
// The digital agenda (#1335): a read-only, phone-first run of show for whoever
// is in the room, guests included. PUBLIC, outside the club shell (`$clubId_`),
// like /print, /present and /word.
//
// The loader reads NO session, and carries nothing about the viewer, so every
// visitor is served byte-identical HTML. The "You" badge is added after
// hydration inside `MeetingRunOfShow`. The meeting goes through
// `inRoomMeetingPayload`, the allowlist that keeps the join link and `notes` out of
// public HTML (#754); the in-room guard test runs this
// loader.

import { createFileRoute, notFound } from "@tanstack/react-router";
import { MeetingRunOfShow } from "#/components/agenda/meeting-run-of-show";
import { MeetingNotFound } from "#/components/meeting-not-found";
import { PublicFooter } from "#/components/public-footer";
import { clubLogoUrl } from "#/lib/club-logo-url";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { APP_LOCALE } from "#/lib/format";
import { inRoomMeetingPayload } from "#/lib/in-room-meeting-payload";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import { getClubLogoMeta } from "#/server/club-logo";
import { getPublicMeetingByKey } from "#/server/meetings";
import { getPublicClubRoles } from "#/server/role-definitions";

export const Route = createFileRoute(
	"/club/$clubId_/meeting/$meetingId/agenda",
)({
	loader: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		// Parallel, and the logo and the role descriptions are non-fatal: neither
		// is worth costing anyone the agenda. An unknown meeting key is a 404, not
		// a 500.
		const [data, logoMeta, roles] = await Promise.all([
			getPublicMeetingByKey({
				data: { clubId: club.id, key: params.meetingId },
			}).catch((err) => {
				if (isMeetingNotFoundError(err)) throw notFound();
				throw err;
			}),
			getClubLogoMeta({ data: { clubId: club.id } }).catch(() => null),
			getPublicClubRoles({ data: club.id }).catch(() => []),
		]);
		if (data.meeting.clubId !== club.id) throw notFound();

		// Keyed by role key, falling back to name; only roles with a description.
		const roleDescriptions: Record<string, string> = {};
		for (const role of roles) {
			if (!role.description) continue;
			roleDescriptions[role.key ?? role.name] = role.description;
		}

		return {
			...inRoomMeetingPayload(data),
			logoUrl: clubLogoUrl(club.id, logoMeta?.updatedAt),
			cancelled: data.meeting.status === "cancelled",
			roleDescriptions,
		};
	},
	component: DigitalAgenda,
	notFoundComponent: AgendaNotFound,
	head: ({ loaderData }) => {
		const date = loaderData
			? new Intl.DateTimeFormat(APP_LOCALE, {
					month: "short",
					day: "numeric",
					year: "numeric",
					timeZone: loaderData.timezone,
				}).format(new Date(loaderData.meeting.scheduledAt))
			: null;
		return {
			meta: [
				{
					title: loaderData
						? `${loaderData.clubName} agenda · ${date}`
						: "Agenda — GavelUp",
				},
				{ name: "robots", content: "noindex, nofollow" },
			],
		};
	},
});

function DigitalAgenda() {
	const { clubId, meetingId } = Route.useParams();
	const data = Route.useLoaderData();
	return (
		<>
			<MeetingRunOfShow
				clubParam={clubId}
				meetingParam={meetingId}
				meeting={data.meeting}
				slots={data.slots}
				timezone={data.timezone}
				clubName={data.clubName}
				logoUrl={data.logoUrl}
				cancelled={data.cancelled}
				roleDescriptions={data.roleDescriptions}
				geIntroducesFunctionaries={data.geIntroducesFunctionaries}
				tableTopicsMinSeconds={data.tableTopicsMinSeconds}
				tableTopicsMaxSeconds={data.tableTopicsMaxSeconds}
				template={data.template}
			/>
			<PublicFooter />
		</>
	);
}

/** A key naming no meeting (#877): the same page every meeting sub-route shows. */
function AgendaNotFound() {
	const { clubId } = Route.useParams();
	return <MeetingNotFound clubId={clubId} />;
}
