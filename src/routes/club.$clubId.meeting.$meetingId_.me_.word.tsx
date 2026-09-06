// src/routes/club.$clubId.meeting.$meetingId_.me_.word.tsx
//
// The Grammarian's focused Word-of-the-Day editor (#666): word, definition and
// example, then back to the personal page (#665) so the checklist ticks.
//
// ## This is NOT the Word of the Day poster
//
// `club.$clubId_.meeting.$meetingId.word.tsx` already exists and is the PRINTED
// poster. Nesting the editor under `/me/` is what keeps "the thing I have to do"
// separate from "the artifact we print", and reads correctly in a URL a member
// sees in a chat message. Do not merge the two.
//
// ## Why the file name carries TWO trailing underscores
//
// Same mechanism the sibling `…me_.theme.tsx` explains: the URL is
// `/club/:clubId/meeting/:meetingId/me/word`, but the personal page
// (`…$meetingId_.me.tsx`) renders no `<Outlet />`, so a file named `…me.word.tsx`
// would nest inside it and render nothing. `me_` opts out of that nesting while
// leaving the URL untouched.
//
// ## Which loader, and why the whole meeting payload
//
// `updateWordOfTheDay` touches only the three WOD columns, so unlike the theme
// editor this page needs no echo of the rest of the meeting's meta. It still
// needs the stored `wod_definition` and `wod_example` to prefill: that writer
// nulls what it is not given, so saving a word without carrying the definition
// back would clear the definition. Neither field travels on the personal page's
// own payload, which is why this route loads the meeting rather than reusing it.
//
// The `context.shell` fork is the meeting page's, verbatim, and is asserted by
// `public-meeting-contact.guard.test.ts` — the anonymous Grammarian who tapped a
// chat link gets `getPublicMeetingByKey` and no PII.
//
// ## No new authorization
//
// The write is the same public `updateWordOfTheDay` the Grammarian's dialog
// calls, gated by `requireWordOfTheDayEditor` → `resolveWordOfTheDayAuthz`,
// which admits the meeting's self-asserted Grammarian or TMOD with no session
// and resolves both slots by rename-proof `role_definitions.key` (#464).
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useCallback } from "react";
import { useRequireIdentity } from "#/components/club/identity-gate";
import { PersonalWordEditor } from "#/components/club/personal-meeting-editors";
import { Button } from "#/components/ui/button";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import { useEffectiveMember } from "#/lib/member-identity";
import { getMeetingByKey, getPublicMeetingByKey } from "#/server/meetings";

export const Route = createFileRoute(
	"/club/$clubId/meeting/$meetingId_/me_/word",
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
	component: PersonalWordRoute,
	notFoundComponent: () => <DutyNotFound />,
	head: () => ({ meta: [{ title: "Set the Word of the Day" }] }),
});

function PersonalWordRoute() {
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
		<PersonalWordEditor
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
