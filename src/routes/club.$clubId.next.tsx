// src/routes/club.$clubId.next.tsx
//
// `/club/<slug>/next` — the one link a club can print on a table tent or pin in
// the WhatsApp group that always opens THAT club's next meeting (#1140).
//
// Nested under the `/club/$clubId` shell, so `resolveClubOrRedirect` has already
// answered 404 for an archived or unknown club and canonicalised a uuid, a club
// number or a wrong-case slug to the slug, before this loader runs. A guest gets
// it too: unlike `/next`, nothing here needs a session.
//
// "Next" is decided by `loadPublicNextMeetingKey` (the PHASE rule: today's
// meeting stays next until its club-local day ends), the same seam `/next` uses,
// so the two URLs can never name different meetings. This route either
// redirects to that meeting's canonical `/club/$clubId/meeting/$meetingId` page
// or, when nothing is scheduled, renders the empty state.
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { CalendarPlus, Grid3x3 } from "lucide-react";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { effectiveAdminClubFor } from "#/lib/effective-admin";
import { isInRoom, validateMeetingRoomSearch } from "#/lib/meeting-hub";
import { getPublicNextMeetingKey } from "#/server/meetings";

export const Route = createFileRoute("/club/$clubId/next")({
	// Only the printed agenda's QR flag survives the REDIRECT (`?room=1`, #913).
	// Every other param is dropped from it on purpose: `?as=` is the identity
	// gate's seed and has no business being carried onto a different route by a
	// permalink. On the empty-state render nothing is dropped:
	// `validateMeetingRoomSearch` passes the search through, so `?as=` stays in
	// the URL.
	validateSearch: validateMeetingRoomSearch,
	loaderDeps: ({ search }) => ({ room: isInRoom(search) }),
	loader: async ({ context, deps }) => {
		const r = await getPublicNextMeetingKey({ data: context.clubUuid });
		if (r?.urlKey) {
			throw redirect({
				to: "/club/$clubId/meeting/$meetingId",
				params: { clubId: context.clubSlug, meetingId: r.urlKey },
				search: deps.room ? { room: 1 } : {},
			});
		}
		// `effectiveAdminClubFor` decides, not the shell flag. A signed-in
		// non-member gets the guest state. A superadmin impersonating this club
		// sees the officer button, as on every admin surface: `getAuthContext`
		// lists the impersonated club with `clubRole: "admin"`. The button is only
		// a link; `/admin/meetings/new` and the write guards refuse a read-only
		// session.
		const canSchedule = !!(
			context.authCtx &&
			effectiveAdminClubFor(context.authCtx, context.clubUuid)
		);
		return { canSchedule };
	},
	component: NoUpcomingMeeting,
});

function NoUpcomingMeeting() {
	const { canSchedule } = Route.useLoaderData();
	const { clubId } = Route.useParams();
	return (
		<PageContainer>
			<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
				Next meeting
			</h1>
			<div className="mt-7 rounded-2xl border border-dashed border-[var(--line)] bg-[var(--surface)] px-6 py-16 text-center">
				<p className="text-sm text-[var(--sea-ink-soft)]">
					No upcoming meeting is scheduled yet.
				</p>
				{canSchedule ? (
					<Button asChild size="sm" className="mt-4">
						<Link to="/admin/meetings/new">
							<CalendarPlus className="size-4" aria-hidden />
							Schedule a meeting
						</Link>
					</Button>
				) : (
					<Button asChild size="sm" variant="outline" className="mt-4">
						<Link
							to="/club/$clubId"
							params={{ clubId }}
							// Required by the club index's `validateSearch`; these are its
							// own defaults, so the link lands on the default view.
							search={{ view: "roles", count: 8 }}
						>
							<Grid3x3 className="size-4" aria-hidden />
							Browse the sign-up sheet
						</Link>
					</Button>
				)}
			</div>
		</PageContainer>
	);
}
