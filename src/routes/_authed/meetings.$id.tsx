import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
	CalendarDays,
	CalendarOff,
	Loader2,
	MapPin,
	Sparkles,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AssignSlotSheet } from "#/components/club/assign-slot-sheet";
import { EditSpeechSheet } from "#/components/club/edit-speech-sheet";
import { MeetingNavStrip } from "#/components/club/meeting-nav-strip";
import { MeetingViewActions } from "#/components/club/meeting-view-actions";
import { PageContainer } from "#/components/page-container";
import { ShareLinkButton } from "#/components/share-link-button";
import { Badge } from "#/components/ui/badge";
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
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "#/components/ui/sheet";
import { buildRoleCounts, slotLabel } from "#/lib/agenda";
import { utcToZonedWallTime } from "#/lib/datetime";
import { formatMeetingDate, formatMeetingTimeRange } from "#/lib/format";
import { deriveMeetingNavItems } from "#/lib/meeting-nav";
import {
	getMeeting,
	listUpcomingMeetings,
	updateMeeting,
} from "#/server/meetings";
import {
	addSpeakerSlot,
	claimSlot,
	confirmSlot,
	moveSpeakerSlot,
	releaseSlot,
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
		return { ...data, navItems };
	},
	component: MeetingDetail,
});

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

function MeetingDetail() {
	const {
		meeting,
		slots,
		canManage,
		timezone,
		unavailableMembers,
		clubSlug,
		roster,
		navItems,
	} = Route.useLoaderData();
	const { currentMemberId } = Route.useRouteContext();
	const router = useRouter();
	const [busySlotId, setBusySlotId] = useState<string | null>(null);
	const [speakerSlot, setSpeakerSlot] = useState<Slot | null>(null);
	const [editOpen, setEditOpen] = useState(false);
	const [assignSlot, setAssignSlot] = useState<Slot | null>(null);
	const [editSpeechSlot, setEditSpeechSlot] = useState<Slot | null>(null);

	// Number repeated roles ("Speaker 1", "Speaker 2", …).
	const roleCounts = buildRoleCounts(slots);

	// memberId → their current role label this meeting (for picker flags).
	const roleByMemberId: Record<string, string> = {};
	for (const s of slots) {
		if (s.assigneeId) roleByMemberId[s.assigneeId] = slotLabel(s, roleCounts);
	}

	// Preserve category order as it appears (slots arrive pre-sorted).
	const categories: string[] = [];
	for (const s of slots) {
		if (!categories.includes(s.category)) categories.push(s.category);
	}

	async function doClaim(slot: Slot) {
		if (!currentMemberId) {
			toast.error("Your account isn't linked to a club member yet.");
			return;
		}
		if (slot.isSpeakerRole) {
			setSpeakerSlot(slot);
			return;
		}
		setBusySlotId(slot.id);
		try {
			await claimSlot({
				data: {
					slotId: slot.id,
					memberId: currentMemberId,
					actorMemberId: currentMemberId,
				},
			});
			toast.success(`You're on as ${slot.roleName}.`);
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusySlotId(null);
		}
	}

	async function doRelease(slot: Slot) {
		if (!currentMemberId) {
			toast.error("Your account isn't linked to a club member yet.");
			return;
		}
		setBusySlotId(slot.id);
		try {
			await releaseSlot({
				data: { slotId: slot.id, actorMemberId: currentMemberId },
			});
			toast.success("Role released.");
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusySlotId(null);
		}
	}

	async function doConfirm(slot: Slot) {
		if (!currentMemberId) {
			toast.error("Your account isn't linked to a club member yet.");
			return;
		}
		setBusySlotId(slot.id);
		try {
			await confirmSlot({
				data: { slotId: slot.id, actorMemberId: currentMemberId },
			});
			toast.success("Role confirmed.");
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusySlotId(null);
		}
	}

	async function doUnconfirm(slot: Slot) {
		if (!currentMemberId) {
			toast.error("Your account isn't linked to a club member yet.");
			return;
		}
		setBusySlotId(slot.id);
		try {
			await unconfirmSlot({
				data: { slotId: slot.id, actorMemberId: currentMemberId },
			});
			toast.success("Role unconfirmed.");
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusySlotId(null);
		}
	}

	const speakerSlots = slots.filter((s) => s.isSpeakerRole);

	async function doAddSpeaker() {
		setBusySlotId("add-speaker");
		try {
			await addSpeakerSlot({
				data: { meetingId: meeting.id, actorMemberId: currentMemberId },
			});
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusySlotId(null);
		}
	}

	async function doRemoveSpeaker() {
		if (speakerSlots.length <= 1) {
			const ok = window.confirm(
				"This meeting will have no speakers. Continue?",
			);
			if (!ok) return;
		}
		setBusySlotId("remove-speaker");
		try {
			await removeSpeakerSlot({
				data: { meetingId: meeting.id, actorMemberId: currentMemberId },
			});
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusySlotId(null);
		}
	}

	async function doMoveSpeaker(slot: Slot, direction: "up" | "down") {
		setBusySlotId(slot.id);
		try {
			await moveSpeakerSlot({
				data: { slotId: slot.id, direction, actorMemberId: currentMemberId },
			});
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusySlotId(null);
		}
	}

	return (
		<PageContainer className="space-y-5">
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
					<MeetingViewActions clubSlug={clubSlug} meetingId={meeting.id} />
					{canManage ? (
						<Button
							size="sm"
							variant="outline"
							onClick={() => setEditOpen(true)}
						>
							Edit meeting
						</Button>
					) : null}
				</div>
			</header>

			{unavailableMembers.length > 0 ? (
				<section className="rounded-xl border border-dashed bg-muted/40 p-4">
					<h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						<CalendarOff className="size-4" aria-hidden />
						Not available this week
					</h2>
					<p className="mt-1 text-xs text-muted-foreground">
						Marked themselves out — skip them when filling open roles.
					</p>
					<div className="mt-2 flex flex-wrap gap-1.5">
						{unavailableMembers.map((m) => (
							<Badge key={m.id} variant="secondary">
								{m.name}
							</Badge>
						))}
					</div>
				</section>
			) : null}

			{categories.map((category) => (
				<section key={category} className="space-y-2">
					<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						{CATEGORY_LABELS[category] ?? category}
					</h2>
					<ul className="space-y-2">
						{slots
							.filter((s) => s.category === category)
							.map((slot) => {
								const isMine = slot.assigneeId === currentMemberId;
								const busy = busySlotId === slot.id;
								return (
									<li
										key={slot.id}
										className="rounded-xl border bg-card p-4 shadow-sm"
									>
										<div className="flex items-start justify-between gap-3">
											<div className="min-w-0 flex-1">
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
														<p className="font-medium">“{slot.speechTitle}”</p>
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
											</div>

											<div className="flex shrink-0 flex-col gap-2">
												{canManage && slot.isSpeakerRole ? (
													<div className="flex gap-1">
														<Button
															size="sm"
															variant="ghost"
															aria-label="Move speaker up"
															disabled={busy || speakerSlots[0]?.id === slot.id}
															onClick={() => doMoveSpeaker(slot, "up")}
														>
															↑
														</Button>
														<Button
															size="sm"
															variant="ghost"
															aria-label="Move speaker down"
															disabled={
																busy ||
																speakerSlots[speakerSlots.length - 1]?.id ===
																	slot.id
															}
															onClick={() => doMoveSpeaker(slot, "down")}
														>
															↓
														</Button>
													</div>
												) : null}
												{canManage ? (
													<div className="flex flex-wrap items-center gap-2">
														<Button
															size="sm"
															variant="outline"
															onClick={() => setAssignSlot(slot)}
														>
															{slot.status === "open" ? "Assign…" : "Reassign…"}
														</Button>
														{slot.isSpeakerRole && slot.status !== "open" ? (
															<Button
																size="sm"
																variant="ghost"
																onClick={() => setEditSpeechSlot(slot)}
															>
																Edit speech
															</Button>
														) : null}
													</div>
												) : null}
												{slot.status === "open" ? (
													<Button
														size="sm"
														onClick={() => doClaim(slot)}
														disabled={busy}
													>
														{busy ? (
															<Loader2 className="size-4 animate-spin" />
														) : (
															"Claim"
														)}
													</Button>
												) : isMine || canManage ? (
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
														{canManage && slot.status === "claimed" ? (
															<Button
																size="sm"
																onClick={() => doConfirm(slot)}
																disabled={busy}
															>
																{busy ? (
																	<Loader2 className="size-4 animate-spin" />
																) : (
																	"Confirm"
																)}
															</Button>
														) : null}
														{canManage && slot.status === "confirmed" ? (
															<Button
																size="sm"
																variant="secondary"
																onClick={() => doUnconfirm(slot)}
																disabled={busy}
															>
																{busy ? (
																	<Loader2 className="size-4 animate-spin" />
																) : (
																	"Unconfirm"
																)}
															</Button>
														) : null}
													</>
												) : (
													<Badge variant="secondary">Filled</Badge>
												)}
											</div>
										</div>
									</li>
								);
							})}
					</ul>
					{canManage && category === "speaker" ? (
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

			{canManage && speakerSlots.length === 0 ? (
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
			<ClaimSpeakerSheet
				slot={speakerSlot}
				currentMemberId={currentMemberId}
				onOpenChange={(open) => {
					if (!open) setSpeakerSlot(null);
				}}
				onClaimed={async () => {
					setSpeakerSlot(null);
					await router.invalidate();
				}}
			/>
			<AssignSlotSheet
				slot={
					assignSlot
						? {
								id: assignSlot.id,
								status: assignSlot.status,
								isSpeakerRole: assignSlot.isSpeakerRole,
								label: slotLabel(assignSlot, roleCounts),
							}
						: null
				}
				roster={roster}
				roleByMemberId={roleByMemberId}
				unavailableIds={unavailableMembers.map((m) => m.id)}
				actorMemberId={currentMemberId}
				onOpenChange={(open) => {
					if (!open) setAssignSlot(null);
				}}
				onAssigned={async () => {
					setAssignSlot(null);
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
				actorMemberId={currentMemberId}
				onOpenChange={(open) => {
					if (!open) setEditSpeechSlot(null);
				}}
				onSaved={async () => {
					setEditSpeechSlot(null);
					await router.invalidate();
				}}
			/>
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

function ClaimSpeakerSheet({
	slot,
	currentMemberId,
	onOpenChange,
	onClaimed,
}: {
	slot: Slot | null;
	currentMemberId: string | null;
	onOpenChange: (open: boolean) => void;
	onClaimed: () => void | Promise<void>;
}) {
	const [submitting, setSubmitting] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (!slot) return;
		if (!currentMemberId) {
			toast.error("Your account isn't linked to a club member yet.");
			return;
		}
		const form = new FormData(e.currentTarget);
		const speechTitle = String(form.get("speechTitle") ?? "").trim();
		if (!speechTitle) {
			toast.error("A speech title is required.");
			return;
		}
		const minRaw = form.get("minMinutes");
		const maxRaw = form.get("maxMinutes");
		setSubmitting(true);
		try {
			await claimSlot({
				data: {
					slotId: slot.id,
					memberId: currentMemberId,
					actorMemberId: currentMemberId,
					speakerDetails: {
						speechTitle,
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

	return (
		<Sheet open={slot !== null} onOpenChange={onOpenChange}>
			<SheetContent side="bottom" className="max-h-[90svh] overflow-y-auto">
				<SheetHeader>
					<SheetTitle>Claim a speaking slot</SheetTitle>
					<SheetDescription>
						Tell the club what you'll be presenting.
					</SheetDescription>
				</SheetHeader>
				<form onSubmit={onSubmit} className="space-y-4 px-4">
					<div className="space-y-2">
						<Label htmlFor="speechTitle">Speech title</Label>
						<Input id="speechTitle" name="speechTitle" required autoFocus />
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
			</SheetContent>
		</Sheet>
	);
}
