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
import { MeetingNavStrip } from "#/components/club/meeting-nav-strip";
import { MeetingViewActions } from "#/components/club/meeting-view-actions";
import { SigningUpAs } from "#/components/club/signing-up-as";
import { ShareLinkButton } from "#/components/share-link-button";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { applyFlex, expandRunSheet } from "#/lib/agenda-runsheet";
import { buildSlideDeck } from "#/lib/agenda-slides";
import { utcToZonedWallTime } from "#/lib/datetime";
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
import { isTmodRoleName } from "#/lib/meeting-roles";
import { selfAssertedViewer } from "#/lib/meeting-viewer";
import { useCurrentMember } from "#/lib/member-identity";
import { clearAvailability, setAvailability } from "#/server/availability";
import {
	getMeeting,
	listUpcomingMeetings,
	updateMeeting,
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
		// Fire both in parallel. getMeeting stays fatal (the agenda is the page)
		// EXCEPT when the meeting row is simply absent (stale/expired link) —
		// that translates to notFound() so notFoundComponent renders instead of
		// the generic error boundary. Other failures (DB errors, etc.) stay fatal.
		// The upcoming list is non-fatal — a failure degrades to no strip.
		const meetingPromise = getMeeting({ data: params.meetingId }).catch(
			(err) => {
				if (isMeetingNotFoundError(err)) throw notFound();
				throw err;
			},
		);
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
	const { clubUuid } = Route.useRouteContext();
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
	} = Route.useLoaderData();
	const flex = applyFlex(expandRunSheet(slots), meeting.lengthMinutes);
	const projectedEnd = new Date(
		new Date(meeting.scheduledAt).getTime() + flex.projectedMinutes * 60_000,
	);
	const { member } = useCurrentMember(clubId);
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
	const [editMetaOpen, setEditMetaOpen] = useState(false);

	const myId = member?.id ?? null;
	const isUnavailable = myId ? unavailableMemberIds.includes(myId) : false;

	// The meeting's TMOD (Toastmaster of the Day) slot assignee, if any. When the
	// self-asserted member holds it, they get self-serve agenda editing (ADR-0010).
	const tmodMemberId =
		slots.find((s) => isTmodRoleName(s.roleName))?.assigneeId ?? null;
	const isTmod = myId !== null && myId === tmodMemberId;

	// #150: a completed meeting is locked. On this public/anonymous surface a
	// meeting that's already *happened* (its date is past) is treated the same —
	// there's nothing left to self-serve, so the agenda goes read-only and the
	// availability toggle becomes an attendance statement. The meeting day itself
	// stays editable (people fill roles right up to it). Admins keep full editing
	// on the signed-in workspace regardless; only this anonymous view goes over.
	const locked = isMeetingLocked(meeting.status);
	const over = locked || meetingDatePassed(meeting.scheduledAt, timezone);
	const baseViewer = selfAssertedViewer({ memberId: myId, isTmod });
	const viewer = over ? lockedViewer(baseViewer) : baseViewer;

	// Roster for the TMOD assign picker — only fetched when self-serve editing is
	// unlocked (kept off the payload for ordinary viewers).
	const { data: roster = [] } = useQuery({
		queryKey: ["members", clubUuid],
		queryFn: () => listMembers({ data: clubUuid }),
		enabled: isTmod,
	});

	async function toggleAvailability() {
		if (!member) {
			toast.error("Pick your name first.");
			return;
		}
		setAvailBusy(true);
		try {
			if (isUnavailable) {
				await clearAvailability({
					data: { memberId: member.id, meetingId, clubId: clubUuid },
				});
				toast.success("You're marked as available again.");
			} else {
				await setAvailability({
					data: { memberId: member.id, meetingId, clubId: clubUuid },
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
			if (!myId) throw new Error("Pick your name first.");
			await claimSlot({
				data: {
					slotId: slot.id,
					memberId: myId,
					actorMemberId: myId,
					speakerDetails,
				},
			});
		},
		release: async (slot) => {
			if (!myId) throw new Error("Pick your name first.");
			await releaseSlot({ data: { slotId: slot.id, actorMemberId: myId } });
		},
		takeover: async (slot) => {
			if (!myId) throw new Error("Pick your name first.");
			await reassignSlot({
				data: { slotId: slot.id, memberId: myId, actorMemberId: myId },
			});
		},
		addSpeaker: async () => {
			if (!myId) throw new Error("Pick your name first.");
			await addSpeakerSlot({
				data: { meetingId, actorMemberId: myId, selfMemberId: myId },
			});
			toast.success("Speaker added.");
		},
		removeSpeaker: async () => {
			if (!myId) throw new Error("Pick your name first.");
			await removeSpeakerSlot({
				data: { meetingId, actorMemberId: myId, selfMemberId: myId },
			});
			toast.success("Speaker removed.");
		},
		onMutated: () => router.invalidate(),
	};

	return (
		<div className="mx-auto w-full max-w-3xl space-y-5 p-4 pb-8 md:p-6">
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
				<SigningUpAs clubSlug={clubId} />
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
					path={`/club/${clubId}/meeting/${meeting.id}`}
					className="mt-1 ml-2"
				/>
				<MeetingViewActions
					clubSlug={clubId}
					meetingId={meetingId}
					deck={deck}
					clubName={clubName}
				/>
				{isTmod && !over ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="mt-1 ml-2"
						onClick={() => setEditMetaOpen(true)}
					>
						Edit meeting
					</Button>
				) : null}
			</header>

			<MeetingAgenda
				slots={slots}
				viewer={viewer}
				actions={actions}
				roster={roster}
				roleRecency={roleRecency}
				unavailableMemberIds={unavailableMemberIds}
			/>

			{isTmod && !over ? (
				<EditMeetingMetaDialog
					open={editMetaOpen}
					onOpenChange={setEditMetaOpen}
					meeting={meeting}
					timezone={timezone}
					actorMemberId={myId}
					selfMemberId={myId}
					onSaved={async () => {
						setEditMetaOpen(false);
						await router.invalidate();
					}}
				/>
			) : null}
		</div>
	);
}

/**
 * TMOD meta editor — theme, Word of the Day, location, notes only. Date/time and
 * length are intentionally absent: reschedule stays admin-only (ADR-0010).
 * We re-submit the meeting's current wall time unchanged so the server's
 * meta-only path accepts it.
 */
function EditMeetingMetaDialog({
	open,
	onOpenChange,
	meeting,
	timezone,
	actorMemberId,
	selfMemberId,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	meeting: Awaited<ReturnType<typeof getMeeting>>["meeting"];
	timezone: string;
	actorMemberId: string | null;
	selfMemberId: string | null;
	onSaved: () => void | Promise<void>;
}) {
	const [submitting, setSubmitting] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		setSubmitting(true);
		try {
			await updateMeeting({
				data: {
					meetingId: meeting.id,
					actorMemberId,
					selfMemberId,
					// Current time, unchanged — TMOD can't reschedule.
					scheduledAt: utcToZonedWallTime(
						new Date(meeting.scheduledAt),
						timezone,
					),
					theme: String(form.get("theme") ?? "").trim() || undefined,
					location: String(form.get("location") ?? "").trim() || undefined,
					wordOfTheDay:
						String(form.get("wordOfTheDay") ?? "").trim() || undefined,
					wodDefinition:
						String(form.get("wodDefinition") ?? "").trim() || undefined,
					wodExample: String(form.get("wodExample") ?? "").trim() || undefined,
					notes: String(form.get("notes") ?? "").trim() || undefined,
					reminders: String(form.get("reminders") ?? "").trim() || undefined,
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
					<DialogDescription>
						As Toastmaster you can edit the theme and details. Ask a VP
						Education to change the date or time.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-4">
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
						<Label htmlFor="wodDefinition">Word of the day — definition</Label>
						<Input
							id="wodDefinition"
							name="wodDefinition"
							defaultValue={meeting.wodDefinition ?? ""}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="wodExample">
							Word of the day — example sentence
						</Label>
						<Input
							id="wodExample"
							name="wodExample"
							defaultValue={meeting.wodExample ?? ""}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="notes">Notes</Label>
						<Input id="notes" name="notes" defaultValue={meeting.notes ?? ""} />
					</div>
					<div className="space-y-2">
						<Label htmlFor="reminders">Reminders (projected slide)</Label>
						<Textarea
							id="reminders"
							name="reminders"
							rows={3}
							defaultValue={meeting.reminders ?? ""}
						/>
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
