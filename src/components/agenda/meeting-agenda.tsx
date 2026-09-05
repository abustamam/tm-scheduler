import { Link } from "@tanstack/react-router";
import { Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { MeetingMetaDialog } from "#/components/agenda/meeting-meta-dialog";
import { MeetingTemplateDialog } from "#/components/agenda/meeting-template-dialog";
import { MeetingWordOfTheDayDialog } from "#/components/agenda/meeting-word-of-the-day-dialog";
import { AssignSlotSheet } from "#/components/club/assign-slot-sheet";
import { EditSpeechSheet } from "#/components/club/edit-speech-sheet";
import { NudgeButtons } from "#/components/club/nudge-buttons";
import {
	buildRecruitTargets,
	NudgeRecruitPicker,
} from "#/components/club/nudge-recruit-picker";
import { ProjectPicker } from "#/components/pathways/project-picker";
import { useProjectOptions } from "#/components/pathways/use-project-options";
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
import type { StoredMember } from "#/lib/member-identity";
import { speechWindow, speechWindowInputError } from "#/lib/speech-window";
import {
	applyTemplateToMeeting,
	listTemplatesForClub,
	type MeetingTemplateSummary,
	previewTemplateForMeeting,
} from "#/server/meeting-templates";
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
	/** Linked catalog project (#418); free text above stays the display. */
	projectId?: string | null;
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
	/** Manager-only (rendered under `canManage`), paired-evaluator cards only. */
	moveEvaluator?: (slot: AgendaSlot, direction: "up" | "down") => Promise<void>;
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
		// Declared so the recruit draft's greeting is a typed contract rather than
		// a field that happens to survive on the object (#486). The public route
		// omits it and `greetingName` falls back to the first token.
		preferredName?: string | null;
	}[];
	roleRecency: RoleRecency;
	/** memberId → their current role label this meeting, lifted to the ROUTE
	 *  (#396 PR 2) so this component and the planned-attendance rail read one
	 *  derivation instead of each computing their own from `slots` — a second
	 *  copy would silently disagree the moment `slotLabel` changes. */
	roleByMemberId: Readonly<Record<string, string>>;
	/** Member ids who marked themselves (or were marked) `not_coming` for this
	 *  meeting — annotates the recruit picker and the assign sheet so a manager
	 *  doesn't nudge or assign someone who already said they're out. */
	unavailableMemberIds: string[];
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
	/** The KEY of the template this meeting is currently running, or null for a
	 *  standard meeting — see `loadTemplateKey`. Feeds the "Current" badge in
	 *  `MeetingTemplateDialog`. Deliberately NOT `meeting.templateId`: since
	 *  conversion started pointing meetings at a private per-meeting copy, that
	 *  id is fresh every conversion and matches no `listAvailableTemplates`
	 *  choice — the `key` a private copy keeps from its source is the stable
	 *  thing to match against. */
	templateKey: string | null;
	/** The meeting's EFFECTIVE number (stored or derived, #358). */
	effectiveMeetingNumber?: number | null;
	/** Club timezone — the meta dialog renders/parses the date field in it. */
	timezone: string;
	/** Self-asserted identity the lifted edit dialogs pass to their server fns
	 *  (ADR-0010 TMOD/Grammarian path). The activity-log actor is NOT sent — the
	 *  server derives it from the session or the verified self-assertion (#396). */
	selfMemberId: string | null;
	onMetaSaved: () => void | Promise<void>;
	/** Public surface: resolve/collect identity before opening the claim flow when there's no identity. */
	requireIdentity?: () => Promise<StoredMember | null>;
	/** Member ids already contacted for this meeting (#340). Admin-only; empty on
	 *  the public/member view. */
	contactedMemberIds: string[];
	/** Mark/unmark a member contacted (#340). Manager surface only. */
	onContacted?: (
		memberId: string,
		via: "nudge" | "manual",
	) => void | Promise<void>;
	onUncontacted?: (memberId: string) => void | Promise<void>;
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
	roleByMemberId,
	unavailableMemberIds,
	pairedRoleIds = new Set<string>(),
	clubGuests = [],
	shareUrl,
	meetingDate,
	meeting,
	templateKey,
	effectiveMeetingNumber = null,
	timezone,
	selfMemberId,
	onMetaSaved,
	requireIdentity,
	contactedMemberIds,
	onContacted,
	onUncontacted,
}: MeetingAgendaProps) {
	const { currentMemberId } = viewer;
	const [wodOpen, setWodOpen] = useState(false);
	const [metaOpen, setMetaOpen] = useState(false);
	// "Change meeting type" (#agenda-templates). Officer-only: reshaping a
	// meeting sits with reschedule and cancel, not with the agenda-content
	// edits ADR-0010 grants the self-asserted Toastmaster.
	const [templateOpen, setTemplateOpen] = useState(false);
	const [templates, setTemplates] = useState<MeetingTemplateSummary[]>([]);
	// Claiming an open slot requires the capability AND either an identity or a
	// `requireIdentity` resolver to collect one at click time — a `lockedViewer`
	// sets `canClaim` false so a locked/past meeting is read-only. Without a
	// resolver, a memberless viewer stays locked out even with `canClaim` true:
	// e.g. a superadmin impersonating a club (ADR-0020) is a memberless
	// effective admin on the authed route, which passes no `requireIdentity` —
	// unlike the public route's prospective (no-identity) visitor, who resolves
	// identity at the claim click (see `handleClaimClick`). Same for every slot,
	// so compute once.
	const canClaim =
		(currentMemberId !== null || requireIdentity !== undefined) &&
		viewer.canClaim;
	const [busySlotId, setBusySlotId] = useState<string | null>(null);
	const [claimSlotState, setClaimSlotState] = useState<AgendaSlot | null>(null);
	const [assignSlot, setAssignSlot] = useState<AgendaSlot | null>(null);
	const [editSpeechSlot, setEditSpeechSlot] = useState<AgendaSlot | null>(null);
	const [takeoverSlot, setTakeoverSlot] = useState<AgendaSlot | null>(null);

	// Number repeated roles ("Speaker 1", "Speaker 2", …).
	const roleCounts = buildRoleCounts(slots);
	const summary = summarizeAgenda(slots);
	const speakerSlots = slots.filter((s) => s.isSpeakerRole);
	// The paired evaluator lineup, for the same ↑↓ reorder speakers get. Pairing
	// is positional (Evaluator N evaluates Speaker N), so reordering evaluators
	// is how a manager decides who evaluates whom. `pairedRoleIds` holds the
	// speaker role too, hence the !isSpeakerRole arm.
	const evaluatorSlots = slots.filter(
		(s) => !s.isSpeakerRole && pairedRoleIds.has(s.roleDefinitionId),
	);
	// The render gate below tests MEMBERSHIP in that list rather than re-stating
	// its predicate: a divergence between the two would render arrows on a card
	// the list doesn't contain, and the first/last comparisons would then both be
	// false — an enabled ↑ on the top row that silently does nothing.
	const evaluatorSlotIds = new Set(evaluatorSlots.map((s) => s.id));

	// Recruiting pool for open-slot nudges (#37) — every active member, annotated
	// (not filtered) with availability + the role they already hold this meeting.
	const recruitTargets = buildRecruitTargets(
		roster,
		new Set(unavailableMemberIds),
		roleByMemberId,
		new Set(contactedMemberIds),
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

	async function handleClaimClick(slot: AgendaSlot) {
		if (slot.status !== "open" || !canClaim) return;
		if (currentMemberId === null && requireIdentity) {
			const me = await requireIdentity();
			if (!me) return; // dismissed → abort
		}
		setClaimSlotState(slot);
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

	async function doMoveEvaluator(slot: AgendaSlot, direction: "up" | "down") {
		await run(
			slot.id,
			() => actions.moveEvaluator?.(slot, direction) ?? Promise.resolve(),
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
			{viewer.canManage ? (
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={async () => {
						// Lazy: the list is an officer affordance nobody else pays for.
						setTemplates(
							await listTemplatesForClub({ data: { clubId: meeting.clubId } }),
						);
						setTemplateOpen(true);
					}}
				>
					Change meeting type
				</Button>
			) : null}
			{viewer.canManage && meeting.templateId ? (
				<Button type="button" variant="outline" size="sm" asChild>
					<Link
						to="/club/$clubId/meeting/$meetingId/agenda"
						params={{ clubId: meeting.clubId, meetingId: meeting.id }}
					>
						Edit agenda
					</Link>
				</Button>
			) : null}
			{viewer.canManage ? (
				<MeetingTemplateDialog
					open={templateOpen}
					onOpenChange={setTemplateOpen}
					currentTemplateKey={templateKey}
					templates={templates}
					loadPreview={(templateId) =>
						previewTemplateForMeeting({
							data: { meetingId: meeting.id, templateId },
						})
					}
					onApply={async (templateId) => {
						await applyTemplateToMeeting({
							data: { meetingId: meeting.id, templateId },
						});
						// Re-runs the meeting loader, so the agenda re-renders in the
						// meeting's new shape.
						await onMetaSaved();
					}}
				/>
			) : null}
			{viewer.canEditMeetingMeta ? (
				<MeetingMetaDialog
					open={metaOpen}
					onOpenChange={setMetaOpen}
					meeting={meeting}
					timezone={timezone}
					selfMemberId={selfMemberId}
					canReschedule={viewer.canManage}
					effectiveMeetingNumber={effectiveMeetingNumber}
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
						{/* No "Remind unfilled" control until reminder sending is actually
						    built (#7) — even a disabled "(soon)" placeholder was dead
						    weight two audits flagged (#542, F-010). */}
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
								// Same rule as the deck and the run sheet (#394): a half-filled
								// Min/Max pair shows no range at all, rather than the one
								// bound that happens to be set.
								const timeWindow = speechWindow(slot);
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
								// The holder's MEMBER id, or null when the slot is open or
								// held by a guest. Read into a const so the narrowing survives
								// into the confirm-nudge callback below — TypeScript discards
								// a narrowing of `slot.assigneeId` the moment it crosses a
								// closure boundary.
								const holderMemberId = slot.assigneeId;
								return (
									<li
										key={slot.id}
										className="rounded-xl border bg-card p-4 shadow-sm"
									>
										<div className="flex items-start justify-between gap-3">
											<button
												type="button"
												onClick={() => handleClaimClick(slot)}
												disabled={!isOpen || !canClaim}
												className="min-w-0 flex-1 text-left disabled:cursor-default"
											>
												<p className="font-medium">
													{slotLabel(slot, roleCounts)}
												</p>

												{slot.assigneeName ? (
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
															{timeWindow
																? ` · ${timeWindow.min}–${timeWindow.max} min`
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
												{/* Accessible names carry the ROW ("Move Speaker 2 up"),
												    not just the lineup: every card in a lineup renders an
												    identical-looking pair, so a bare "Move speaker up" is
												    announced N times with nothing to tell them apart when
												    browsing by control. `slotLabel` is already computed
												    for the card title just above. */}
												{viewer.canManage && slot.isSpeakerRole ? (
													<div className="flex gap-1">
														<Button
															size="sm"
															variant="ghost"
															aria-label={`Move ${slotLabel(slot, roleCounts)} up`}
															disabled={busy || speakerSlots[0]?.id === slot.id}
															onClick={() => doMoveSpeaker(slot, "up")}
														>
															↑
														</Button>
														<Button
															size="sm"
															variant="ghost"
															aria-label={`Move ${slotLabel(slot, roleCounts)} down`}
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

												{viewer.canManage && evaluatorSlotIds.has(slot.id) ? (
													<div className="flex gap-1">
														<Button
															size="sm"
															variant="ghost"
															aria-label={`Move ${slotLabel(slot, roleCounts)} up`}
															disabled={
																busy || evaluatorSlots[0]?.id === slot.id
															}
															onClick={() => doMoveEvaluator(slot, "up")}
														>
															↑
														</Button>
														<Button
															size="sm"
															variant="ghost"
															aria-label={`Move ${slotLabel(slot, roleCounts)} down`}
															disabled={
																busy ||
																evaluatorSlots[evaluatorSlots.length - 1]
																	?.id === slot.id
															}
															onClick={() => doMoveEvaluator(slot, "down")}
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
														preferredName={slot.holderPreferredName}
														phone={slot.holderPhone}
														email={slot.holderEmail}
														roleName={slot.roleName}
														meetingDate={meetingDate}
														shareUrl={shareUrl}
														mode="confirm"
														// Chasing the person who already HOLDS the role is
														// outreach, and it records as such — through the SAME
														// `onContacted` seam the recruit picker twelve lines
														// below already reaches, which the route wires to
														// `setContacted` (#662). Without it, whether an ask
														// counted depended on which of two surfaces the officer
														// used: the identical `mode="confirm"` draft in the
														// attendance rail records it, so a nudge sent from the
														// card the officer is actually looking at left that same
														// member reading "Ask" on the rail beside it.
														//
														// `via: "nudge"` for the same reason the recruit picker
														// and the rail's `markAsked` both spell it that way —
														// one action must not reach `activity_log` under two
														// different names.
														//
														// `setContacted`'s `demoteFrom: ["reached_out"]` floor
														// is what makes firing this unconditionally safe: a
														// holder who has already replied "coming" keeps that
														// answer, so the write can never turn a real reply back
														// into an ask.
														//
														// MEMBER-HELD SLOTS ONLY. A guest holder carries
														// `assigneeGuestId` and no `members` row, so a plan
														// write for them has no foreign key to land on and
														// throws — for the one case that looks perfectly fine
														// on screen, since `assigneeName` is populated for a
														// guest too. `assigneeId` is the field that tells them
														// apart, and an absent `onContacted` leaves the draft
														// links working exactly as they did.
														onContacted={
															holderMemberId
																? () => onContacted?.(holderMemberId, "nudge")
																: undefined
														}
													/>
												) : null}

												{viewer.canManage && isOpen ? (
													<NudgeRecruitPicker
														roleName={slot.roleName}
														meetingDate={meetingDate}
														shareUrl={shareUrl}
														targets={recruitTargets}
														onContacted={(id, via) => onContacted?.(id, via)}
														onUncontacted={(id) => onUncontacted?.(id)}
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
														onClick={() => handleClaimClick(slot)}
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
				claimantMemberId={currentMemberId}
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
								projectId: editSpeechSlot.projectId ?? null,
								assigneeId: editSpeechSlot.assigneeId ?? null,
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
	claimantMemberId,
	canClaim,
	roleCounts,
	onClaim,
	onOpenChange,
	onClaimed,
}: {
	slot: AgendaSlot | null;
	/** Who is claiming — whose declared paths the project picker offers. Null on
	 *  the public surface until a name is picked, which is also when the picker
	 *  first has a subject to load. */
	claimantMemberId: string | null;
	canClaim: boolean;
	roleCounts: Record<string, number>;
	onClaim: (slot: AgendaSlot, speakerDetails?: SpeakerDetails) => Promise<void>;
	onOpenChange: (open: boolean) => void;
	onClaimed: () => void | Promise<void>;
}) {
	const [submitting, setSubmitting] = useState(false);
	const [projectId, setProjectId] = useState<string | null>(null);
	const [openedFor, setOpenedFor] = useState<string | null>(null);
	const paths = useProjectOptions(claimantMemberId, slot !== null);

	// A claim sheet always starts blank — abandoning one slot's pick must not
	// carry it into the next slot the same person opens. Adjusted during render
	// (React's documented pattern) rather than in an effect, since `slot` is
	// rebuilt inline by the caller every render and so can't be an effect dep.
	// Both sides normalize to null: comparing a bare `slot?.id` (undefined with
	// no slot) against null state never settles, and render-phase updates that
	// never settle are an infinite re-render.
	const openSlotId = slot?.id ?? null;
	if (openSlotId !== openedFor) {
		setOpenedFor(openSlotId);
		setProjectId(null);
	}

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
		const minMinutes = minRaw ? Number(minRaw) : undefined;
		const maxMinutes = maxRaw ? Number(maxRaw) : undefined;
		// Both or neither (#394). A half-filled pair is unreadable downstream —
		// the deck, the run sheet and the Timer's marks would each have to guess
		// the bound that wasn't typed — so it never reaches the server.
		const windowError = speechWindowInputError(minMinutes, maxMinutes);
		if (windowError) {
			toast.error(windowError);
			return;
		}
		setSubmitting(true);
		try {
			await onClaim(slot, {
				speechTitle: speechTitle || undefined,
				// Free text is sent as typed; when `projectId` is set the server
				// overwrites all three from the catalog (#418).
				pathwayPath: String(form.get("pathwayPath") ?? "").trim() || undefined,
				projectName: String(form.get("projectName") ?? "").trim() || undefined,
				projectLevel:
					String(form.get("projectLevel") ?? "").trim() || undefined,
				projectId,
				minMinutes,
				maxMinutes,
			});
			toast.success("You're booked to speak!");
			setProjectId(null);
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
						<ProjectPicker
							paths={paths}
							value={projectId}
							onChange={setProjectId}
							fallback={{
								pathwayPath: null,
								projectName: null,
								projectLevel: null,
							}}
						/>
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
