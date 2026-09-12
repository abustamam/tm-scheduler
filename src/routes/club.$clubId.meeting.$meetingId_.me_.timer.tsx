// src/routes/club.$clubId.meeting.$meetingId_.me_.timer.tsx
//
// The Timer's stopwatch (#729): a third focused duty route beside `/me/theme`
// and `/me/word`, on the phone of the person in the chair.
//
// ## Why the file name carries TWO trailing underscores
//
// The URL is `/club/:clubId/meeting/:meetingId/me/timer`. A file named
// `…$meetingId_.me.timer.tsx` would make this a CHILD of
// `club.$clubId.meeting.$meetingId_.me.tsx`, which renders no `<Outlet />` —
// the child would resolve, its loader would run, and it would render nothing at
// all, with the visitor shown the personal page again and no error anywhere.
// The generated `fullPath` is byte-identical either way, which is exactly why
// `personal-duty-routes.guard.test.ts` asserts the PARENT and not the file
// name. Both underscores are load-bearing and neither changes the URL.
//
// ## Which loader, and why the whole meeting payload
//
// The `context.shell` fork is the meeting page's, verbatim, and is asserted by
// `public-meeting-contact.guard.test.ts`. An anonymous visitor holding a chat
// link gets `getPublicMeetingByKey` (hard `canManage=false`, never any PII) —
// and on THIS route the anonymous branch is the common one, because the Timer
// taps a link out of a WhatsApp thread. The shell branch exists only so a
// signed-in officer is not falsely told they lack a capability the server
// would grant them.
//
// The full payload is not gratuitous. The clock's numbers ARE the agenda's: the
// run sheet goes through `resolveAgendaRows`, the same seam the printed agenda
// and the projected deck use, which needs the slots, the meeting's template,
// the club's Table Topics window and the GE variant flag. Deriving them any
// other way is how the phone and the paper come to disagree about when red is.
//
// ## No writes, and so no new authorization
//
// This issue stores nothing (#730 is the record). The page is offered to any
// visitor who can name themselves, exactly like the two duty editors, and the
// LINK to it is what is scoped to the Timer — on the personal meeting page,
// through `findTimerSlot`.
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useRequireIdentity } from "#/components/club/identity-gate";
import { MeetingTimer } from "#/components/club/meeting-timer";
import { Button } from "#/components/ui/button";
import { resolveAgendaRows } from "#/lib/agenda-runsheet";
import { formatMeetingDate } from "#/lib/format";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import { useEffectiveMember } from "#/lib/member-identity";
import { personalMeetingHref } from "#/lib/role-duties";
import { getMeetingByKey, getPublicMeetingByKey } from "#/server/meetings";

export const Route = createFileRoute(
	"/club/$clubId/meeting/$meetingId_/me_/timer",
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
	component: PersonalTimerRoute,
	notFoundComponent: () => <DutyNotFound />,
	head: () => ({ meta: [{ title: "Time the meeting" }] }),
});

function PersonalTimerRoute() {
	const { clubId, meetingId } = Route.useParams();
	const { authCtx, effectiveMemberId } = Route.useRouteContext();
	const {
		meeting,
		slots,
		timezone,
		geIntroducesFunctionaries,
		tableTopicsMinSeconds,
		tableTopicsMaxSeconds,
		template,
	} = Route.useLoaderData();

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

	// ONE seam for both meeting shapes, the print route's own call: a standard
	// meeting expands the code-derived run of show, a templated one builds rows
	// from its stored beats. `applyFlex` and `buildTimeline` are deliberately NOT
	// run here — they resize the squishy row and hang wall-clock times off the
	// rows, and neither touches `marks` or `slotId`, which is all a stopwatch
	// reads. Running them would add a dependency on the meeting's length for no
	// change in output.
	const rows = resolveAgendaRows({
		geIntroducesFunctionaries,
		// The club's own Table Topics window (#443). Omitting it is what once made
		// a printed agenda show red at 2:00 beside a deck saying 2:30.
		tableTopicsLimits: {
			minSeconds: tableTopicsMinSeconds,
			maxSeconds: tableTopicsMaxSeconds,
		},
		template,
		slots,
	});

	if (!myId) {
		return <NeedsIdentity onPick={promptIdentity} />;
	}

	return (
		<MeetingTimer
			when={formatMeetingDate(meeting.scheduledAt, timezone)}
			backHref={personalMeetingHref({ clubId, meetingId })}
			rows={rows}
			tableTopicsLimits={{
				minSeconds: tableTopicsMinSeconds,
				maxSeconds: tableTopicsMaxSeconds,
			}}
		/>
	);
}

/** No identity resolvable → the existing picker, never an error. Mirrors the
 *  two duty editors so a forwarded link behaves the same either side of the
 *  tap. */
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
