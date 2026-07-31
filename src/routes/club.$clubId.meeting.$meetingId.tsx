import { useQuery } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	notFound,
	useRouter,
} from "@tanstack/react-router";
import {
	CalendarDays,
	CheckCircle2,
	Clock,
	Eye,
	Loader2,
	Lock,
	LockOpen,
	MapPin,
	Sparkles,
	WifiOff,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	MeetingAgenda,
	type MeetingAgendaActions,
} from "#/components/agenda/meeting-agenda";
import { MeetingAnnouncements } from "#/components/agenda/meeting-announcements";
import { GuestResources } from "#/components/club/guest-resources";
import { useRequireIdentity } from "#/components/club/identity-gate";
import { MeetingMinutes } from "#/components/club/meeting-minutes";
import { MeetingNavStrip } from "#/components/club/meeting-nav-strip";
import { MeetingRoleSheets } from "#/components/club/meeting-role-sheets";
import { MeetingViewActions } from "#/components/club/meeting-view-actions";
import { ViewingAs } from "#/components/club/viewing-as";
import { ShareLinkButton } from "#/components/share-link-button";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Label } from "#/components/ui/label";
import { useOnlineStatus } from "#/hooks/use-online-status";
import {
	applyFlex,
	buildRunOfShow,
	expandRunSheet,
} from "#/lib/agenda-runsheet";
import { buildSlideDeck } from "#/lib/agenda-slides";
import {
	formatMeetingDate,
	formatMeetingTime,
	formatMeetingTimeRange,
} from "#/lib/format";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import {
	isMeetingLocked,
	isMeetingOver,
	MEETING_LOCKED_MESSAGE,
	meetingDatePassed,
	meetingDateReached,
	resolveMeetingViewer,
} from "#/lib/meeting-lifecycle";
import { deriveMeetingNavItems } from "#/lib/meeting-nav";
import { deriveMeetingRoleFlags, pairedRoleIds } from "#/lib/meeting-roles";
import { useEffectiveMember } from "#/lib/member-identity";
import { footerDate } from "#/lib/slide-layout";
import { clearAvailability, setAvailability } from "#/server/availability";
import {
	completeMeeting,
	getMeetingByKey,
	getPublicMeetingByKey,
	listPastMeetings,
	listUpcomingMeetings,
	reopenMeeting,
} from "#/server/meetings";
import { listMembers } from "#/server/members";
import { getMinutes } from "#/server/minutes";
import { getMinutesRecipients } from "#/server/minutes-email";
import { clearContacted, setContacted } from "#/server/outreach";
import {
	addRoleSlot,
	addSpeakerSlot,
	claimSlot,
	confirmSlot,
	moveSpeakerSlot,
	reassignSlot,
	releaseSlot,
	removeRoleSlot,
	removeSpeakerSlot,
	unconfirmSlot,
} from "#/server/slots";

// Anonymous (non-shell) visitors never load minutes — this hidden default keeps
// the loader's return shape uniform without a server call or any PII fetch.
const EMPTY_MINUTES = {
	visible: false,
	canEdit: false,
	data: null,
	program: [],
} as Awaited<ReturnType<typeof getMinutes>>;

export const Route = createFileRoute("/club/$clubId/meeting/$meetingId")({
	loader: async ({ params, context }) => {
		// PII boundary (#37): a signed-in member of this club (shell) loads the
		// session-aware getMeetingByKey — an admin regains management + contact; a
		// non-admin member gets canManage=false. An anonymous visitor loads
		// getPublicMeetingByKey (hard canManage=false, never any PII). Both resolve
		// the $meetingId key identically, so the loader shape matches either way
		// (#317). KEEP THIS FORK VERBATIM — public-meeting-contact.guard.test.ts
		// asserts it.
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

		// Nav strip backward paging (#375): the window of meetings immediately
		// BEFORE the one being viewed — anchored to THIS meeting rather than to
		// today, so paging back from a three-month-old meeting keeps going back
		// instead of jumping to last week. Public like `listUpcomingMeetings`, so
		// the anonymous visitor gets it too. Non-fatal: degrade to forward-only.
		const past = await listPastMeetings({
			data: {
				clubId: context.clubUuid,
				before: new Date(data.meeting.scheduledAt).toISOString(),
				limit: 3,
			},
		}).catch(() => null);

		const upcoming = await upcomingPromise;
		const navItems = deriveMeetingNavItems(
			data.meeting,
			data.slots,
			upcoming,
			data.timezone,
			past?.meetings ?? [],
		);

		// Minutes (ADR-0014 / #152) — ONLY for a signed-in member (shell); an anon
		// visitor never reaches getMinutes. Non-fatal: degrade to hidden. Keyed by
		// the resolved uuid (params.meetingId is the pretty key). The PII guard test
		// asserts this shell gate stays.
		const minutes = context.shell
			? await getMinutes({ data: data.meeting.id }).catch(() => EMPTY_MINUTES)
			: EMPTY_MINUTES;
		// Default email recipients (#165) — admins on a completed meeting only.
		const minutesEmail =
			context.shell &&
			minutes.visible &&
			minutes.canEdit &&
			isMeetingLocked(data.meeting.status)
				? await getMinutesRecipients({
						data: { clubId: data.meeting.clubId, meetingId: data.meeting.id },
					}).catch(() => null)
				: null;

		return { ...data, navItems, minutes, minutesEmail };
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
	const { clubId } = Route.useParams();
	const { clubUuid, effectiveMemberId, authCtx, shell } =
		Route.useRouteContext();
	const {
		meeting,
		slots,
		canManage,
		timezone,
		unavailableMembers,
		unavailableMemberIds,
		roleRecency,
		navItems,
		clubName,
		clubNumber,
		clubDistrict,
		clubMeetingSchedule,
		clubRoles,
		clubGuests,
		roster: loaderRoster,
		contactedMemberIds,
		minutes,
		minutesEmail,
		meetingNumber,
		nextMeetingAt,
		urlKey,
		geIntroducesFunctionaries,
	} = Route.useLoaderData();
	const router = useRouter();
	const online = useOnlineStatus();

	// Shell-wrapped signed-in member → act as the session identity; anonymous
	// visitor → the localStorage-picked member (#317).
	const session =
		effectiveMemberId && authCtx?.user
			? { id: effectiveMemberId, name: authCtx.user.name || authCtx.user.email }
			: null;
	const { member, source } = useEffectiveMember(clubId, session);
	const { requireIdentity, promptIdentity } = useRequireIdentity();
	const myId = member?.id ?? null;
	const isSignedIn = session !== null;
	// The session member drives the manager action path (matches the old
	// /meetings/:id route's `currentMemberId`); null for an impersonating
	// superadmin (canManage without a linked member).
	const managerActorId = session?.id ?? null;

	const [availBusy, setAvailBusy] = useState(false);
	const [addRoleOpen, setAddRoleOpen] = useState(false);
	const [addRoleBusy, setAddRoleBusy] = useState(false);
	const [lifecycleBusy, setLifecycleBusy] = useState(false);
	// #320: an admin can preview the page as a non-admin member sees it.
	const [previewAsMember, setPreviewAsMember] = useState(false);

	// One club config drives both renderings of this meeting (#367).
	const flex = applyFlex(
		expandRunSheet(slots, buildRunOfShow({ geIntroducesFunctionaries })),
		meeting.lengthMinutes,
	);
	const projectedEnd = new Date(
		new Date(meeting.scheduledAt).getTime() + flex.projectedMinutes * 60_000,
	);
	const deck = buildSlideDeck({
		meeting,
		club: {
			name: clubName,
			clubNumber,
			district: clubDistrict,
			timezone,
			meetingSchedule: clubMeetingSchedule,
		},
		slots,
		nextMeetingAt,
		meetingNumber,
		geIntroducesFunctionaries,
	});

	const { isTmod, isGrammarian } = deriveMeetingRoleFlags(slots, myId);
	const locked = isMeetingLocked(meeting.status);
	// Its own fact, not a step toward `over`: it drives the "already taken place"
	// notice, which a manager (still editing) must not see.
	const datePassed = meetingDatePassed(meeting.scheduledAt, timezone);
	// The one "is it over?" rule (#393) — shared with `resolveMeetingViewer` and
	// handed to <MeetingAgenda> rather than recomputed there.
	const over = isMeetingOver({
		status: meeting.status,
		scheduledAt: meeting.scheduledAt,
		timezone,
	});
	// #320: previewing-as-member drops management everywhere it gates admin UI.
	const effectiveCanManage = canManage && !previewAsMember;
	const canComplete = meetingDateReached(meeting.scheduledAt, timezone);

	// One viewer for all audiences: an admin keeps editing a past-but-open meeting
	// until Complete; a member/anon agenda freezes once the date passes; a locked
	// meeting is read-only for everyone. (Pure — unit-tested in Task 1.)
	const viewer = resolveMeetingViewer({
		status: meeting.status,
		scheduledAt: meeting.scheduledAt,
		timezone,
		currentMemberId: myId,
		canManage: effectiveCanManage,
		isTmod,
		isGrammarian,
		isSignedIn,
	});

	// Roster for the assign picker: a manager already has it (with contact) from
	// the loader; a non-admin TMOD (public or signed-in) fetches the plain member
	// list client-side, since the public payload carries no roster.
	const { data: fetchedRoster = [] } = useQuery({
		queryKey: ["members", clubUuid],
		queryFn: () => listMembers({ data: clubUuid }),
		enabled: !canManage && isTmod,
	});
	const roster = canManage ? loaderRoster : fetchedRoster;

	const pairedIds = pairedRoleIds(clubRoles);
	const addableRoles = clubRoles.filter((r) => !pairedIds.has(r.id));
	const nudgeShareUrl =
		typeof window === "undefined"
			? `/club/${clubId}/meeting/${urlKey}`
			: `${window.location.origin}/club/${clubId}/meeting/${urlKey}`;
	const nudgeDate = footerDate(meeting.scheduledAt, timezone);
	const myUnavailable = myId ? unavailableMemberIds.includes(myId) : false;
	// The agenda's internal claim/assign acts as this member: the session member
	// for a manager (null for an impersonator), the effective member otherwise.
	const agendaMemberId = effectiveCanManage ? managerActorId : myId;
	const containerClass = canManage
		? "max-w-workspace px-4 pt-5 pb-10 sm:px-7 sm:pt-7 space-y-5"
		: "mx-auto w-full max-w-reading p-4 pb-8 md:p-6 space-y-5";

	async function toggleAvailability() {
		setAvailBusy(true);
		try {
			const me = await requireIdentity();
			if (!me) return;
			if (myUnavailable) {
				await clearAvailability({
					data: { memberId: me.id, meetingId: meeting.id, clubId: clubUuid },
				});
				toast.success("You're marked as available again.");
			} else {
				await setAvailability({
					data: { memberId: me.id, meetingId: meeting.id, clubId: clubUuid },
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

	// Manager (admin) actions: act as the session member; exposes the manager-only
	// confirm/unconfirm/moveSpeaker/removeRole set.
	const managerActions: MeetingAgendaActions = {
		claim: async (slot, speakerDetails) => {
			if (!managerActorId) {
				throw new Error("Your account isn't linked to a club member yet.");
			}
			await claimSlot({
				data: {
					slotId: slot.id,
					memberId: managerActorId,
					actorMemberId: managerActorId,
					speakerDetails,
				},
			});
		},
		release: async (slot) => {
			await releaseSlot({
				data: { slotId: slot.id, actorMemberId: managerActorId },
			});
		},
		takeover: async (slot) => {
			if (!managerActorId) {
				throw new Error("Your account isn't linked to a club member yet.");
			}
			await reassignSlot({
				data: {
					slotId: slot.id,
					memberId: managerActorId,
					actorMemberId: managerActorId,
				},
			});
		},
		confirm: async (slot) => {
			await confirmSlot({ data: { slotId: slot.id } });
		},
		unconfirm: async (slot) => {
			await unconfirmSlot({ data: { slotId: slot.id } });
		},
		moveSpeaker: async (slot, direction) => {
			await moveSpeakerSlot({ data: { slotId: slot.id, direction } });
		},
		removeRole: async (slot) => {
			await removeRoleSlot({ data: { slotId: slot.id } });
		},
		addSpeaker: async () => {
			await addSpeakerSlot({
				data: { meetingId: meeting.id, selfMemberId: managerActorId },
			});
		},
		removeSpeaker: async () => {
			await removeSpeakerSlot({
				data: { meetingId: meeting.id, selfMemberId: managerActorId },
			});
		},
		onMutated: () => router.invalidate(),
	};

	// Self-serve (member / anon) actions: resolve identity first (a signed-in
	// member resolves without a prompt; an anon visitor identifies at click) and
	// carry `selfMemberId`, so the server takes the ADR-0010 self-serve path.
	const selfActions: MeetingAgendaActions = {
		claim: async (slot, speakerDetails) => {
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
				data: { meetingId: meeting.id, selfMemberId: me.id },
			});
			toast.success("Speaker added.");
		},
		removeSpeaker: async () => {
			const me = await requireIdentity();
			if (!me) return;
			await removeSpeakerSlot({
				data: { meetingId: meeting.id, selfMemberId: me.id },
			});
			toast.success("Speaker removed.");
		},
		onMutated: () => router.invalidate(),
	};

	const actions = effectiveCanManage ? managerActions : selfActions;

	async function doAddRole(roleDefinitionId: string) {
		setAddRoleBusy(true);
		try {
			await addRoleSlot({ data: { meetingId: meeting.id, roleDefinitionId } });
			toast.success("Role added.");
			setAddRoleOpen(false);
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setAddRoleBusy(false);
		}
	}

	async function doComplete() {
		setLifecycleBusy(true);
		try {
			await completeMeeting({ data: { meetingId: meeting.id } });
			toast.success("Meeting closed out and locked.");
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setLifecycleBusy(false);
		}
	}

	async function doReopen() {
		setLifecycleBusy(true);
		try {
			await reopenMeeting({ data: { meetingId: meeting.id } });
			toast.success("Meeting reopened for edits.");
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setLifecycleBusy(false);
		}
	}

	return (
		<div className={containerClass}>
			{previewAsMember ? (
				<div className="flex items-center justify-between gap-3 rounded-xl border border-primary/40 bg-primary/10 px-4 py-3 text-sm font-medium text-primary">
					<span className="flex items-center gap-2">
						<Eye className="size-4 shrink-0" aria-hidden />
						Previewing as a member — management controls are hidden.
					</span>
					<Button
						size="sm"
						variant="outline"
						onClick={() => setPreviewAsMember(false)}
					>
						Exit preview
					</Button>
				</div>
			) : null}
			{!online && shell ? (
				<div className="flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm font-medium text-warning-foreground">
					<WifiOff className="size-4 shrink-0" aria-hidden />
					You're offline — minutes edits are saved on this device and sync when
					you reconnect. Other changes (meeting details, roles) need a
					connection.
				</div>
			) : null}
			{locked ? (
				<div className="flex items-center gap-2 rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm font-medium text-muted-foreground">
					<Lock className="size-4" aria-hidden />
					{MEETING_LOCKED_MESSAGE}
				</div>
			) : datePassed && !effectiveCanManage ? (
				<div className="flex items-center gap-2 rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm font-medium text-muted-foreground">
					<Lock className="size-4" aria-hidden />
					This meeting has already taken place.
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
				{source === "anon" ? (
					<ViewingAs member={member} promptIdentity={promptIdentity} />
				) : null}
				{over ? (
					myId ? (
						<p className="mt-1 text-sm font-medium text-muted-foreground">
							{myUnavailable
								? "You did not attend this meeting."
								: "You attended this meeting."}
						</p>
					) : null
				) : (
					<Button
						type="button"
						variant={myUnavailable ? "default" : "outline"}
						size="sm"
						onClick={toggleAvailability}
						disabled={!viewer.canToggleAvailability || availBusy}
						className="mt-1"
					>
						{availBusy ? (
							<Loader2 className="size-4 animate-spin" />
						) : myUnavailable ? (
							"You can't make this one — undo?"
						) : (
							"I can't make this one"
						)}
					</Button>
				)}
				<div className="flex flex-wrap items-center gap-2 pt-1">
					<ShareLinkButton
						path={`/club/${clubId}/meeting/${urlKey}`}
						label={canManage ? "Copy member link" : undefined}
					/>
					<MeetingViewActions
						clubSlug={clubId}
						meetingId={urlKey}
						deck={deck}
						clubName={clubName}
						wordOfTheDay={meeting.wordOfTheDay}
					/>
					{/* Public prep material — role-sheet PDFs hold only public-agenda
					    data, so every audience gets the download menu (#365). */}
					<MeetingRoleSheets meetingId={meeting.id} />
					{effectiveCanManage && !locked && addableRoles.length > 0 ? (
						<Button
							size="sm"
							variant="outline"
							onClick={() => setAddRoleOpen(true)}
						>
							+ Add role
						</Button>
					) : null}
					{effectiveCanManage && locked ? (
						<Button
							size="sm"
							variant="outline"
							onClick={doReopen}
							disabled={lifecycleBusy}
						>
							{lifecycleBusy ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<LockOpen className="size-4" />
							)}
							Reopen meeting
						</Button>
					) : null}
					{effectiveCanManage && !locked && canComplete ? (
						<Button size="sm" onClick={doComplete} disabled={lifecycleBusy}>
							{lifecycleBusy ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<CheckCircle2 className="size-4" />
							)}
							Complete meeting
						</Button>
					) : null}
					{canManage && !previewAsMember ? (
						<Button
							size="sm"
							variant="ghost"
							onClick={() => setPreviewAsMember(true)}
						>
							<Eye className="size-4" />
							Preview as member
						</Button>
					) : null}
				</div>
			</header>

			<MeetingAnnouncements text={meeting.reminders} />

			{effectiveCanManage ? null : <GuestResources />}

			<MeetingAgenda
				slots={slots}
				effectiveMeetingNumber={meetingNumber}
				viewer={viewer}
				actions={actions}
				roster={roster}
				roleRecency={roleRecency}
				unavailableMemberIds={unavailableMemberIds}
				unavailableMembers={effectiveCanManage ? unavailableMembers : undefined}
				pairedRoleIds={effectiveCanManage ? pairedIds : undefined}
				clubGuests={effectiveCanManage ? clubGuests : undefined}
				shareUrl={effectiveCanManage ? nudgeShareUrl : ""}
				meetingDate={effectiveCanManage ? nudgeDate : ""}
				meeting={meeting}
				timezone={timezone}
				meetingOver={over}
				selfMemberId={agendaMemberId}
				onMetaSaved={async () => {
					await router.invalidate();
				}}
				requireIdentity={requireIdentity}
				contactedMemberIds={contactedMemberIds}
				onContacted={async (memberId, via) => {
					try {
						await setContacted({
							data: {
								memberId,
								meetingId: meeting.id,
								clubId: meeting.clubId,
								via,
							},
						});
						await router.invalidate();
					} catch (err) {
						toast.error(errMessage(err));
					}
				}}
				onUncontacted={async (memberId) => {
					try {
						await clearContacted({
							data: { memberId, meetingId: meeting.id, clubId: meeting.clubId },
						});
						await router.invalidate();
					} catch (err) {
						toast.error(errMessage(err));
					}
				}}
			/>

			{minutes.visible && minutes.data ? (
				<MeetingMinutes
					meetingId={meeting.id}
					minutes={minutes.data}
					program={minutes.program}
					meetingPast={over}
					canEdit={effectiveCanManage && minutes.canEdit}
					clubGuests={clubGuests}
					onMutated={() => router.invalidate()}
					email={
						minutesEmail
							? {
									clubId: meeting.clubId,
									clubName,
									meetingDate: meeting.scheduledAt,
									recipients: minutesEmail.recipients,
									skipped: minutesEmail.skipped,
								}
							: null
					}
				/>
			) : null}

			<Dialog open={addRoleOpen} onOpenChange={setAddRoleOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Add a role</DialogTitle>
					</DialogHeader>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							const roleId = String(
								new FormData(e.currentTarget).get("roleDefinitionId") ?? "",
							);
							if (roleId) void doAddRole(roleId);
						}}
						className="space-y-4"
					>
						<div className="space-y-2">
							<Label htmlFor="roleDefinitionId">Role</Label>
							<select
								id="roleDefinitionId"
								name="roleDefinitionId"
								required
								className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
							>
								{addableRoles.map((r) => (
									<option key={r.id} value={r.id}>
										{r.name}
									</option>
								))}
							</select>
							<p className="text-xs text-muted-foreground">
								Picking a role already on this meeting adds another instance
								(e.g. “Timer 2”).
							</p>
						</div>
						<DialogFooter>
							<DialogClose asChild>
								<Button type="button" variant="outline">
									Cancel
								</Button>
							</DialogClose>
							<Button type="submit" disabled={addRoleBusy}>
								{addRoleBusy ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									"Add role"
								)}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</div>
	);
}
