import { Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { MeetingMetaDialog } from "#/components/agenda/meeting-meta-dialog";
import { MeetingWordOfTheDayDialog } from "#/components/agenda/meeting-word-of-the-day-dialog";
import { AssignSlotSheet } from "#/components/club/assign-slot-sheet";
import { EditSpeechSheet } from "#/components/club/edit-speech-sheet";
import { NudgeButtons } from "#/components/club/nudge-buttons";
import {
	buildRecruitTargets,
	NudgeRecruitPicker,
} from "#/components/club/nudge-recruit-picker";
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
import { buildRoleCounts, slotLabel, summarizeAgenda } from "#/lib/agenda";
import type { MeetingViewer } from "#/lib/meeting-viewer";
import type { getMeeting } from "#/server/meetings";

export type AgendaSlot = Awaited<
	ReturnType<typeof getMeeting>
>["slots"][number];
type RoleRecency = Awaited<ReturnType<typeof getMeeting>>["roleRecency"];

/** Speaker details captured when claiming/booking a speaking slot. */
export interface SpeakerDetails {
	speechTitle?: string;
	pathwayPath?: string;
	projectName?: string;
	projectLevel?: string;
	minMinutes?: number;
	maxMinutes?: number;
}

/**
 * Slot mutations the route wires to the appropriate server functions. The
 * component owns the UI (busy state, sheets, toasts) and calls these; each route
 * supplies handlers with the correct identity/auth argument shape (session admin
 * vs. self-asserted member). A handler must throw on failure so the component can
 * surface an error toast. `onMutated` re-fetches the route data after a success.
 */
export interface MeetingAgendaActions {
	claim: (slot: AgendaSlot, speakerDetails?: SpeakerDetails) => Promise<void>;
	release: (slot: AgendaSlot) => Promise<void>;
	addSpeaker: () => Promise<void>;
	removeSpeaker: () => Promise<void>;
	onMutated: () => void | Promise<void>;
	/** Manager-only (rendered under `canManage`). */
	confirm?: (slot: AgendaSlot) => Promise<void>;
	/** Manager-only (rendered under `canManage`). */
	unconfirm?: (slot: AgendaSlot) => Promise<void>;
	/** Manager-only (rendered under `canManage`). */
	moveSpeaker?: (slot: AgendaSlot, direction: "up" | "down") => Promise<void>;
	/** Manager-only (rendered under `canManage`). */
	removeRole?: (slot: AgendaSlot) => Promise<void>;
	/** Self-serve only (rendered under `canTakeOver`). */
	takeover?: (slot: AgendaSlot) => Promise<void>;
}

export interface MeetingAgendaProps {
	slots: AgendaSlot[];
	viewer: MeetingViewer;
	actions: MeetingAgendaActions;
	/** Roster for the assign picker — only needed where `viewer.canAssign`. */
	roster: {
		id: string;
		name: string;
		// Optional so the public route (no contact — PII-safe) still satisfies
		// the prop; the recruit picker that consumes them only renders under
		// `viewer.canManage` (#37).
		phone?: string | null;
		email?: string | null;
	}[];
	roleRecency: RoleRecency;
	unavailableMemberIds: string[];
	/** Named unavailable members for the manager "not available" section. */
	unavailableMembers?: { id: string; name: string }[];
	/** Role ids managed by the speaker pair buttons — the remove-role control
	 *  renders disabled (with the reason) on their non-speaker cards (#225). Only
	 *  consulted for managers; defaults to none. */
	pairedRoleIds?: Set<string>;
	/** Existing club guests for the admin "assign a guest" picker (#151). Admin
	 *  surface only (gated on `viewer.canManage`); empty on the public view. */
	clubGuests?: { id: string; name: string }[];
	/** Absolute public meeting URL + friendly date, for tap-to-nudge (#37). */
	shareUrl: string;
	meetingDate: string;
	/** The full meeting row, for the lifted edit dialogs. The WOD dialog reads
	 *  only a subset (id + wod fields); the meta dialog needs all of it. */
	meeting: Awaited<ReturnType<typeof getMeeting>>["meeting"];
	/** Club timezone — the meta dialog renders/parses the date field in it. */
	timezone: string;
	/** Identity args the lifted edit dialogs pass to their server fns. */
	actorMemberId: string | null;
	selfMemberId: string | null;
	onMetaSaved: () => void | Promise<void>;
}

const CATEGORY_LABELS: Record<string, string> = {
	leadership: "Leadership",
	speaker: "Speakers",
	evaluator: "Evaluation",
	functionary: "Functionaries",
};

function errMessage(err: unknown) {
	return err instanceof Error ? err.message : "Something went wrong.";
}

/**
 * The shared meeting agenda: roles/slots, speeches, and the union of slot
 * actions, each gated by the `viewer` capabilities object. It renders the same
 * for the signed-in workspace and the public club surface — the surrounding
 * shell/header is the route's responsibility. Where a capability is absent, the
 * corresponding control simply isn't rendered.
 */
export function MeetingAgenda({
	slots,
	viewer,
	actions,
	roster,
	roleRecency,
	unavailableMemberIds,
	unavailableMembers = [],
	pairedRoleIds = new Set<string>(),
	clubGuests = [],
	shareUrl,
	meetingDate,
	meeting,
	timezone,
	actorMemberId,
	selfMemberId,
	onMetaSaved,
}: MeetingAgendaProps) {
	const { currentMemberId } = viewer;
	const [wodOpen, setWodOpen] = useState(false);
	const [metaOpen, setMetaOpen] = useState(false);
	// Claiming an open slot requires an identity AND the capability — a
	// `lockedViewer` sets `canClaim` false so a locked/past meeting is read-only.
	// Same for every slot, so compute once.
	const canClaim = currentMemberId !== null && viewer.canClaim;
	const [busySlotId, setBusySlotId] = useState<string | null>(null);
	const [claimSlotState, setClaimSlotState] = useState<AgendaSlot | null>(null);
	const [assignSlot, setAssignSlot] = useState<AgendaSlot | null>(null);
	const [editSpeechSlot, setEditSpeechSlot] = useState<AgendaSlot | null>(null);
	const [takeoverSlot, setTakeoverSlot] = useState<AgendaSlot | null>(null);

	// Number repeated roles ("Speaker 1", "Speaker 2", …).
	const roleCounts = buildRoleCounts(slots);
	const summary = summarizeAgenda(slots);
	const speakerSlots = slots.filter((s) => s.isSpeakerRole);

	// memberId → their current role label this meeting (for the assign picker).
	const roleByMemberId: Record<string, string> = {};
	for (const s of slots) {
		if (s.assigneeId) roleByMemberId[s.assigneeId] = slotLabel(s, roleCounts);
	}

	// Recruiting pool for open-slot nudges (#37) — every active member, annotated
	// (not filtered) with availability + the role they already hold this meeting.
	const recruitTargets = buildRecruitTargets(
		roster,
		new Set(unavailableMemberIds),
		roleByMemberId,
	);

	// Preserve category order as it appears (slots arrive pre-sorted).
	const categories: string[] = [];
	for (const s of slots) {
		if (!categories.includes(s.category)) categories.push(s.category);
	}

	async function run(slotKey: string, fn: () => Promise<void>) {
		setBusySlotId(slotKey);
		try {
			await fn();
			await actions.onMutated();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusySlotId(null);
		}
	}

	async function doRelease(slot: AgendaSlot) {
		await run(slot.id, async () => {
			await actions.release(slot);
			toast.success("Role released.");
		});
	}

	async function doConfirm(slot: AgendaSlot) {
		await run(slot.id, async () => {
			await actions.confirm?.(slot);
			toast.success("Role confirmed.");
		});
	}

	async function doUnconfirm(slot: AgendaSlot) {
		await run(slot.id, async () => {
			await actions.unconfirm?.(slot);
			toast.success("Role unconfirmed.");
		});
	}

	async function doMoveSpeaker(slot: AgendaSlot, direction: "up" | "down") {
		await run(
			slot.id,
			() => actions.moveSpeaker?.(slot, direction) ?? Promise.resolve(),
		);
	}

	async function doTakeover(slot: AgendaSlot) {
		await run(slot.id, async () => {
			await actions.takeover?.(slot);
			toast.success(`You've taken over ${slot.roleName}.`);
			setTakeoverSlot(null);
		});
	}

	async function doRemoveRole(slot: AgendaSlot) {
		await run(slot.id, async () => {
			await actions.removeRole?.(slot);
			toast.success("Role removed.");
		});
	}

	async function doAddSpeaker() {
		await run("add-speaker", async () => {
			await actions.addSpeaker();
		});
	}

	async function doRemoveSpeaker() {
		if (speakerSlots.length <= 1) {
			const ok = window.confirm(
				"This meeting will have no speakers. Continue?",
			);
			if (!ok) return;
		}
		await run("remove-speaker", async () => {
			await actions.removeSpeaker();
		});
	}

	return (
		<>
			{viewer.canEditWod ? (
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => setWodOpen(true)}
				>
					Edit Word of the Day
				</Button>
			) : null}
			{viewer.canEditWod ? (
				<MeetingWordOfTheDayDialog
					open={wodOpen}
					onOpenChange={setWodOpen}
					meeting={meeting}
					actorMemberId={actorMemberId}
					selfMemberId={selfMemberId}
					onSaved={async () => {
						setWodOpen(false);
						await onMetaSaved();
					}}
				/>
			) : null}
			{viewer.canEditMeetingMeta ? (
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => setMetaOpen(true)}
				>
					Edit meeting
				</Button>
			) : null}
			{viewer.canEditMeetingMeta ? (
				<MeetingMetaDialog
					open={metaOpen}
					onOpenChange={setMetaOpen}
					meeting={meeting}
					timezone={timezone}
					actorMemberId={actorMemberId}
					selfMemberId={selfMemberId}
					canReschedule={viewer.canManage}
					onSaved={async () => {
						setMetaOpen(false);
						await onMetaSaved();
					}}
				/>
			) : null}

			{viewer.canManage ? (
				<section className="rounded-xl border bg-card p-4">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
							<span>
								<span className="text-muted-foreground">Open roles: </span>
								<span className="font-semibold">
									{summary.open === 0 ? "All filled" : summary.open}
								</span>
							</span>
							<span>
								<span className="text-muted-foreground">Confirmed: </span>
								<span className="font-semibold">
									{summary.confirmed} of {summary.total}
								</span>
							</span>
							<span>
								<span className="text-muted-foreground">
									Prepared speeches:{" "}
								</span>
								<span className="font-semibold">
									{summary.speakerFilled} of {summary.speakerTotal}
								</span>
							</span>
						</div>
						{/* Reminder sending isn't built yet (#7) — a live-looking button
						    that only apologizes on click erodes trust, so it's disabled
						    with the status in plain sight until the feature lands. */}
						<Button
							size="sm"
							variant="outline"
							disabled
							title="Coming soon — reminder sending isn't built yet"
						>
							Remind unfilled (soon)
						</Button>
					</div>
					<div className="mt-3">
						<div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
							<span>Roles filled</span>
							<span>{summary.pct}%</span>
						</div>
						<div className="h-2 overflow-hidden rounded-full bg-muted">
							<div
								className="h-full rounded-full bg-primary transition-[width]"
								style={{ width: `${summary.pct}%` }}
							/>
						</div>
					</div>
				</section>
			) : null}

			{viewer.canManage && unavailableMembers.length > 0 ? (
				<section className="rounded-xl border border-dashed bg-muted/40 p-4">
					<h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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
								const isMine =
									currentMemberId !== null &&
									slot.assigneeId === currentMemberId;
								const busy = busySlotId === slot.id;
								const isOpen = slot.status === "open";
								// Remove-role (#225): enabled only on an open, unassigned,
								// non-paired slot (matching the server's rules). Everywhere
								// else a manager sees the control disabled with the reason —
								// never silently missing — except on speaker cards, where
								// "− Remove speaker" below is the real affordance. Pairing
								// wins over "assigned": releasing wouldn't make a paired
								// slot removable.
								const paired = pairedRoleIds.has(slot.roleDefinitionId);
								const canRemoveRole = isOpen && !slot.assigneeId && !paired;
								const removeRoleDisabledReason = paired
									? "Remove the paired speaker role instead"
									: "Unassign first";
								return (
									<li
										key={slot.id}
										className="rounded-xl border bg-card p-4 shadow-sm"
									>
										<div className="flex items-start justify-between gap-3">
											<button
												type="button"
												onClick={() => {
													if (isOpen && canClaim) setClaimSlotState(slot);
												}}
												disabled={!isOpen || !canClaim}
												className="min-w-0 flex-1 text-left disabled:cursor-default"
											>
												<p className="font-medium">
													{slotLabel(slot, roleCounts)}
												</p>

												{slot.assigneeId ? (
													<p className="text-sm text-muted-foreground">
														{slot.assigneeName}
														{slot.assigneeIsGuest ? (
															<span className="ml-1 rounded bg-muted px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
																Guest
															</span>
														) : null}
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
												{viewer.canManage && slot.isSpeakerRole ? (
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

												{viewer.canAssign ? (
													<Button
														size="sm"
														variant="outline"
														onClick={() => setAssignSlot(slot)}
													>
														{isOpen ? "Assign…" : "Reassign…"}
													</Button>
												) : null}

												{viewer.canManage && !isOpen && slot.assigneeName ? (
													<NudgeButtons
														name={slot.assigneeName}
														phone={slot.holderPhone}
														email={slot.holderEmail}
														roleName={slot.roleName}
														meetingDate={meetingDate}
														shareUrl={shareUrl}
														mode="confirm"
													/>
												) : null}

												{viewer.canManage && isOpen ? (
													<NudgeRecruitPicker
														roleName={slot.roleName}
														meetingDate={meetingDate}
														shareUrl={shareUrl}
														targets={recruitTargets}
													/>
												) : null}

												{viewer.canManage && !slot.isSpeakerRole ? (
													canRemoveRole ? (
														<Button
															size="sm"
															variant="ghost"
															aria-label={`Remove ${slot.roleName}`}
															disabled={busy}
															onClick={() => doRemoveRole(slot)}
														>
															<Trash2 className="size-4" />
														</Button>
													) : (
														<Button
															size="sm"
															variant="ghost"
															aria-label={`Remove ${slot.roleName} — unavailable: ${removeRoleDisabledReason}`}
															disabled
															title={removeRoleDisabledReason}
														>
															<Trash2 className="size-4" />
														</Button>
													)
												) : null}

												{isOpen ? (
													// Same success-outline treatment as the sign-up grid's
													// Claim cells — one visual language for one verb.
													<Button
														size="sm"
														variant="outline"
														className="border-success/70 text-success hover:bg-success hover:text-success-foreground"
														aria-label={`Claim ${slot.roleName} — open`}
														onClick={() => canClaim && setClaimSlotState(slot)}
														disabled={busy || !canClaim}
													>
														Claim
													</Button>
												) : (isMine && viewer.canReleaseOwn) ||
													viewer.canManage ? (
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
														{(viewer.canManage ||
															(viewer.canEditOwnSpeech && isMine)) &&
														slot.isSpeakerRole ? (
															<button
																type="button"
																onClick={() => setEditSpeechSlot(slot)}
																className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
															>
																Edit speech
															</button>
														) : null}
														{viewer.canManage && slot.status === "claimed" ? (
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
														{viewer.canManage && slot.status === "confirmed" ? (
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
													<>
														<Badge variant="secondary">Filled</Badge>
														{viewer.canTakeOver ? (
															<button
																type="button"
																aria-label={`Take over ${slot.roleName}`}
																onClick={() => setTakeoverSlot(slot)}
																className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
															>
																take over
															</button>
														) : null}
													</>
												)}
											</div>
										</div>
									</li>
								);
							})}
					</ul>
					{viewer.canManageSpeakers && category === "speaker" ? (
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

			{viewer.canManageSpeakers && speakerSlots.length === 0 ? (
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
				canClaim={canClaim}
				roleCounts={roleCounts}
				onClaim={actions.claim}
				onOpenChange={(open) => {
					if (!open) setClaimSlotState(null);
				}}
				onClaimed={async () => {
					setClaimSlotState(null);
					await actions.onMutated();
				}}
			/>

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
				actorMemberId={currentMemberId}
				allowGuests={viewer.canManage}
				clubGuests={clubGuests}
				onOpenChange={(open) => {
					if (!open) setAssignSlot(null);
				}}
				onAssigned={async () => {
					setAssignSlot(null);
					await actions.onMutated();
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
								presentationUrl: editSpeechSlot.presentationUrl ?? null,
							}
						: null
				}
				actorMemberId={currentMemberId}
				onOpenChange={(open) => {
					if (!open) setEditSpeechSlot(null);
				}}
				onSaved={async () => {
					setEditSpeechSlot(null);
					await actions.onMutated();
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
		</>
	);
}

function ClaimSheet({
	slot,
	canClaim,
	roleCounts,
	onClaim,
	onOpenChange,
	onClaimed,
}: {
	slot: AgendaSlot | null;
	canClaim: boolean;
	roleCounts: Record<string, number>;
	onClaim: (slot: AgendaSlot, speakerDetails?: SpeakerDetails) => Promise<void>;
	onOpenChange: (open: boolean) => void;
	onClaimed: () => void | Promise<void>;
}) {
	const [submitting, setSubmitting] = useState(false);

	async function claimNonSpeaker() {
		if (!slot) return;
		if (!canClaim) {
			toast.error("Pick your name first.");
			return;
		}
		setSubmitting(true);
		try {
			await onClaim(slot);
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
		if (!canClaim) {
			toast.error("Pick your name first.");
			return;
		}
		const form = new FormData(e.currentTarget);
		const speechTitle = String(form.get("speechTitle") ?? "").trim();
		const minRaw = form.get("minMinutes");
		const maxRaw = form.get("maxMinutes");
		setSubmitting(true);
		try {
			await onClaim(slot, {
				speechTitle: speechTitle || undefined,
				pathwayPath: String(form.get("pathwayPath") ?? "").trim() || undefined,
				projectName: String(form.get("projectName") ?? "").trim() || undefined,
				projectLevel:
					String(form.get("projectLevel") ?? "").trim() || undefined,
				minMinutes: minRaw ? Number(minRaw) : undefined,
				maxMinutes: maxRaw ? Number(maxRaw) : undefined,
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
