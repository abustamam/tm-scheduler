import { useQuery } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	notFound,
	useRouter,
} from "@tanstack/react-router";
import {
	CalendarDays,
	Loader2,
	MapPin,
	Presentation,
	Printer,
	Sparkles,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AssignSlotSheet } from "#/components/club/assign-slot-sheet";
import { EditSpeechSheet } from "#/components/club/edit-speech-sheet";
import { MeetingNavStrip } from "#/components/club/meeting-nav-strip";
import { ShareLinkButton } from "#/components/share-link-button";
import { Badge } from "#/components/ui/badge";
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
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "#/components/ui/sheet";
import { Textarea } from "#/components/ui/textarea";
import { buildRoleCounts, slotLabel } from "#/lib/agenda";
import { utcToZonedWallTime } from "#/lib/datetime";
import { formatMeetingDate, formatMeetingTimeRange } from "#/lib/format";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import { deriveMeetingNavItems } from "#/lib/meeting-nav";
import { isTmodRoleName } from "#/lib/meeting-roles";
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
				<Link to="/club/$clubId" params={{ clubId }}>
					Back to meetings
				</Link>
			</Button>
		</div>
	);
}

const CATEGORY_LABELS: Record<string, string> = {
	leadership: "Leadership",
	speaker: "Speakers",
	evaluator: "Evaluation",
	functionary: "Functionaries",
};

type Slot = Awaited<ReturnType<typeof getMeeting>>["slots"][number];

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
	} = Route.useLoaderData();
	const { member } = useCurrentMember(clubId);
	const router = useRouter();

	const [claimSlotState, setClaimSlotState] = useState<Slot | null>(null);
	const [takeoverSlot, setTakeoverSlot] = useState<Slot | null>(null);
	const [editSpeechSlot, setEditSpeechSlot] = useState<Slot | null>(null);
	const [busySlotId, setBusySlotId] = useState<string | null>(null);
	const [availBusy, setAvailBusy] = useState(false);
	const [editMetaOpen, setEditMetaOpen] = useState(false);
	const [assignSlot, setAssignSlot] = useState<Slot | null>(null);

	const myId = member?.id ?? null;
	const isUnavailable = myId ? unavailableMemberIds.includes(myId) : false;

	// Number repeated roles ("Speaker 1", "Speaker 2", …).
	const roleCounts = buildRoleCounts(slots);

	// The meeting's TMOD (Toastmaster of the Day) slot assignee, if any. When the
	// self-asserted member holds it, they get self-serve agenda editing (ADR-0010).
	const tmodMemberId =
		slots.find((s) => isTmodRoleName(s.roleName))?.assigneeId ?? null;
	const isTmod = myId !== null && myId === tmodMemberId;

	// Roster for the TMOD assign picker — only fetched when self-serve editing is
	// unlocked (kept off the payload for ordinary viewers).
	const { data: roster = [] } = useQuery({
		queryKey: ["members", clubUuid],
		queryFn: () => listMembers({ data: clubUuid }),
		enabled: isTmod,
	});

	// memberId → their current role label this meeting (for the assign picker).
	const roleByMemberId: Record<string, string> = {};
	for (const s of slots) {
		if (s.assigneeId) roleByMemberId[s.assigneeId] = slotLabel(s, roleCounts);
	}

	const speakerSlots = slots.filter((s) => s.isSpeakerRole);

	// Preserve category order as it appears (slots arrive pre-sorted).
	const categories: string[] = [];
	for (const s of slots) {
		if (!categories.includes(s.category)) categories.push(s.category);
	}

	async function doAddSpeaker() {
		if (!myId) return;
		setBusySlotId("add-speaker");
		try {
			await addSpeakerSlot({
				data: { meetingId, actorMemberId: myId, selfMemberId: myId },
			});
			toast.success("Speaker added.");
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusySlotId(null);
		}
	}

	async function doRemoveSpeaker() {
		if (!myId) return;
		if (speakerSlots.length <= 1) {
			const ok = window.confirm(
				"This meeting will have no speakers. Continue?",
			);
			if (!ok) return;
		}
		setBusySlotId("remove-speaker");
		try {
			await removeSpeakerSlot({
				data: { meetingId, actorMemberId: myId, selfMemberId: myId },
			});
			toast.success("Speaker removed.");
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusySlotId(null);
		}
	}

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

	function onRowTap(slot: Slot) {
		if (slot.status === "open") {
			setClaimSlotState(slot);
		}
	}

	async function doRelease(slot: Slot) {
		if (!member) {
			toast.error("Pick your name first.");
			return;
		}
		setBusySlotId(slot.id);
		try {
			await releaseSlot({
				data: { slotId: slot.id, actorMemberId: member.id },
			});
			toast.success("Role released.");
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusySlotId(null);
		}
	}

	async function doTakeover(slot: Slot) {
		if (!member) {
			toast.error("Pick your name first.");
			return;
		}
		setBusySlotId(slot.id);
		try {
			await reassignSlot({
				data: {
					slotId: slot.id,
					memberId: member.id,
					actorMemberId: member.id,
				},
			});
			toast.success(`You've taken over ${slot.roleName}.`);
			setTakeoverSlot(null);
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusySlotId(null);
		}
	}

	return (
		<div className="space-y-5 p-4 pb-8">
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
				<Button
					type="button"
					variant={isUnavailable ? "default" : "outline"}
					size="sm"
					onClick={toggleAvailability}
					disabled={!member || availBusy}
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
				<ShareLinkButton
					path={`/club/${clubId}/meeting/${meeting.id}`}
					className="mt-1 ml-2"
				/>
				<Button asChild variant="outline" size="sm">
					<Link
						to="/club/$clubId/meeting/$meetingId/print"
						params={{ clubId, meetingId }}
						search={{ layout: "timing" }}
						target="_blank"
						rel="noopener noreferrer"
					>
						<Printer />
						Print agenda
					</Link>
				</Button>
				<Button asChild variant="outline" size="sm">
					<Link
						to="/club/$clubId/meeting/$meetingId/present"
						params={{ clubId, meetingId }}
						target="_blank"
						rel="noopener noreferrer"
					>
						<Presentation />
						Present
					</Link>
				</Button>
				{isTmod ? (
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

			{categories.map((category) => (
				<section key={category} className="space-y-2">
					<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						{CATEGORY_LABELS[category] ?? category}
					</h2>
					<ul className="space-y-2">
						{slots
							.filter((s) => s.category === category)
							.map((slot) => {
								const isMine = myId !== null && slot.assigneeId === myId;
								const busy = busySlotId === slot.id;
								const isOpen = slot.status === "open";
								return (
									<li
										key={slot.id}
										className="rounded-xl border bg-card p-4 shadow-sm"
									>
										<div className="flex items-start justify-between gap-3">
											<button
												type="button"
												onClick={() => onRowTap(slot)}
												disabled={!isOpen}
												className="min-w-0 flex-1 text-left disabled:cursor-default"
											>
												<p className="font-medium">
													{slotLabel(slot, roleCounts)}
												</p>

												{slot.assigneeId ? (
													<p className="text-sm text-muted-foreground">
														{slot.assigneeName}
														{isMine ? (
															<span className="text-primary"> (you)</span>
														) : null}
													</p>
												) : (
													<p className="text-sm text-muted-foreground">Open</p>
												)}

												{slot.isSpeakerRole && slot.speechTitle ? (
													<div className="mt-1 text-sm">
														<p className="font-medium">
															&ldquo;{slot.speechTitle}&rdquo;
														</p>
														<p className="text-xs text-muted-foreground">
															{[
																slot.pathwayPath,
																slot.projectName,
																slot.projectLevel,
															]
																.filter(Boolean)
																.join(" · ")}
															{slot.minMinutes && slot.maxMinutes
																? ` · ${slot.minMinutes}–${slot.maxMinutes} min`
																: ""}
														</p>
													</div>
												) : null}

												{slot.evaluates ? (
													<p className="mt-1 text-xs text-muted-foreground">
														Evaluates{" "}
														<span className="font-medium text-foreground">
															{slot.evaluates.speechTitle
																? `“${slot.evaluates.speechTitle}”`
																: (slot.evaluates.speakerName ?? "a speaker")}
														</span>
													</p>
												) : null}
											</button>

											<div className="flex shrink-0 flex-col items-end gap-2">
												{isTmod ? (
													<Button
														size="sm"
														variant="outline"
														onClick={() => setAssignSlot(slot)}
													>
														{isOpen ? "Assign…" : "Reassign…"}
													</Button>
												) : null}
												{isOpen ? (
													<Button
														size="sm"
														onClick={() => setClaimSlotState(slot)}
													>
														Claim
													</Button>
												) : isMine ? (
													<>
														<Button
															size="sm"
															variant="outline"
															onClick={() => doRelease(slot)}
															disabled={busy}
														>
															{busy ? (
																<Loader2 className="size-4 animate-spin" />
															) : (
																"Release"
															)}
														</Button>
														{slot.isSpeakerRole ? (
															<button
																type="button"
																onClick={() => setEditSpeechSlot(slot)}
																className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
															>
																Edit speech
															</button>
														) : null}
													</>
												) : (
													<>
														<Badge variant="secondary">Filled</Badge>
														<button
															type="button"
															onClick={() => setTakeoverSlot(slot)}
															className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
														>
															take over
														</button>
													</>
												)}
											</div>
										</div>
									</li>
								);
							})}
					</ul>
					{isTmod && category === "speaker" ? (
						<div className="flex gap-2">
							<Button
								size="sm"
								variant="outline"
								disabled={busySlotId === "add-speaker"}
								onClick={doAddSpeaker}
							>
								+ Add speaker
							</Button>
							{speakerSlots.length > 0 ? (
								<Button
									size="sm"
									variant="outline"
									disabled={busySlotId === "remove-speaker"}
									onClick={doRemoveSpeaker}
								>
									− Remove speaker
								</Button>
							) : null}
						</div>
					) : null}
				</section>
			))}

			{isTmod && speakerSlots.length === 0 ? (
				<section className="space-y-2">
					<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						{CATEGORY_LABELS.speaker}
					</h2>
					<Button
						size="sm"
						variant="outline"
						onClick={doAddSpeaker}
						disabled={busySlotId === "add-speaker"}
					>
						+ Add speaker
					</Button>
				</section>
			) : null}

			<ClaimSheet
				slot={claimSlotState}
				memberId={myId}
				roleCounts={roleCounts}
				onOpenChange={(open) => {
					if (!open) setClaimSlotState(null);
				}}
				onClaimed={async () => {
					setClaimSlotState(null);
					await router.invalidate();
				}}
			/>

			<EditSpeechSheet
				slot={
					editSpeechSlot
						? {
								id: editSpeechSlot.id,
								label: slotLabel(editSpeechSlot, roleCounts),
								speechTitle: editSpeechSlot.speechTitle,
								pathwayPath: editSpeechSlot.pathwayPath,
								projectName: editSpeechSlot.projectName,
								projectLevel: editSpeechSlot.projectLevel,
								minMinutes: editSpeechSlot.minMinutes,
								maxMinutes: editSpeechSlot.maxMinutes,
							}
						: null
				}
				actorMemberId={myId}
				onOpenChange={(open) => {
					if (!open) setEditSpeechSlot(null);
				}}
				onSaved={async () => {
					setEditSpeechSlot(null);
					await router.invalidate();
				}}
			/>

			<Dialog
				open={takeoverSlot !== null}
				onOpenChange={(open) => {
					if (!open) setTakeoverSlot(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Take over this role?</DialogTitle>
						<DialogDescription>
							This is {takeoverSlot?.assigneeName ?? "someone"}'s slot — take it
							over?
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose asChild>
							<Button type="button" variant="ghost">
								Cancel
							</Button>
						</DialogClose>
						<Button
							type="button"
							onClick={() => takeoverSlot && doTakeover(takeoverSlot)}
							disabled={takeoverSlot ? busySlotId === takeoverSlot.id : false}
						>
							{takeoverSlot && busySlotId === takeoverSlot.id ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								"Take it over"
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{isTmod ? (
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

			<AssignSlotSheet
				slot={
					assignSlot
						? {
								id: assignSlot.id,
								roleDefinitionId: assignSlot.roleDefinitionId,
								status: assignSlot.status,
								isSpeakerRole: assignSlot.isSpeakerRole,
								label: slotLabel(assignSlot, roleCounts),
							}
						: null
				}
				roster={roster}
				roleByMemberId={roleByMemberId}
				unavailableIds={unavailableMemberIds}
				roleRecency={roleRecency}
				actorMemberId={myId}
				onOpenChange={(open) => {
					if (!open) setAssignSlot(null);
				}}
				onAssigned={async () => {
					setAssignSlot(null);
					await router.invalidate();
				}}
			/>
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

function ClaimSheet({
	slot,
	memberId,
	roleCounts,
	onOpenChange,
	onClaimed,
}: {
	slot: Slot | null;
	memberId: string | null;
	roleCounts: Record<string, number>;
	onOpenChange: (open: boolean) => void;
	onClaimed: () => void | Promise<void>;
}) {
	const [submitting, setSubmitting] = useState(false);

	async function claimNonSpeaker() {
		if (!slot) return;
		if (!memberId) {
			toast.error("Pick your name first.");
			return;
		}
		setSubmitting(true);
		try {
			await claimSlot({
				data: {
					slotId: slot.id,
					memberId,
					actorMemberId: memberId,
				},
			});
			toast.success(`You're on as ${slot.roleName}.`);
			await onClaimed();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setSubmitting(false);
		}
	}

	async function claimSpeaker(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (!slot) return;
		if (!memberId) {
			toast.error("Pick your name first.");
			return;
		}
		const form = new FormData(e.currentTarget);
		const speechTitle = String(form.get("speechTitle") ?? "").trim();
		const minRaw = form.get("minMinutes");
		const maxRaw = form.get("maxMinutes");
		setSubmitting(true);
		try {
			await claimSlot({
				data: {
					slotId: slot.id,
					memberId,
					actorMemberId: memberId,
					speakerDetails: {
						speechTitle: speechTitle || undefined,
						pathwayPath:
							String(form.get("pathwayPath") ?? "").trim() || undefined,
						projectName:
							String(form.get("projectName") ?? "").trim() || undefined,
						projectLevel:
							String(form.get("projectLevel") ?? "").trim() || undefined,
						minMinutes: minRaw ? Number(minRaw) : undefined,
						maxMinutes: maxRaw ? Number(maxRaw) : undefined,
					},
				},
			});
			toast.success("You're booked to speak!");
			await onClaimed();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setSubmitting(false);
		}
	}

	const isSpeaker = slot?.isSpeakerRole ?? false;
	const title = slot ? slotLabel(slot, roleCounts) : "";

	return (
		<Sheet open={slot !== null} onOpenChange={onOpenChange}>
			<SheetContent side="bottom" className="max-h-[90svh] overflow-y-auto">
				<SheetHeader>
					<SheetTitle>{title || "Claim this role"}</SheetTitle>
					{slot?.description ? (
						<SheetDescription>{slot.description}</SheetDescription>
					) : null}
				</SheetHeader>

				{isSpeaker ? (
					<form onSubmit={claimSpeaker} className="space-y-4 px-4">
						<div className="space-y-2">
							<Label htmlFor="speechTitle">Speech title</Label>
							<Input
								id="speechTitle"
								name="speechTitle"
								placeholder="TBA if not decided yet"
								autoFocus
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="pathwayPath">Pathways path</Label>
							<Input
								id="pathwayPath"
								name="pathwayPath"
								placeholder="e.g. Presentation Mastery"
							/>
						</div>
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-2">
								<Label htmlFor="projectName">Project</Label>
								<Input
									id="projectName"
									name="projectName"
									placeholder="Ice Breaker"
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="projectLevel">Level</Label>
								<Input
									id="projectLevel"
									name="projectLevel"
									placeholder="Level 1"
								/>
							</div>
						</div>
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-2">
								<Label htmlFor="minMinutes">Min minutes</Label>
								<Input
									id="minMinutes"
									name="minMinutes"
									type="number"
									inputMode="numeric"
									min={1}
									placeholder="4"
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="maxMinutes">Max minutes</Label>
								<Input
									id="maxMinutes"
									name="maxMinutes"
									type="number"
									inputMode="numeric"
									min={1}
									placeholder="6"
								/>
							</div>
						</div>
						<SheetFooter className="px-0">
							<Button type="submit" disabled={submitting} className="w-full">
								{submitting ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									"Claim speaking slot"
								)}
							</Button>
							<SheetClose asChild>
								<Button type="button" variant="ghost" className="w-full">
									Cancel
								</Button>
							</SheetClose>
						</SheetFooter>
					</form>
				) : (
					<SheetFooter>
						<Button
							type="button"
							onClick={claimNonSpeaker}
							disabled={submitting}
							className="w-full"
						>
							{submitting ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								"Claim"
							)}
						</Button>
						<SheetClose asChild>
							<Button type="button" variant="ghost" className="w-full">
								Cancel
							</Button>
						</SheetClose>
					</SheetFooter>
				)}
			</SheetContent>
		</Sheet>
	);
}
