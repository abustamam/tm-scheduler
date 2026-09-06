// src/routes/club.$clubId.meeting.$meetingId_.me_.theme.tsx
//
// The Toastmaster's focused theme editor (#666): one field, one button, and a
// way back to the personal page (#665) so the checklist visibly ticks.
//
// ## Why the file name carries TWO trailing underscores
//
// The URL this serves is `/club/:clubId/meeting/:meetingId/me/theme`, exactly as
// the issue specifies. The file is not named `…$meetingId_.me.theme.tsx` because
// that would make it a CHILD of `club.$clubId.meeting.$meetingId_.me.tsx`, and
// that route renders no `<Outlet />` — the child would resolve, load, and render
// nothing at all. `$meetingId_` opts out of the meeting page for the same reason
// (its own header says so), and `me_` opts out of the personal page. Both
// underscores are load-bearing and neither changes the URL; the parent is the
// `/club/$clubId` shell, which is what supplies `IdentityGateProvider`.
//
// ## Which loader, and why the whole meeting payload
//
// This page renders one input, so loading the full agenda payload looks
// gratuitous. It is not. `updateMeeting` is a full REPLACE — `applyMeetingUpdate`
// writes `location: input.location?.trim() || null` and the same line for the
// Word of the Day, its definition and example, the announcements and the notes —
// so a save that posts only a theme ERASES all six, silently, reporting success.
// The existing "Edit meeting" dialog never trips over this because it prefills
// every field from the stored row and resubmits the lot. A focused editor has to
// do the same, so it needs the same row. `#/lib/meeting-meta-update` is where
// that round trip lives and is tested.
//
// The `context.shell` fork is the meeting page's, verbatim, and is asserted by
// `public-meeting-contact.guard.test.ts`: an anonymous visitor holding a chat
// link gets `getPublicMeetingByKey` (hard `canManage=false`, never any PII),
// while a signed-in member of the club gets the session-aware reader so an
// officer is not told they lack a capability the server would grant them.
//
// ## No new authorization
//
// The write is the same public `updateMeeting` the dialog calls, gated by
// `requireMeetingAgendaEditor` → `resolveMeetingAgendaAuthz`, which already
// admits a self-asserted member id with no session and resolves the TMOD slot by
// rename-proof `role_definitions.key`. Nothing here grants anything; the form's
// visibility is an affordance, re-decided server-side on every request.
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useCallback } from "react";
import { useRequireIdentity } from "#/components/club/identity-gate";
import { PersonalThemeEditor } from "#/components/club/personal-meeting-editors";
import { Button } from "#/components/ui/button";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import { useEffectiveMember } from "#/lib/member-identity";
import { getMeetingByKey, getPublicMeetingByKey } from "#/server/meetings";

export const Route = createFileRoute(
	"/club/$clubId/meeting/$meetingId_/me_/theme",
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
	component: PersonalThemeRoute,
	notFoundComponent: () => <DutyNotFound />,
	head: () => ({ meta: [{ title: "Set the meeting theme" }] }),
});

function PersonalThemeRoute() {
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

	// The tick is the receipt (#666): the personal page reads its checklist from a
	// `useQuery`, so the invalidation is what makes the duty show as done when we
	// land back on it. Awaited BEFORE the navigation, so the page it returns to is
	// already refetching rather than painting a stale unticked row first.
	const onSaved = useCallback(async () => {
		await queryClient.invalidateQueries({
			queryKey: ["personal-meeting", clubUuid, meetingId],
		});
		await navigate({
			to: "/club/$clubId/meeting/$meetingId/me",
			params: { clubId, meetingId },
			// Never carry the `?as=` seed back: the personal page strips it with a
			// REPLACE navigation precisely so a later share of that URL cannot
			// re-point another device at this member.
			search: { as: undefined },
		});
	}, [queryClient, clubUuid, clubId, meetingId, navigate]);

	if (!myId) {
		return <NeedsIdentity onPick={promptIdentity} />;
	}

	return (
		<PersonalThemeEditor
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

/** No identity resolvable → the existing picker, never an error. Mirrors the
 *  personal page's own branch so a forwarded link behaves the same either side
 *  of the tap. */
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
	return (
		<div className="mx-auto w-full max-w-reading space-y-4 p-4 pb-10 text-center">
			<p className="font-semibold text-lg">Meeting not found</p>
			<p className="text-muted-foreground text-sm">
				This meeting doesn't exist for this club, or the link is out of date.
			</p>
			<Button asChild variant="outline">
				<Link
					to="/club/$clubId"
					params={{ clubId }}
					search={{ view: "roles", count: 8 }}
				>
					Back to meetings
				</Link>
			</Button>
		</div>
	);
}
