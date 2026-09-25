// src/routes/club.$clubId.meeting.$meetingId_.me_.topics.tsx
//
// The Table Topics Master's focused notes editor (#880): the topic categories
// or prompts the Table Topics slide shows, then back to the personal page so
// the checklist ticks.
//
// ## Why the file name carries TWO trailing underscores
//
// Same mechanism the sibling `…me_.theme.tsx` explains: the personal page
// (`…$meetingId_.me.tsx`) renders no `<Outlet />`, so `me_` opts out of nesting
// under it while keeping the URL `/club/:clubId/meeting/:meetingId/me/topics`.
//
// ## Which loader
//
// The `context.shell` fork is the meeting page's, verbatim, as in the sibling
// `…me_.word.tsx` — the anonymous Table Topics Master who tapped a chat link
// gets `getPublicMeetingByKey` and no PII.
//
// ## No new authorization in this file
//
// The write is `updateTableTopicsNotes`, gated server-side by
// `requireTableTopicsNotesEditor` → `resolveTableTopicsNotesAuthz`, which admits
// an admin session or the meeting's self-asserted TMOD or Table Topics Master,
// both resolved by `role_definitions.key` (#464). Anything decided here is an
// affordance only.
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useCallback } from "react";
import { useRequireIdentity } from "#/components/club/identity-gate";
import { PersonalTableTopicsEditor } from "#/components/club/personal-meeting-editors";
import { MeetingNotFound } from "#/components/meeting-not-found";
import { Button } from "#/components/ui/button";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import { useEffectiveMember } from "#/lib/member-identity";
import { getMeetingByKey, getPublicMeetingByKey } from "#/server/meetings";

export const Route = createFileRoute(
	"/club/$clubId/meeting/$meetingId_/me_/topics",
)({
	loader: async ({ params, context }) => {
		// PII boundary (#37), same fork as the meeting page — KEEP IT VERBATIM.
		const load = context.shell ? getMeetingByKey : getPublicMeetingByKey;
		const data = await load({
			data: { clubId: context.clubUuid, key: params.meetingId },
		}).catch((err) => {
			if (isMeetingNotFoundError(err)) throw notFound();
			throw err;
		});
		// A meeting id belonging to a DIFFERENT club than the URL segment names.
		if (data.meeting.clubId !== context.clubUuid) throw notFound();
		return data;
	},
	component: PersonalTopicsRoute,
	notFoundComponent: () => <DutyNotFound />,
	head: () => ({ meta: [{ title: "Set your Table Topics" }] }),
});

function PersonalTopicsRoute() {
	const { clubId, meetingId } = Route.useParams();
	const { clubUuid, authCtx, effectiveMemberId } = Route.useRouteContext();
	const { meeting, slots, canManage, timezone } = Route.useLoaderData();
	const navigate = Route.useNavigate();
	const queryClient = useQueryClient();

	// Shell-wrapped signed-in member → the session identity; anonymous visitor →
	// the localStorage-picked member (#317). Keyed on the RAW `clubId` param,
	// because that is the key the identity gate stores under.
	const session =
		effectiveMemberId && authCtx?.user
			? { id: effectiveMemberId, name: authCtx.user.name || authCtx.user.email }
			: null;
	const { member } = useEffectiveMember(clubId, session);
	const { promptIdentity } = useRequireIdentity();
	const myId = member?.id ?? null;

	// The tick is the receipt (#666) — see the sibling theme route.
	const onSaved = useCallback(async () => {
		await queryClient.invalidateQueries({
			queryKey: ["personal-meeting", clubUuid, meetingId],
		});
		await navigate({
			to: "/club/$clubId/meeting/$meetingId/me",
			params: { clubId, meetingId },
			// Never carry the `?as=` seed back — see the sibling word route.
			search: { as: undefined },
		});
	}, [queryClient, clubUuid, clubId, meetingId, navigate]);

	if (!myId) {
		return <NeedsIdentity onPick={promptIdentity} />;
	}

	return (
		<PersonalTableTopicsEditor
			clubId={clubId}
			meetingId={meetingId}
			meeting={meeting}
			slots={slots}
			timezone={timezone}
			canManage={canManage}
			memberId={myId}
			isSignedIn={session !== null}
			onSaved={onSaved}
		/>
	);
}

/** No identity resolvable → the existing picker, never an error. */
function NeedsIdentity({ onPick }: { onPick: () => void }) {
	return (
		<div className="mx-auto w-full max-w-reading space-y-4 p-4 pb-10">
			<p className="text-muted-foreground text-sm">
				We couldn't tell who you are from this link.
			</p>
			<Button className="w-full" onClick={onPick}>
				Pick your name
			</Button>
		</div>
	);
}

function DutyNotFound() {
	const { clubId } = Route.useParams();
	return <MeetingNotFound clubId={clubId} />;
}
