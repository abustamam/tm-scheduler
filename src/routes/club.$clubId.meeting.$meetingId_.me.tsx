// src/routes/club.$clubId.meeting.$meetingId_.me.tsx
//
// The personal meeting page (#665): a one-tap surface where a member says
// whether they are coming, sees the roles they hold, and gets the checklist of
// what each role still owes (#660).
//
// ## Nothing links here yet — the producer is #667
//
// Stated plainly because three earlier drafts of this header claimed the
// opposite. `nudgeShareUrl` still builds `/club/$clubId/meeting/$urlKey` (the
// full meeting page) and carries no `?as=`; a repo-wide grep finds no producer
// of that param outside this feature's own tests. The nudge and email drafts
// that will point here are #667's, and #665's own issue says deep-link targets
// land in the follow-up. So today this route is reachable by typing the URL.
// Do NOT write a comment asserting a call site that does not exist — the next
// reader greps for it and concludes the grep is broken.
//
// ## `$meetingId_` and why the segment is a KEY
//
// The trailing underscore keeps this OUT from under
// `club.$clubId.meeting.$meetingId.tsx`, exactly as the agenda editor beside it
// does: that page renders no `<Outlet />`, so nesting the plain way would make
// this content unreachable. The URL is unchanged; the parent becomes the club
// shell, which is what supplies `IdentityGateProvider`.
//
// The agenda editor's header says its `$meetingId` is always a raw uuid,
// because its only entry point wires `meeting.id`. This route is the opposite:
// its entry point will be a chat link built from `meetingUrlKey` (a club-local
// `YYYY-MM-DD`), so the segment is passed to the seam as an unresolved KEY and
// `resolvePublicMeetingKey` accepts date, date-HHmm or uuid. Every WRITE uses
// `view.meeting.id`, the RESOLVED uuid, because the write fns validate
// `z.string().uuid()` — passing the segment would reject a date-keyed link at
// the write instead of the read, after the page rendered fine.
//
// ## No new authorization
//
// `?as=` seeds the same localStorage identity the anonymous roster pick already
// sets, and only when the browser has no conflicting identity of its own. Every
// write is an existing public server fn taking a raw member id with no session.
// ## Where the markup lives
//
// The shell, the four non-happy states and the body itself are all in
// `components/club/personal-meeting-body.tsx`, not here. This module cannot be
// mounted in vitest — it pulls `#/server/personal-meeting` → `#/db` →
// "DATABASE_URL is not set" — so branching presentation left in this file is
// untestable by construction; #665 moved the body across for that reason and
// #676 moved the states that surround it for the same one. What stays here is
// the WIRING, which `personal-meeting-wiring.guard.test.ts` reads as source.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import { useRequireIdentity } from "#/components/club/identity-gate";
import {
	PersonalMeetingBody,
	PersonalMeetingLoading,
	PersonalMeetingNotice,
	PersonalMeetingShell,
} from "#/components/club/personal-meeting-body";
import { Button } from "#/components/ui/button";
import { resolveAsSeed, useCurrentMember } from "#/lib/member-identity";
import { getPublicPersonalMeetingView } from "#/server/personal-meeting";

export const Route = createFileRoute("/club/$clubId/meeting/$meetingId_/me")({
	// Loose: a malformed `?as=` must fall through to the identity picker, never
	// throw. The id is validated SERVER-side against this club's roster before
	// anything is stored — see `loadPublicPersonalMeetingView`.
	validateSearch: (search: Record<string, unknown>) => ({
		as: typeof search.as === "string" && search.as ? search.as : undefined,
	}),
	component: PersonalMeetingRoute,
	head: () => ({ meta: [{ title: "Your meeting" }] }),
});

function PersonalMeetingRoute() {
	const { clubId, meetingId } = Route.useParams();
	// The shell's `beforeLoad` already resolved the slug-or-uuid segment, so the
	// club UUID is context, not a second round trip.
	const { clubUuid } = Route.useRouteContext();
	const { as } = Route.useSearch();
	const navigate = Route.useNavigate();
	const queryClient = useQueryClient();

	// `clubId` (the raw route param), not the club uuid: the gate keys the stored
	// identity by the same param (`clubSlug={clubId}` in the shell), so seeding
	// under any other key would write an identity nothing reads.
	const { member: picked, setMember } = useCurrentMember(clubId);
	const { sessionMember, promptIdentity } = useRequireIdentity();

	// Who this page is ABOUT. A session wins outright; otherwise the ?as= link's
	// candidate, which is unvalidated until the query below answers; otherwise
	// whoever is already picked in this browser. Order matters: putting `as`
	// first would let a link make a signed-in officer write another member's row
	// from their own browser.
	const targetMemberId = sessionMember?.id ?? as ?? picked?.id ?? null;

	const view = useQuery({
		// `clubUuid` is in the key because `meetingId` is a CLUB-LOCAL date key:
		// two clubs meeting the same day share the string, and without the club
		// they would share a cache entry.
		queryKey: ["personal-meeting", clubUuid, meetingId, targetMemberId],
		queryFn: () =>
			getPublicPersonalMeetingView({
				data: {
					clubId: clubUuid,
					meetingKey: meetingId,
					memberId: targetMemberId as string,
				},
			}),
		enabled: Boolean(targetMemberId),
	});

	// Seed + strip. The query above is keyed on the ?as= id when there is no
	// session, so `view.data.member` IS the server-validated candidate.
	//
	// Stripping is a REPLACE navigation so the bare link is what lands in history
	// — a back-tap must not re-apply someone else's identity, and a re-share of
	// the current URL must not carry it either.
	useEffect(() => {
		// `isSuccess`, not `!isPending`. A REJECTED id and a FAILED request are
		// different answers: the seam returns `null` to reject, and only a
		// successful response carries that null. Treating an error the same way
		// would strip a VALID `?as=` on one flaky request and silently drop the
		// identity the link exists to deliver.
		if (!as || !view.isSuccess) return;
		const decision = resolveAsSeed({
			asParam: as,
			sessionMember,
			candidate: view.data?.member ?? null,
			// The browser's OWN identity. Seeding over a DIFFERENT one would
			// re-point this device club-wide, not just for this page.
			existingPick: picked,
		});
		if (decision.seed) setMember(decision.seed);
		if (decision.stripParam) {
			void navigate({ to: ".", search: { as: undefined }, replace: true });
		}
	}, [
		as,
		view.isSuccess,
		view.data,
		sessionMember,
		picked,
		setMember,
		navigate,
	]);

	const refresh = useCallback(async () => {
		await queryClient.invalidateQueries({
			queryKey: ["personal-meeting", clubUuid, meetingId],
		});
	}, [queryClient, clubUuid, meetingId]);

	// No identity resolvable at all → the existing picker, never an error.
	//
	// All four non-happy branches go through `PersonalMeetingNotice`, whose
	// `title` is a REQUIRED heading prop: each of them used to be a bare grey
	// `<p>`, so unless the happy path rendered the page carried no heading at
	// all and a failed load never said which meeting it had failed on. The
	// component takes the raw `$meetingId` segment because that is the only
	// meeting context these branches have — the club name and the real date sit
	// behind the query that has not answered.
	if (!targetMemberId) {
		return (
			<PersonalMeetingShell clubId={clubId} meetingId={meetingId}>
				<PersonalMeetingNotice title="Who's answering?" meetingKey={meetingId}>
					We couldn't tell who you are from this link. Pick your name and we'll
					show you your roles and let you answer.
				</PersonalMeetingNotice>
				<Button className="min-h-11 w-full" onClick={promptIdentity}>
					Pick your name
				</Button>
			</PersonalMeetingShell>
		);
	}

	if (view.isPending) {
		return (
			<PersonalMeetingShell clubId={clubId} meetingId={meetingId}>
				<PersonalMeetingLoading meetingKey={meetingId} />
			</PersonalMeetingShell>
		);
	}

	// BEFORE the not-found branch. A failed request is not a stale link, and
	// telling someone their link is out of date when the network blipped sends
	// them to an identity picker that cannot help.
	if (view.isError) {
		return (
			<PersonalMeetingShell clubId={clubId} meetingId={meetingId}>
				<PersonalMeetingNotice
					title="We couldn't load this"
					meetingKey={meetingId}
				>
					Something went wrong on the way to us, so nothing has been saved
					either way. Try again in a moment.
				</PersonalMeetingNotice>
				<Button
					className="min-h-11 w-full"
					variant="outline"
					onClick={() => void view.refetch()}
				>
					Try again
				</Button>
			</PersonalMeetingShell>
		);
	}

	// Null covers every not-found at once — unknown meeting, archived club,
	// rejected member id, a meeting belonging to another club — because the seam
	// collapses them deliberately.
	if (!view.data) {
		return (
			<PersonalMeetingShell clubId={clubId} meetingId={meetingId}>
				<PersonalMeetingNotice
					title="We couldn't find that meeting"
					meetingKey={meetingId}
				>
					This link may be out of date, or it may be for a different club. Pick
					your name and we'll try again.
				</PersonalMeetingNotice>
				<Button className="min-h-11 w-full" onClick={promptIdentity}>
					Pick your name
				</Button>
			</PersonalMeetingShell>
		);
	}

	return (
		<PersonalMeetingShell clubId={clubId} meetingId={meetingId}>
			<PersonalMeetingBody
				view={view.data}
				clubId={clubId}
				meetingId={meetingId}
				onChanged={refresh}
				onNotYou={promptIdentity}
				canRepick={!sessionMember}
			/>
		</PersonalMeetingShell>
	);
}
