import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
	CalendarDays,
	CheckCircle2,
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
import { MeetingMinutes } from "#/components/club/meeting-minutes";
import { MeetingNavStrip } from "#/components/club/meeting-nav-strip";
import { MeetingRoleSheets } from "#/components/club/meeting-role-sheets";
import { MeetingViewActions } from "#/components/club/meeting-view-actions";
import { PageContainer } from "#/components/page-container";
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
import { buildSlideDeck } from "#/lib/agenda-slides";
import { formatMeetingDate, formatMeetingTimeRange } from "#/lib/format";
import {
	isMeetingLocked,
	lockedViewer,
	MEETING_LOCKED_MESSAGE,
	meetingDatePassed,
	meetingDateReached,
} from "#/lib/meeting-lifecycle";
import { deriveMeetingNavItems } from "#/lib/meeting-nav";
import { deriveMeetingRoleFlags, pairedRoleIds } from "#/lib/meeting-roles";
import { meetingViewer } from "#/lib/meeting-viewer";
import { footerDate } from "#/lib/slide-layout";
import {
	completeMeeting,
	getMeeting,
	listUpcomingMeetings,
	reopenMeeting,
} from "#/server/meetings";
import { getMinutes } from "#/server/minutes";
import { getMinutesRecipients } from "#/server/minutes-email";
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

export const Route = createFileRoute("/_authed/meetings/$id")({
	loader: async ({ params }) => {
		const data = await getMeeting({ data: params.id });
		// Non-fatal: a failure here degrades to no strip, never blocks the page
		// (mirrors the public club route).
		const upcoming = await listUpcomingMeetings({
			data: data.meeting.clubId,
		}).catch(() => [] as Awaited<ReturnType<typeof listUpcomingMeetings>>);
		const navItems = deriveMeetingNavItems(
			data.meeting,
			data.slots,
			upcoming,
			data.timezone,
		);
		// Minutes (ADR-0014 / #152): non-fatal — degrade to a hidden section if
		// the load fails, never block the page.
		const minutes = await getMinutes({ data: params.id }).catch(
			() =>
				({
					visible: false,
					canEdit: false,
					data: null,
					program: [],
				}) as Awaited<ReturnType<typeof getMinutes>>,
		);
		// Default email recipients (#165) — only for admins on a completed meeting
		// (the send control is hidden otherwise). Non-fatal: degrade to no control.
		const minutesEmail =
			minutes.visible && minutes.canEdit && isMeetingLocked(data.meeting.status)
				? await getMinutesRecipients({
						data: { clubId: data.meeting.clubId, meetingId: params.id },
					}).catch(() => null)
				: null;
		return { ...data, navItems, minutes, minutesEmail };
	},
	component: MeetingDetail,
});

function errMessage(err: unknown) {
	return err instanceof Error ? err.message : "Something went wrong.";
}

function MeetingDetail() {
	const {
		meeting,
		slots,
		canManage,
		timezone,
		unavailableMembers,
		clubSlug,
		roster,
		roleRecency,
		navItems,
		clubRoles,
		clubName,
		clubNumber,
		clubDistrict,
		clubMeetingSchedule,
		clubGuests,
		minutes,
		minutesEmail,
		nextMeetingAt,
		urlKey,
	} = Route.useLoaderData();
	const { currentMemberId } = Route.useRouteContext();
	const router = useRouter();
	// #176 slice 1: this page loads offline from the cached SSR data. Slice 3
	// makes the Minutes section editable offline (edits queue locally in
	// IndexedDB and replay on reconnect — the drain is slice 4).
	const online = useOnlineStatus();
	const [addRoleOpen, setAddRoleOpen] = useState(false);
	const [addRoleBusy, setAddRoleBusy] = useState(false);
	const [lifecycleBusy, setLifecycleBusy] = useState(false);
	// #320: an admin can preview the meeting as a non-admin member would see it
	// (no management controls). Client-only, no persistence — resets on reload.
	const [previewAsMember, setPreviewAsMember] = useState(false);

	// Same deck present mode renders — reused as the source for the .pptx export.
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
	// #150: a completed meeting is locked. Deny every mutation capability so
	// <MeetingAgenda> renders read-only; the server rejects any edit that reaches
	// it, and only Reopen (admin) unlocks it.
	const locked = isMeetingLocked(meeting.status);
	// Complete is only offered once the meeting's date is today or past.
	const canComplete = meetingDateReached(meeting.scheduledAt, timezone);
	const { isTmod, isGrammarian } = deriveMeetingRoleFlags(
		slots,
		currentMemberId,
	);
	const over = meeting.status
		? meetingDatePassed(meeting.scheduledAt, timezone)
		: false;
	// #320: while previewing-as-member, drop management everywhere it gates admin
	// UI — the viewer (so <MeetingAgenda> hides admin controls) and the route-level
	// controls below. This is exactly "the viewer I'd have as a non-admin member".
	const effectiveCanManage = canManage && !previewAsMember;
	const baseViewer = meetingViewer({
		currentMemberId,
		canManage: effectiveCanManage,
		isTmod,
		isGrammarian,
		isEditableWindow: !locked && !over,
		isSignedIn: true,
	});
	const viewer = locked ? lockedViewer(baseViewer) : baseViewer;
	const pairedIds = pairedRoleIds(clubRoles);
	const addableRoles = clubRoles.filter((r) => !pairedIds.has(r.id));
	const shareUrl =
		typeof window === "undefined"
			? `/club/${clubSlug}/meeting/${urlKey}`
			: `${window.location.origin}/club/${clubSlug}/meeting/${urlKey}`;
	const nudgeDate = footerDate(meeting.scheduledAt, timezone);

	// Session/admin actions: no `selfMemberId` — the server takes the admin path.
	const actions: MeetingAgendaActions = {
		claim: async (slot, speakerDetails) => {
			if (!currentMemberId) {
				throw new Error("Your account isn't linked to a club member yet.");
			}
			await claimSlot({
				data: {
					slotId: slot.id,
					memberId: currentMemberId,
					actorMemberId: currentMemberId,
					speakerDetails,
				},
			});
		},
		release: async (slot) => {
			await releaseSlot({
				data: { slotId: slot.id, actorMemberId: currentMemberId },
			});
		},
		// Self-serve (rendered under `canTakeOver` for any signed-in member): take
		// over another member's filled slot. Trust-based (`reassignSlot`), same as
		// the public surface — a signed-in member acts as their verified self.
		takeover: async (slot) => {
			if (!currentMemberId) {
				throw new Error("Your account isn't linked to a club member yet.");
			}
			await reassignSlot({
				data: {
					slotId: slot.id,
					memberId: currentMemberId,
					actorMemberId: currentMemberId,
				},
			});
		},
		confirm: async (slot) => {
			await confirmSlot({
				data: { slotId: slot.id, actorMemberId: currentMemberId },
			});
		},
		unconfirm: async (slot) => {
			await unconfirmSlot({
				data: { slotId: slot.id, actorMemberId: currentMemberId },
			});
		},
		moveSpeaker: async (slot, direction) => {
			await moveSpeakerSlot({
				data: { slotId: slot.id, direction, actorMemberId: currentMemberId },
			});
		},
		removeRole: async (slot) => {
			await removeRoleSlot({
				data: { slotId: slot.id, actorMemberId: currentMemberId },
			});
		},
		// `selfMemberId` lets a signed-in non-admin TMOD add/remove speakers via the
		// server's tmod-self-assert path; an admin is authorized regardless.
		addSpeaker: async () => {
			await addSpeakerSlot({
				data: {
					meetingId: meeting.id,
					actorMemberId: currentMemberId,
					selfMemberId: currentMemberId,
				},
			});
		},
		removeSpeaker: async () => {
			await removeSpeakerSlot({
				data: {
					meetingId: meeting.id,
					actorMemberId: currentMemberId,
					selfMemberId: currentMemberId,
				},
			});
		},
		onMutated: () => router.invalidate(),
	};

	async function doAddRole(roleDefinitionId: string) {
		setAddRoleBusy(true);
		try {
			await addRoleSlot({
				data: {
					meetingId: meeting.id,
					roleDefinitionId,
					actorMemberId: currentMemberId,
				},
			});
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
			await completeMeeting({
				data: { meetingId: meeting.id, actorMemberId: currentMemberId },
			});
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
			await reopenMeeting({
				data: { meetingId: meeting.id, actorMemberId: currentMemberId },
			});
			toast.success("Meeting reopened for edits.");
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setLifecycleBusy(false);
		}
	}

	return (
		<PageContainer className="space-y-5">
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
			{!online ? (
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
			) : null}
			<header className="space-y-2">
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
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
					{meeting.location ? (
						<span className="flex items-center gap-1.5">
							<MapPin className="size-4" aria-hidden />
							{meeting.location}
						</span>
					) : null}
				</div>
				<MeetingNavStrip
					clubId={clubSlug}
					items={navItems}
					getLinkProps={(item) => ({
						to: "/meetings/$id",
						params: { id: item.meetingId },
					})}
				/>
				{meeting.wordOfTheDay ? (
					<p className="flex items-center gap-1.5 text-sm">
						<Sparkles className="size-4 text-primary" aria-hidden />
						<span className="text-muted-foreground">Word of the day:</span>
						<span className="font-medium">{meeting.wordOfTheDay}</span>
					</p>
				) : null}
				<div className="flex flex-wrap items-center gap-2 pt-1">
					<ShareLinkButton
						path={`/club/${clubSlug}/meeting/${urlKey}`}
						label="Copy member link"
					/>
					<MeetingViewActions
						clubSlug={clubSlug}
						meetingId={urlKey}
						deck={deck}
						clubName={clubName}
					/>
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
					{/* #320: real admins get a preview-as-member toggle; the banner up
					    top provides the exit while previewing, so hide the button then. */}
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

			<MeetingAgenda
				slots={slots}
				viewer={viewer}
				actions={actions}
				roster={roster}
				roleRecency={roleRecency}
				unavailableMemberIds={unavailableMembers.map((m) => m.id)}
				unavailableMembers={unavailableMembers}
				pairedRoleIds={pairedIds}
				clubGuests={clubGuests}
				shareUrl={shareUrl}
				meetingDate={nudgeDate}
				meeting={meeting}
				timezone={timezone}
				actorMemberId={currentMemberId}
				selfMemberId={currentMemberId}
				onMetaSaved={async () => {
					await router.invalidate();
				}}
			/>

			{minutes.visible && minutes.data ? (
				<MeetingMinutes
					meetingId={meeting.id}
					minutes={minutes.data}
					program={minutes.program}
					// Past/completed (#225): completed is locked; "past" is strictly
					// before today so the day-of agenda isn't shadowed by an empty
					// Program (roles are still being filled the day of the meeting).
					meetingPast={
						locked || meetingDatePassed(meeting.scheduledAt, timezone)
					}
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
		</PageContainer>
	);
}
