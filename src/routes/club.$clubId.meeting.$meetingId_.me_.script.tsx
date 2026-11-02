// src/routes/club.$clubId.meeting.$meetingId_.me_.script.tsx
//
// The Toastmaster's script (#1480): the whole meeting with the Toastmaster's own
// lines and the real names, in this meeting's order. A fourth focused duty route
// beside `/me/theme`, `/me/word` and `/me/timer`.
//
// ## Why the file name carries TWO trailing underscores
//
// Same reason as the Timer's route: `…$meetingId_.me.script.tsx` would be a
// CHILD of the personal page, which renders no `<Outlet />`, and would render
// nothing. `personal-duty-routes.guard.test.ts` asserts the PARENT.
//
// ## Which loader
//
// The `context.shell` fork is the meeting page's, verbatim (the Timer's
// comment has the full reasoning): a signed-out visitor gets
// `getPublicMeetingByKey`, which never carries PII and, since #1480, never the
// speakers' written introductions. A signed-in member gets `getMeetingByKey`,
// whose `speechIntroductions` is non-null only for an active member.
//
// The page grants nothing and performs no write. The rows go through
// `resolveAgendaRows`, `applyFlex` and `buildTimeline`, exactly as print does,
// so a time on this page is the time on the paper.
import { createFileRoute, notFound } from "@tanstack/react-router";
import { CancelledMeetingNotice } from "#/components/club/cancelled-meeting-notice";
import { ToastmasterScriptPage } from "#/components/club/toastmaster-script-page";
import { MeetingNotFound } from "#/components/meeting-not-found";
import { applyFlex, resolveAgendaRows } from "#/lib/agenda-runsheet";
import { buildTimeline } from "#/lib/agenda-timing";
import { formatMeetingDate } from "#/lib/format";
import { isMeetingCancelled } from "#/lib/meeting-cancellation-notice";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import { personalMeetingHref } from "#/lib/role-duties";
import { buildToastmasterScript } from "#/lib/toastmaster-script";
import { getMeetingByKey, getPublicMeetingByKey } from "#/server/meetings";

export const Route = createFileRoute(
	"/club/$clubId/meeting/$meetingId_/me_/script",
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
	component: ToastmasterScriptRoute,
	notFoundComponent: () => <ScriptNotFound />,
	head: () => ({ meta: [{ title: "Toastmaster's script" }] }),
});

function ToastmasterScriptRoute() {
	const { clubId, meetingId } = Route.useParams();
	const { authCtx } = Route.useRouteContext();
	const {
		meeting,
		slots,
		timezone,
		clubName,
		geIntroducesFunctionaries,
		tableTopicsMinSeconds,
		tableTopicsMaxSeconds,
		template,
		speechIntroductions,
	} = Route.useLoaderData();

	// #1057: a cancelled meeting has no script to read. Read-only, and it says so.
	if (isMeetingCancelled(meeting.status)) {
		return <CancelledMeetingNotice clubId={clubId} meetingId={meeting.id} />;
	}

	// The print route's own sequence, so the times are the printed agenda's.
	const runRows = resolveAgendaRows({
		geIntroducesFunctionaries,
		tableTopicsLimits: {
			minSeconds: tableTopicsMinSeconds,
			maxSeconds: tableTopicsMaxSeconds,
		},
		template,
		slots,
	});
	const flex = applyFlex(runRows, meeting.lengthMinutes);
	const rows = buildTimeline(flex.rows, meeting.scheduledAt, timezone);

	const lines = buildToastmasterScript({
		rows,
		slots,
		introductions: speechIntroductions,
	});

	return (
		<ToastmasterScriptPage
			lines={lines}
			when={formatMeetingDate(meeting.scheduledAt, timezone)}
			clubName={clubName}
			theme={meeting.theme}
			backHref={personalMeetingHref({ clubId, meetingId })}
			membersOnlyNote={speechIntroductions === null}
			// A signed-in non-member gets the note without the link.
			signInRedirect={
				speechIntroductions === null && !authCtx?.user
					? `/club/${clubId}/meeting/${meetingId}/me/script`
					: null
			}
		/>
	);
}

function ScriptNotFound() {
	const { clubId } = Route.useParams();
	return <MeetingNotFound clubId={clubId} />;
}
