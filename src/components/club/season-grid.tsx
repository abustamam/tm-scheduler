import { Link } from "@tanstack/react-router";
import { Loader2, Lock, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { formatMeetingDate } from "#/lib/format";
import type { StoredMember } from "#/lib/member-identity";
import { meetingRoleOptions } from "#/lib/member-role-picker";
import {
	type MemberMeetingStatus,
	memberMeetingStatus,
	type Orientation,
	projectGrid,
} from "#/lib/season-grid-view";
import { cn } from "#/lib/utils";
import {
	clearAvailability,
	markUnavailableReleasing,
	setAvailability,
} from "#/server/availability";
import type { SeasonGridCount, SeasonGridData } from "#/server/season-grid";
import { claimSlot, releaseSlot } from "#/server/slots";
import { CELL_BASE, CELL_KIND_CLASS, GridCell } from "./grid-cell";
import { MeetingLink } from "./meeting-link";
import { MemberRolePicker } from "./member-role-picker";

const COUNTS: SeasonGridCount[] = [4, 8, "all"];
const VIEWS: { value: Orientation; label: string }[] = [
	{ value: "roles", label: "Roles × Meetings" },
	{ value: "members", label: "Members × Meetings" },
];

export function SeasonGrid({
	data,
	orientation,
	count,
	currentMemberId,
	canManageOthers = false,
	clubId,
	clubSlug,
	showContact = false,
	onOrientationChange,
	onCountChange,
	onChanged,
	requireIdentity,
}: {
	data: SeasonGridData;
	orientation: Orientation;
	count: SeasonGridCount;
	/** When set, the grid becomes interactive as this member: claim/release
	 *  roles (Roles × Meetings) and toggle availability (Members × Meetings). */
	currentMemberId?: string | null;
	/** An officer/admin: may toggle ANY member's availability (Members ×
	 *  Meetings), not just their own row. Attribution stays `currentMemberId`. */
	canManageOthers?: boolean;
	/** Club uuid — required for the availability calls. */
	clubId?: string;
	/** Club slug — when set (public club shell), meeting links in the header
	 *  and cells target the public meeting view instead of `/meetings/$id`. */
	clubSlug?: string;
	/** Show member Email/Phone columns (Members × Meetings, signed-in only). */
	showContact?: boolean;
	onOrientationChange?: (o: Orientation) => void;
	onCountChange?: (c: SeasonGridCount) => void;
	/** Called after a successful mutation so the page can refetch. */
	onChanged?: () => void | Promise<void>;
	/** Public surface: resolve/collect identity before a claim when there's no
	 *  `currentMemberId`. */
	requireIdentity?: () => Promise<StoredMember | null>;
}) {
	const rows = projectGrid(data, orientation);
	// Members × Meetings contact columns (signed-in only) resolve email/phone
	// off the member axis; role rows have no memberId and never render these.
	const showContactCols = orientation === "members" && showContact;
	const contactByMember = new Map(data.members.map((m) => [m.id, m]));
	const meetingStatus = memberMeetingStatus(data, currentMemberId ?? null);
	const labelHead = orientation === "roles" ? "Role" : "Member";
	const anchorRef = useRef<HTMLTableCellElement>(null);
	const selfRowRef = useRef<HTMLTableRowElement>(null);
	const [busySlotId, setBusySlotId] = useState<string | null>(null);
	const [busyMeetingId, setBusyMeetingId] = useState<string | null>(null);
	// The assigned-cell confirm: releasing a role + marking unavailable. When
	// `memberName` is set, an officer is acting on that member (not themselves).
	const [confirm, setConfirm] = useState<{
		memberId: string;
		memberName: string | null;
		meetingId: string;
		roleLabel: string;
		date: string;
	} | null>(null);

	// Roles × Meetings is the claim/release sheet.
	const actingMemberId = orientation === "roles" ? currentMemberId : null;
	// No-identity visitor on the public sign-up sheet: OPEN cells still show
	// "Claim" — the click resolves identity first (via requireIdentity).
	const prospectiveClaim =
		orientation === "roles" && !currentMemberId && !!requireIdentity;

	useEffect(() => {
		anchorRef.current?.scrollIntoView({ inline: "center", block: "nearest" });
	}, []);

	// Members × Meetings: bring the viewer's own row into view on load (and when
	// switching into this orientation), mirroring the horizontal anchor scroll.
	useEffect(() => {
		if (orientation !== "members") return;
		selfRowRef.current?.scrollIntoView({ block: "center", inline: "nearest" });
	}, [orientation]);

	async function claim(slotId: string) {
		// Busy set BEFORE the (possibly multi-second) identity-picker await, so
		// the tapped cell disables for the whole window — otherwise a second tap
		// while the picker is open could fire a duplicate claim.
		setBusySlotId(slotId);
		try {
			let memberId = currentMemberId;
			if (!memberId && requireIdentity) {
				const me = await requireIdentity();
				if (!me) return; // dismissed — finally clears busy
				memberId = me.id;
			}
			if (!memberId) return;
			await claimSlot({
				data: { slotId, memberId, actorMemberId: memberId },
			});
			await onChanged?.();
			// Pass the freshly-resolved memberId, not the (possibly stale/null)
			// `currentMemberId` prop, so Undo works for a prospective claimer too.
			toast.success("Role claimed.", {
				action: { label: "Undo", onClick: () => release(slotId, memberId) },
			});
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Couldn't claim role.");
		} finally {
			setBusySlotId(null);
		}
	}

	async function release(slotId: string, actorMemberId = currentMemberId) {
		if (!actorMemberId) return;
		setBusySlotId(slotId);
		try {
			await releaseSlot({ data: { slotId, actorMemberId } });
			await onChanged?.();
			toast.success("Role released.", {
				action: { label: "Undo", onClick: () => claim(slotId) },
			});
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't release role.",
			);
		} finally {
			setBusySlotId(null);
		}
	}

	// `targetMemberId` is who is being marked (self, or another member when an
	// officer acts); `currentMemberId` is always the actor (attribution).
	async function markUnavailable(targetMemberId: string, meetingId: string) {
		if (!currentMemberId || !clubId) return;
		const self = targetMemberId === currentMemberId;
		setBusyMeetingId(meetingId);
		try {
			await setAvailability({
				data: {
					memberId: targetMemberId,
					actorMemberId: currentMemberId,
					meetingId,
					clubId,
				},
			});
			await onChanged?.();
			toast.success(self ? "Marked unavailable." : "Marked them unavailable.", {
				action: {
					label: "Undo",
					onClick: () => clearUnavailable(targetMemberId, meetingId),
				},
			});
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Couldn't update.");
		} finally {
			setBusyMeetingId(null);
		}
	}

	async function clearUnavailable(targetMemberId: string, meetingId: string) {
		if (!currentMemberId || !clubId) return;
		const self = targetMemberId === currentMemberId;
		setBusyMeetingId(meetingId);
		try {
			await clearAvailability({
				data: {
					memberId: targetMemberId,
					actorMemberId: currentMemberId,
					meetingId,
					clubId,
				},
			});
			await onChanged?.();
			toast.success(
				self ? "You're marked available." : "Marked them available.",
				{
					action: {
						label: "Undo",
						onClick: () => markUnavailable(targetMemberId, meetingId),
					},
				},
			);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Couldn't update.");
		} finally {
			setBusyMeetingId(null);
		}
	}

	async function releaseAndMark(targetMemberId: string, meetingId: string) {
		if (!currentMemberId || !clubId) return;
		const self = targetMemberId === currentMemberId;
		setConfirm(null);
		setBusyMeetingId(meetingId);
		try {
			await markUnavailableReleasing({
				data: {
					memberId: targetMemberId,
					actorMemberId: currentMemberId,
					meetingId,
					clubId,
				},
			});
			await onChanged?.();
			toast.success(
				self
					? "Role released — you're marked unavailable."
					: "Role released — they're marked unavailable.",
			);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Couldn't update.");
		} finally {
			setBusyMeetingId(null);
		}
	}

	// Header chip: decline (or un-decline) a whole meeting for YOURSELF. Holding a
	// role routes through the same release-and-mark confirm as the members cells.
	function onHeaderAvailability(
		m: SeasonGridData["meetings"][number],
		status: MemberMeetingStatus | undefined,
	) {
		if (!status || !currentMemberId) return;
		if (status.declined) {
			clearUnavailable(currentMemberId, m.id);
		} else if (status.heldRoleLabels.length > 0) {
			setConfirm({
				memberId: currentMemberId,
				memberName: null,
				meetingId: m.id,
				roleLabel: status.heldRoleLabels.join(", "),
				date: formatMeetingDate(m.scheduledAt, m.timezone),
			});
		} else {
			markUnavailable(currentMemberId, m.id);
		}
	}

	// Picker "Not available": if the target holds roles in the meeting, route
	// through the release-and-mark confirm; otherwise mark directly.
	function requestUnavailable(
		targetMemberId: string,
		meetingId: string,
		targetName: string,
		isOwnRow: boolean,
	) {
		const held = meetingRoleOptions(data, meetingId, targetMemberId).filter(
			(o) => o.state === "mine",
		);
		const m = data.meetings.find((x) => x.id === meetingId);
		if (held.length > 0) {
			setConfirm({
				memberId: targetMemberId,
				memberName: isOwnRow ? null : targetName,
				meetingId,
				roleLabel: held.map((o) => o.label).join(", "),
				date: m ? formatMeetingDate(m.scheduledAt, m.timezone) : "this meeting",
			});
		} else {
			markUnavailable(targetMemberId, meetingId);
		}
	}

	if (data.meetings.length === 0) {
		return (
			<p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
				No upcoming meetings yet. Create meetings to start planning the season.
			</p>
		);
	}

	if (orientation === "members" && data.members.length === 0) {
		return (
			<p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
				No members yet. Add members from the{" "}
				{clubSlug ? (
					"Roster view"
				) : (
					<Link to="/roster" className="font-medium text-primary underline">
						Roster view
					</Link>
				)}
				.
			</p>
		);
	}

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-4">
				<div className="inline-flex overflow-hidden rounded-lg border">
					{VIEWS.map((v) => (
						<button
							key={v.value}
							type="button"
							onClick={() => onOrientationChange?.(v.value)}
							className={cn(
								"px-3 py-1.5 text-xs font-semibold",
								orientation === v.value
									? "bg-primary text-primary-foreground"
									: "text-muted-foreground",
							)}
						>
							{v.label}
						</button>
					))}
				</div>
				<div className="inline-flex items-center gap-2">
					<span className="text-xs font-medium text-muted-foreground">
						Meetings shown
					</span>
					<div className="inline-flex overflow-hidden rounded-lg border">
						{COUNTS.map((c) => (
							<button
								key={String(c)}
								type="button"
								onClick={() => onCountChange?.(c)}
								className={cn(
									"px-3 py-1.5 text-xs font-semibold",
									count === c
										? "bg-accent text-accent-foreground"
										: "text-muted-foreground",
								)}
							>
								{c === "all" ? "All" : c}
							</button>
						))}
					</div>
				</div>
			</div>

			<div className="overflow-auto rounded-xl border">
				<table className="border-separate border-spacing-1">
					<thead>
						<tr>
							{/* shadow on the sticky label column: without an edge, columns
						    sliding beneath it read as clipped/broken instead of
						    scrolled (the grid auto-scrolls to the upcoming meeting). */}
							<th className="sticky top-0 left-0 z-20 bg-card px-3 py-2 text-left text-xs font-semibold shadow-[4px_0_6px_-4px_rgba(0,0,0,0.35)]">
								{labelHead}
							</th>
							{data.meetings.map((m) => {
								const status = meetingStatus.get(m.id);
								const chipVisible =
									!!currentMemberId && !!clubId && !m.isPast && !m.isCompleted;
								const header = (
									<>
										<div>{formatMeetingDate(m.scheduledAt, m.timezone)}</div>
										{m.isCompleted ? (
											<div className="flex items-center justify-center gap-0.5 text-[10px] font-semibold text-muted-foreground">
												<Lock className="size-2.5" aria-hidden />
												locked
											</div>
										) : (
											// "ended", not "done": a past meeting still accepts
											// late sign-ups (recording who stepped in), so the
											// label shouldn't read as closed.
											<div className="text-[10px] font-medium text-warning-foreground">
												{m.isPast
													? "ended"
													: m.openCount === 0
														? "full"
														: `${m.openCount} open`}
											</div>
										)}
									</>
								);
								return (
									<th
										key={m.id}
										ref={m.isAnchor ? anchorRef : undefined}
										className={cn(
											"sticky top-0 min-w-[3.5rem] bg-card px-2 py-2 text-center text-xs font-semibold",
											m.isPast && !m.isCompleted && "opacity-45",
											m.isCompleted && "bg-muted/60",
											m.isAnchor && "rounded-md ring-2 ring-primary",
										)}
									>
										{/* py-2 below md: the date link + the chip below can't both
										    reach 44px inside today's ~60px header, so the link gets
										    real padding (the header grows a little on the phone);
										    md+ is py-0 — unchanged (#224). */}
										<MeetingLink
											clubSlug={clubSlug}
											meetingId={m.id}
											className="block py-2 md:py-0"
										>
											{header}
										</MeetingLink>
										{chipVisible ? (
											<button
												type="button"
												disabled={busyMeetingId === m.id}
												onClick={() => onHeaderAvailability(m, status)}
												title={
													status?.declined
														? "Tap if you can make it after all"
														: "Mark yourself unavailable — I can't make this one"
												}
												aria-label={`${
													status?.declined ? "Not going" : "Can't go"
												} — ${formatMeetingDate(m.scheduledAt, m.timezone)}`}
												className={cn(
													// px-2.5/py-1/11px (was px-1.5/py-0.5/10px): the chip is a
													// primary mobile action — 19px tall was too small to tap.
													"mx-auto mt-1 flex cursor-pointer items-center gap-0.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap transition-colors disabled:opacity-50",
													// Below md the pill gets a bit more padding (~33px) and an
													// invisible ::after pad tops it up to a ≥44px hit area:
													// 4px up (exactly the mt-1 gap, so it never covers the
													// date link) + 12px down (exactly the th padding + row
													// gap, so it never covers the first grid row) (#224).
													"max-md:relative max-md:py-2 max-md:after:absolute max-md:after:inset-x-0 max-md:after:-top-1 max-md:after:-bottom-3 max-md:after:content-['']",
													status?.declined
														? // Same fill recipe as the destructive Button variant, so
															// white text stays AA in dark (destructive/60 ⇒ 6.0:1).
															"border-destructive bg-destructive text-white hover:opacity-80 dark:border-destructive/60 dark:bg-destructive/60"
														: "border-border text-muted-foreground/70 hover:border-destructive/50 hover:text-destructive",
												)}
											>
												{busyMeetingId === m.id ? (
													<Loader2
														className="size-2.5 animate-spin"
														aria-hidden
													/>
												) : status?.declined ? (
													<>
														Not going
														<X className="size-2.5" aria-hidden />
													</>
												) : (
													"Can't go"
												)}
											</button>
										) : null}
									</th>
								);
							})}
							{showContactCols ? (
								<>
									<th className="sticky top-0 bg-card px-3 py-2 text-left text-xs font-semibold">
										Email
									</th>
									<th className="sticky top-0 bg-card px-3 py-2 text-left text-xs font-semibold">
										Phone
									</th>
								</>
							) : null}
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => {
							const isMemberView = orientation === "members";
							const isSelfRow =
								isMemberView &&
								!!currentMemberId &&
								row.memberId === currentMemberId;
							// Recede OTHER members only on the self-serve sheet. The officer
							// schedule (canManageOthers) manages everyone, so nothing dims
							// there — every row stays full-strength.
							const dimRow =
								isMemberView &&
								!!row.memberId &&
								!isSelfRow &&
								!!currentMemberId &&
								!canManageOthers;
							// Dimmed cells brighten when the row is hovered (`group`), so any
							// member can still be traced across the meeting columns.
							const tdClass = cn(
								"p-0",
								dimRow &&
									"opacity-55 transition-opacity group-hover:opacity-100",
							);
							const contact = row.memberId
								? contactByMember.get(row.memberId)
								: undefined;
							return (
								<tr
									key={row.id}
									ref={isSelfRow ? selfRowRef : undefined}
									className={cn(
										"group transition-colors",
										isSelfRow ? "bg-primary/[0.07]" : "hover:bg-muted/40",
									)}
								>
									<th
										className={cn(
											"sticky left-0 z-10 px-3 py-1 text-right text-xs font-semibold whitespace-nowrap",
											isSelfRow
												? // Opaque tinted fill (color-mix stays opaque, so nothing
													// bleeds under the sticky column) + a 3px inset accent bar.
													"bg-[color-mix(in_oklab,var(--card),var(--primary)_8%)] shadow-[inset_3px_0_0_0_var(--primary),4px_0_6px_-4px_rgba(0,0,0,0.35)]"
												: "bg-card group-hover:bg-muted shadow-[4px_0_6px_-4px_rgba(0,0,0,0.35)]",
										)}
									>
										{row.memberId ? (
											// Below md the row is already 44px tall (the cells grew),
											// so an invisible ::before pad stretches this ~17px text
											// link over the whole row height (±14px) and into the th
											// side padding (±8px) without moving a pixel visually;
											// md+ renders exactly as before (#224).
											<Link
												to="/members/$id"
												params={{ id: row.memberId }}
												className="hover:underline max-md:relative max-md:before:absolute max-md:before:-inset-x-2 max-md:before:-inset-y-3.5 max-md:before:content-['']"
											>
												{row.label}
											</Link>
										) : (
											row.label
										)}
										{isSelfRow ? (
											<span className="ml-1.5 inline-flex items-center rounded-full bg-primary px-1.5 py-0.5 align-middle text-[10px] font-semibold leading-none text-primary-foreground">
												You
											</span>
										) : null}
									</th>
									{row.cells.map((cell, i) => {
										const m = data.meetings[i];
										const isOwnRow =
											!!currentMemberId && row.memberId === currentMemberId;
										const targetMemberId = row.memberId;
										// Members × Meetings, an upcoming (not past/locked) meeting →
										// the cell opens the role picker: your own row for anyone, or
										// ANY member's row for an officer (canManageOthers).
										const editable =
											orientation === "members" &&
											!!targetMemberId &&
											!!currentMemberId &&
											!!clubId &&
											!!m &&
											!m.isCompleted &&
											!m.isPast &&
											(isOwnRow || canManageOthers);
										if (editable && m && targetMemberId && currentMemberId) {
											const label = row.label;
											const date = formatMeetingDate(m.scheduledAt, m.timezone);
											return (
												<td key={`${row.id}:${m.id}`} className={tdClass}>
													<MemberRolePicker
														data={data}
														meetingId={m.id}
														meetingDate={date}
														targetMemberId={targetMemberId}
														targetName={label}
														isOwnRow={isOwnRow}
														canReassign={canManageOthers}
														actorMemberId={currentMemberId}
														declined={cell.kind === "na"}
														onMarkUnavailable={() =>
															requestUnavailable(
																targetMemberId,
																m.id,
																label,
																isOwnRow,
															)
														}
														onMarkAvailable={() =>
															clearUnavailable(targetMemberId, m.id)
														}
														onChanged={() => onChanged?.()}
													>
														<button
															type="button"
															disabled={busyMeetingId === m.id}
															title={cell.title || "Assign a role"}
															aria-label={`Edit ${label} — ${date}`}
															className={cn(
																CELL_BASE,
																CELL_KIND_CLASS[cell.kind],
																"w-full cursor-pointer transition-[filter,border-color] hover:brightness-95 disabled:opacity-50",
																cell.kind === "free" &&
																	"hover:border-[var(--lagoon-deep)] hover:text-[var(--lagoon-deep)]",
															)}
														>
															{cell.text || (
																<Plus
																	className="size-3.5 opacity-40"
																	aria-hidden
																/>
															)}
														</button>
													</MemberRolePicker>
												</td>
											);
										}
										return (
											<td key={`${row.id}:${m?.id}`} className={tdClass}>
												<GridCell
													cell={cell}
													currentMemberId={actingMemberId}
													prospectiveClaim={prospectiveClaim}
													busy={
														(!!cell.slotId && busySlotId === cell.slotId) ||
														busyMeetingId === cell.meetingId
													}
													onClaim={claim}
													onRelease={release}
													clubSlug={clubSlug}
													meetingLabel={
														m
															? formatMeetingDate(m.scheduledAt, m.timezone)
															: undefined
													}
												/>
											</td>
										);
									})}
									{showContactCols ? (
										<>
											<td className="px-3 py-1 text-left text-xs whitespace-nowrap">
												{contact?.email ? (
													<a
														href={`mailto:${contact.email}`}
														className="text-primary hover:underline"
													>
														{contact.email}
													</a>
												) : (
													<span className="text-muted-foreground">—</span>
												)}
											</td>
											<td className="px-3 py-1 text-left text-xs whitespace-nowrap">
												{contact?.phone ? (
													<a
														href={`tel:${contact.phone}`}
														className="text-primary hover:underline"
													>
														{contact.phone}
													</a>
												) : (
													<span className="text-muted-foreground">—</span>
												)}
											</td>
										</>
									) : null}
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>

			<Dialog
				open={confirm !== null}
				onOpenChange={(o) => !o && setConfirm(null)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{confirm?.memberName
								? `Mark ${confirm.memberName} unavailable?`
								: "Mark yourself unavailable?"}
						</DialogTitle>
						<DialogDescription>
							{confirm?.memberName
								? `${confirm.memberName} is ${confirm?.roleLabel} on ${confirm?.date}. Release the role and mark them unavailable for the meeting?`
								: `You're ${confirm?.roleLabel} on ${confirm?.date}. Release and mark yourself unavailable for the meeting?`}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setConfirm(null)}>
							Cancel
						</Button>
						<Button
							onClick={() =>
								confirm && releaseAndMark(confirm.memberId, confirm.meetingId)
							}
						>
							Release &amp; mark unavailable
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
