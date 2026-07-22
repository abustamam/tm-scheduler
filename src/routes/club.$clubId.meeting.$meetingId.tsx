import { useQuery } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	notFound,
	useRouter,
} from "@tanstack/react-router";
import {
	CalendarDays,
	Clock,
	Loader2,
	Lock,
	MapPin,
	Sparkles,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	MeetingAgenda,
	type MeetingAgendaActions,
} from "#/components/agenda/meeting-agenda";
import { GuestResources } from "#/components/club/guest-resources";
import { useRequireIdentity } from "#/components/club/identity-gate";
import { MeetingNavStrip } from "#/components/club/meeting-nav-strip";
import { MeetingViewActions } from "#/components/club/meeting-view-actions";
import { ViewingAs } from "#/components/club/viewing-as";
import { ShareLinkButton } from "#/components/share-link-button";
import { Button } from "#/components/ui/button";
import { applyFlex, expandRunSheet } from "#/lib/agenda-runsheet";
import { buildSlideDeck } from "#/lib/agenda-slides";
import {
	formatMeetingDate,
	formatMeetingTime,
	formatMeetingTimeRange,
} from "#/lib/format";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import {
	isMeetingLocked,
	lockedViewer,
	MEETING_LOCKED_MESSAGE,
	meetingDatePassed,
} from "#/lib/meeting-lifecycle";
import { deriveMeetingNavItems } from "#/lib/meeting-nav";
import { deriveMeetingRoleFlags } from "#/lib/meeting-roles";
import { meetingViewer } from "#/lib/meeting-viewer";
import { useEffectiveMember } from "#/lib/member-identity";
import { clearAvailability, setAvailability } from "#/server/availability";
import {
	getMeetingByKey,
	getPublicMeetingByKey,
	listUpcomingMeetings,
} from "#/server/meetings";
import { listMembers } from "#/server/members";
import {
	addSpeakerSlot,
	claimSlot,
	reassignSlot,
	releaseSlot,
	removeSpeakerSlot,
} from "#/server/slots";

export const Route = createFileRoute("/club/$clubId/meeting/$meetingId")({
	loader: async ({ params, context }) => {
		// Fire both in parallel. getPublicMeetingByKey stays fatal (the agenda is
		// the page) EXCEPT when the key resolves to no meeting (stale/expired link)
		// — that translates to notFound() so notFoundComponent renders instead of
		// the generic error boundary. Other failures (DB errors, etc.) stay fatal.
		// The upcoming list is non-fatal — a failure degrades to no strip.
		// A signed-in member of this club (shell-wrapped) loads via the session-aware
		// getMeetingByKey — an admin regains management + contact; a non-admin member
		// gets the same non-manager view. Anonymous visitors use getPublicMeetingByKey
		// (hard canManage=false, never any PII). Both resolve the $meetingId key the
		// same way, so the loader shape is identical either way (#317).
		const load = context.shell ? getMeetingByKey : getPublicMeetingByKey;
		const meetingPromise = load({
			data: { clubId: context.clubUuid, key: params.meetingId },
		}).catch((err) => {
			if (isMeetingNotFoundError(err)) throw notFound();
			throw err;
		});
		const upcomingPromise = listUpcomingMeetings({
			data: context.clubUuid,
		}).catch(() => [] as Awaited<ReturnType<typeof listUpcomingMeetings>>);

		const data = await meetingPromise;
		// Guard against a meetingId that belongs to a different club than the URL.
		if (data.meeting.clubId !== context.clubUuid) throw notFound();

		const upcoming = await upcomingPromise;
		const navItems = deriveMeetingNavItems(
			data.meeting,
			data.slots,
			upcoming,
			data.timezone,
		);
		return { ...data, navItems };
	},
	component: MeetingView,
	notFoundComponent: MeetingNotFound,
});

function MeetingNotFound() {
	const { clubId } = Route.useParams();
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
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

function errMessage(err: unknown) {
	return err instanceof Error ? err.message : "Something went wrong.";
}

function MeetingView() {
	const { clubId, meetingId } = Route.useParams();
	const { clubUuid, effectiveMemberId, authCtx } = Route.useRouteContext();
	const {
		meeting,
		slots,
		timezone,
		unavailableMemberIds,
		roleRecency,
		navItems,
		clubName,
		clubNumber,
		clubDistrict,
		clubMeetingSchedule,
		nextMeetingAt,
		urlKey,
	} = Route.useLoaderData();
	const flex = applyFlex(expandRunSheet(slots), meeting.lengthMinutes);
	const projectedEnd = new Date(
		new Date(meeting.scheduledAt).getTime() + flex.projectedMinutes * 60_000,
	);
	// Shell-wrapped signed-in member → act as the session identity; anonymous
	// visitor → the localStorage-picked member (#317). Only `member.id` is used
	// below, so the session display name is only for consistency with the seam.
	const session =
		effectiveMemberId && authCtx?.user
			? { id: effectiveMemberId, name: authCtx.user.name || authCtx.user.email }
			: null;
	const { member, source } = useEffectiveMember(clubId, session);
	const { requireIdentity, promptIdentity } = useRequireIdentity();
	const router = useRouter();

	// Same deck present mode renders — reused as the source for the .pptx export
	// so this shared meeting-detail view offers Download .pptx alongside
	// Print/Present (issue #147, via MeetingViewActions).
	const deck = buildSlideDeck(
		meeting,
		{
			name: clubName,
			clubNumber,
			district: clubDistrict,
			timezone,
			meetingSchedule: clubMeetingSchedule,
		},
		slots,
		nextMeetingAt,
	);

	const [availBusy, setAvailBusy] = useState(false);

	const myId = member?.id ?? null;
	const isUnavailable = myId ? unavailableMemberIds.includes(myId) : false;

	// The current member's role flags for this meeting (TMOD holds the Toastmaster
	// slot → self-serve agenda editing per ADR-0010; Grammarian holds the WOD →
	// focused WOD editor per #296). Both false for a visitor with no picked name.
	const { isTmod, isGrammarian } = deriveMeetingRoleFlags(slots, myId);

	// #150: a completed meeting is locked. On this public/anonymous surface a
	// meeting that's already *happened* (its date is past) is treated the same —
	// there's nothing left to self-serve, so the agenda goes read-only and the
	// availability toggle becomes an attendance statement. The meeting day itself
	// stays editable (people fill roles right up to it). Admins keep full editing
	// on the signed-in workspace regardless; only this anonymous view goes over.
	const locked = isMeetingLocked(meeting.status);
	const over = locked || meetingDatePassed(meeting.scheduledAt, timezone);
	const baseViewer = meetingViewer({
		currentMemberId: myId,
		canManage: false,
		isTmod,
		isGrammarian,
		isEditableWindow: !over,
		isSignedIn: session !== null,
	});
	const viewer = over ? lockedViewer(baseViewer) : baseViewer;

	// Roster for the TMOD assign picker — only fetched when self-serve editing is
	// unlocked (kept off the payload for ordinary viewers).
	const { data: roster = [] } = useQuery({
		queryKey: ["members", clubUuid],
		queryFn: () => listMembers({ data: clubUuid }),
		enabled: isTmod,
	});

	async function toggleAvailability() {
		setAvailBusy(true);
		try {
			const me = await requireIdentity();
			if (!me) return; // finally clears availBusy
			if (isUnavailable) {
				await clearAvailability({
					data: { memberId: me.id, meetingId, clubId: clubUuid },
				});
				toast.success("You're marked as available again.");
			} else {
				await setAvailability({
					data: { memberId: me.id, meetingId, clubId: clubUuid },
				});
				toast.success("Got it — you can't make this one.");
			}
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setAvailBusy(false);
		}
	}

	// Self-asserted actions: every mutation carries `selfMemberId` so the server
	// takes the ADR-0010 self-serve path (vs. the admin/session path).
	const actions: MeetingAgendaActions = {
		claim: async (slot, speakerDetails) => {
			// `requireIdentity()` resolving null (picker dismissed) is currently
			// unreachable here: `handleClaimClick` in `<MeetingAgenda>` already
			// resolves identity before opening the ClaimSheet, so by the time this
			// fires an identity is set. The guard stays as defense-in-depth — a
			// silent return (not a throw) so it never surfaces a false success toast.
			const me = await requireIdentity();
			if (!me) return;
			await claimSlot({
				data: {
					slotId: slot.id,
					memberId: me.id,
					actorMemberId: me.id,
					speakerDetails,
				},
			});
		},
		release: async (slot) => {
			const me = await requireIdentity();
			if (!me) return;
			await releaseSlot({ data: { slotId: slot.id, actorMemberId: me.id } });
		},
		takeover: async (slot) => {
			const me = await requireIdentity();
			if (!me) return;
			await reassignSlot({
				data: { slotId: slot.id, memberId: me.id, actorMemberId: me.id },
			});
		},
		addSpeaker: async () => {
			const me = await requireIdentity();
			if (!me) return;
			await addSpeakerSlot({
				data: { meetingId, actorMemberId: me.id, selfMemberId: me.id },
			});
			toast.success("Speaker added.");
		},
		removeSpeaker: async () => {
			const me = await requireIdentity();
			if (!me) return;
			await removeSpeakerSlot({
				data: { meetingId, actorMemberId: me.id, selfMemberId: me.id },
			});
			toast.success("Speaker removed.");
		},
		onMutated: () => router.invalidate(),
	};

	return (
		<div className="mx-auto w-full max-w-reading space-y-5 p-4 pb-8 md:p-6">
			{over ? (
				<div className="flex items-center gap-2 rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm font-medium text-muted-foreground">
					<Lock className="size-4" aria-hidden />
					{locked
						? MEETING_LOCKED_MESSAGE
						: "This meeting has already taken place."}
				</div>
			) : null}
			<header className="space-y-2 pt-2">
				<h1 className="font-display text-2xl font-semibold tracking-tight">
					{meeting.theme ?? "Meeting"}
				</h1>
				<div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
					<span className="flex items-center gap-1.5">
						<CalendarDays className="size-4" aria-hidden />
						{formatMeetingDate(meeting.scheduledAt, timezone)} ·{" "}
						{formatMeetingTimeRange(
							meeting.scheduledAt,
							meeting.lengthMinutes,
							timezone,
						)}
					</span>
					{flex.status !== "exact" ? (
						<span
							className={
								flex.status === "over"
									? "flex items-center gap-1.5 font-medium text-destructive"
									: "flex items-center gap-1.5 text-muted-foreground"
							}
						>
							<Clock className="size-4" aria-hidden />
							{flex.status === "over"
								? `Projected end ${formatMeetingTime(projectedEnd, timezone)} · runs ${flex.deltaMinutes} min long`
								: `Projected end ${formatMeetingTime(projectedEnd, timezone)} · ends ${-flex.deltaMinutes} min early`}
						</span>
					) : null}
					{meeting.location ? (
						<span className="flex items-center gap-1.5">
							<MapPin className="size-4" aria-hidden />
							{meeting.location}
						</span>
					) : null}
				</div>
				<MeetingNavStrip clubId={clubId} items={navItems} />
				{meeting.wordOfTheDay ? (
					<p className="flex items-center gap-1.5 text-sm">
						<Sparkles className="size-4 text-primary" aria-hidden />
						<span className="text-muted-foreground">Word of the day:</span>
						<span className="font-medium">{meeting.wordOfTheDay}</span>
					</p>
				) : null}
				{/* Who claims/availability will be attributed to, with the same
				    "not you?" escape hatch as the sign-up sheet (issue #220). */}
				{source === "anon" ? (
					<ViewingAs member={member} promptIdentity={promptIdentity} />
				) : null}
				{over ? (
					myId ? (
						<p className="mt-1 text-sm font-medium text-muted-foreground">
							{isUnavailable
								? "You did not attend this meeting."
								: "You attended this meeting."}
						</p>
					) : null
				) : (
					<Button
						type="button"
						variant={isUnavailable ? "default" : "outline"}
						size="sm"
						onClick={toggleAvailability}
						disabled={!viewer.canToggleAvailability || availBusy}
						className="mt-1"
					>
						{availBusy ? (
							<Loader2 className="size-4 animate-spin" />
						) : isUnavailable ? (
							"You can't make this one — undo?"
						) : (
							"I can't make this one"
						)}
					</Button>
				)}
				<ShareLinkButton
					path={`/club/${clubId}/meeting/${urlKey}`}
					className="mt-1 ml-2"
				/>
				<MeetingViewActions
					clubSlug={clubId}
					meetingId={urlKey}
					deck={deck}
					clubName={clubName}
				/>
			</header>

			<GuestResources />

			<MeetingAgenda
				slots={slots}
				viewer={viewer}
				actions={actions}
				roster={roster}
				roleRecency={roleRecency}
				unavailableMemberIds={unavailableMemberIds}
				// Public self-serve viewers never have `canManage`, so the confirm
				// nudge never renders here — no share context to build these from.
				shareUrl=""
				meetingDate=""
				meeting={meeting}
				timezone={timezone}
				actorMemberId={myId}
				selfMemberId={myId}
				onMetaSaved={async () => {
					await router.invalidate();
				}}
				requireIdentity={requireIdentity}
			/>
		</div>
	);
}
