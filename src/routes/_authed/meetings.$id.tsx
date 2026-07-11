import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
	CalendarDays,
	CheckCircle2,
	Loader2,
	Lock,
	LockOpen,
	MapPin,
	Sparkles,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	MeetingAgenda,
	type MeetingAgendaActions,
} from "#/components/agenda/meeting-agenda";
import { MeetingMinutes } from "#/components/club/meeting-minutes";
import { MeetingNavStrip } from "#/components/club/meeting-nav-strip";
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
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { buildSlideDeck } from "#/lib/agenda-slides";
import { utcToZonedWallTime } from "#/lib/datetime";
import { formatMeetingDate, formatMeetingTimeRange } from "#/lib/format";
import {
	isMeetingLocked,
	lockedViewer,
	MEETING_LOCKED_MESSAGE,
	meetingDateReached,
} from "#/lib/meeting-lifecycle";
import { deriveMeetingNavItems } from "#/lib/meeting-nav";
import { pairedRoleIds } from "#/lib/meeting-roles";
import { sessionViewer } from "#/lib/meeting-viewer";
import {
	completeMeeting,
	getMeeting,
	listUpcomingMeetings,
	reopenMeeting,
	updateMeeting,
} from "#/server/meetings";
import { getMinutes } from "#/server/minutes";
import { getMinutesRecipients } from "#/server/minutes-email";
import {
	addRoleSlot,
	addSpeakerSlot,
	claimSlot,
	confirmSlot,
	moveSpeakerSlot,
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
	} = Route.useLoaderData();
	const { currentMemberId } = Route.useRouteContext();
	const router = useRouter();
	const [editOpen, setEditOpen] = useState(false);
	const [addRoleOpen, setAddRoleOpen] = useState(false);
	const [addRoleBusy, setAddRoleBusy] = useState(false);
	const [lifecycleBusy, setLifecycleBusy] = useState(false);

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
	const baseViewer = sessionViewer({ currentMemberId, canManage });
	const viewer = locked ? lockedViewer(baseViewer) : baseViewer;
	const pairedIds = pairedRoleIds(clubRoles);
	const addableRoles = clubRoles.filter((r) => !pairedIds.has(r.id));

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
		addSpeaker: async () => {
			await addSpeakerSlot({
				data: { meetingId: meeting.id, actorMemberId: currentMemberId },
			});
		},
		removeSpeaker: async () => {
			await removeSpeakerSlot({
				data: { meetingId: meeting.id, actorMemberId: currentMemberId },
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
			{locked ? (
				<div className="flex items-center gap-2 rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm font-medium text-muted-foreground">
					<Lock className="size-4" aria-hidden />
					{MEETING_LOCKED_MESSAGE}
				</div>
			) : null}
			<header className="space-y-2">
				<h1 className="font-display text-[30px] font-semibold tracking-[-0.02em]">
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
					getLinkProps={(meetingId) => ({
						to: "/meetings/$id",
						params: { id: meetingId },
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
						path={`/club/${clubSlug}/meeting/${meeting.id}`}
						label="Copy member link"
					/>
					<MeetingViewActions
						clubSlug={clubSlug}
						meetingId={meeting.id}
						deck={deck}
						clubName={clubName}
					/>
					{canManage && !locked && addableRoles.length > 0 ? (
						<Button
							size="sm"
							variant="outline"
							onClick={() => setAddRoleOpen(true)}
						>
							+ Add role
						</Button>
					) : null}
					{canManage && !locked ? (
						<Button
							size="sm"
							variant="outline"
							onClick={() => setEditOpen(true)}
						>
							Edit meeting
						</Button>
					) : null}
					{canManage && locked ? (
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
					{canManage && !locked && canComplete ? (
						<Button size="sm" onClick={doComplete} disabled={lifecycleBusy}>
							{lifecycleBusy ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<CheckCircle2 className="size-4" />
							)}
							Complete meeting
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
			/>

			{minutes.visible && minutes.data ? (
				<MeetingMinutes
					meetingId={meeting.id}
					minutes={minutes.data}
					program={minutes.program}
					canEdit={minutes.canEdit}
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

			{canManage ? (
				<EditMeetingDialog
					open={editOpen}
					onOpenChange={setEditOpen}
					meeting={meeting}
					timezone={timezone}
					actorMemberId={currentMemberId}
					onSaved={async () => {
						setEditOpen(false);
						await router.invalidate();
					}}
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

function EditMeetingDialog({
	open,
	onOpenChange,
	meeting,
	timezone,
	actorMemberId,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	meeting: Awaited<ReturnType<typeof getMeeting>>["meeting"];
	timezone: string;
	actorMemberId: string | null;
	onSaved: () => void | Promise<void>;
}) {
	const [submitting, setSubmitting] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		const scheduledAt = String(form.get("scheduledAt") ?? "");
		if (!scheduledAt) {
			toast.error("Date & time is required.");
			return;
		}
		setSubmitting(true);
		try {
			const lengthRaw = String(form.get("lengthMinutes") ?? "").trim();
			await updateMeeting({
				data: {
					meetingId: meeting.id,
					actorMemberId,
					scheduledAt,
					lengthMinutes: lengthRaw ? Number(lengthRaw) : undefined,
					theme: String(form.get("theme") ?? "").trim() || undefined,
					location: String(form.get("location") ?? "").trim() || undefined,
					wordOfTheDay:
						String(form.get("wordOfTheDay") ?? "").trim() || undefined,
					notes: String(form.get("notes") ?? "").trim() || undefined,
				},
			});
			toast.success("Meeting updated.");
			await onSaved();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Edit meeting</DialogTitle>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="scheduledAt">Date &amp; time</Label>
						<Input
							id="scheduledAt"
							name="scheduledAt"
							type="datetime-local"
							required
							defaultValue={utcToZonedWallTime(
								new Date(meeting.scheduledAt),
								timezone,
							)}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="lengthMinutes">Length (minutes)</Label>
						<Input
							id="lengthMinutes"
							name="lengthMinutes"
							type="number"
							min={1}
							step={1}
							defaultValue={meeting.lengthMinutes}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="theme">Theme</Label>
						<Input id="theme" name="theme" defaultValue={meeting.theme ?? ""} />
					</div>
					<div className="space-y-2">
						<Label htmlFor="location">Location</Label>
						<Input
							id="location"
							name="location"
							defaultValue={meeting.location ?? ""}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="wordOfTheDay">Word of the day</Label>
						<Input
							id="wordOfTheDay"
							name="wordOfTheDay"
							defaultValue={meeting.wordOfTheDay ?? ""}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="notes">Notes</Label>
						<Input id="notes" name="notes" defaultValue={meeting.notes ?? ""} />
					</div>
					<DialogFooter>
						<DialogClose asChild>
							<Button type="button" variant="outline" disabled={submitting}>
								Cancel
							</Button>
						</DialogClose>
						<Button type="submit" disabled={submitting}>
							{submitting ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								"Save changes"
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
