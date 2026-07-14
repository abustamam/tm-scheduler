import { Link } from "@tanstack/react-router";
import { Loader2, Lock, X } from "lucide-react";
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
import {
	type MemberMeetingStatus,
	memberMeetingStatus,
	type Orientation,
	projectGrid,
	type ViewCell,
} from "#/lib/season-grid-view";
import { cn } from "#/lib/utils";
import {
	clearAvailability,
	markUnavailableReleasing,
	setAvailability,
} from "#/server/availability";
import type { SeasonGridCount, SeasonGridData } from "#/server/season-grid";
import { claimSlot, releaseSlot } from "#/server/slots";
import { GridCell } from "./grid-cell";
import { MeetingLink } from "./meeting-link";

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
	clubId,
	clubSlug,
	onOrientationChange,
	onCountChange,
	onChanged,
}: {
	data: SeasonGridData;
	orientation: Orientation;
	count: SeasonGridCount;
	/** When set, the grid becomes interactive as this member: claim/release
	 *  roles (Roles × Meetings) and toggle availability (Members × Meetings). */
	currentMemberId?: string | null;
	/** Club uuid — required for the availability calls. */
	clubId?: string;
	/** Club slug — when set (public club shell), meeting links in the header
	 *  and cells target the public meeting view instead of `/meetings/$id`. */
	clubSlug?: string;
	onOrientationChange?: (o: Orientation) => void;
	onCountChange?: (c: SeasonGridCount) => void;
	/** Called after a successful mutation so the page can refetch. */
	onChanged?: () => void | Promise<void>;
}) {
	const rows = projectGrid(data, orientation);
	const meetingStatus = memberMeetingStatus(data, currentMemberId ?? null);
	const labelHead = orientation === "roles" ? "Role" : "Member";
	const anchorRef = useRef<HTMLTableCellElement>(null);
	const [busySlotId, setBusySlotId] = useState<string | null>(null);
	const [busyMeetingId, setBusyMeetingId] = useState<string | null>(null);
	// The assigned-cell confirm: releasing your role + marking unavailable.
	const [confirm, setConfirm] = useState<{
		meetingId: string;
		roleLabel: string;
		date: string;
	} | null>(null);

	// Roles × Meetings is the claim/release sheet.
	const actingMemberId = orientation === "roles" ? currentMemberId : null;

	useEffect(() => {
		anchorRef.current?.scrollIntoView({ inline: "center", block: "nearest" });
	}, []);

	async function claim(slotId: string) {
		if (!currentMemberId) return;
		setBusySlotId(slotId);
		try {
			await claimSlot({
				data: {
					slotId,
					memberId: currentMemberId,
					actorMemberId: currentMemberId,
				},
			});
			await onChanged?.();
			toast.success("Role claimed.", {
				action: { label: "Undo", onClick: () => release(slotId) },
			});
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Couldn't claim role.");
		} finally {
			setBusySlotId(null);
		}
	}

	async function release(slotId: string) {
		if (!currentMemberId) return;
		setBusySlotId(slotId);
		try {
			await releaseSlot({ data: { slotId, actorMemberId: currentMemberId } });
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

	async function markUnavailable(meetingId: string) {
		if (!currentMemberId || !clubId) return;
		setBusyMeetingId(meetingId);
		try {
			await setAvailability({
				data: { memberId: currentMemberId, meetingId, clubId },
			});
			await onChanged?.();
			toast.success("Marked unavailable.", {
				action: { label: "Undo", onClick: () => clearUnavailable(meetingId) },
			});
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Couldn't update.");
		} finally {
			setBusyMeetingId(null);
		}
	}

	async function clearUnavailable(meetingId: string) {
		if (!currentMemberId || !clubId) return;
		setBusyMeetingId(meetingId);
		try {
			await clearAvailability({
				data: { memberId: currentMemberId, meetingId, clubId },
			});
			await onChanged?.();
			toast.success("You're marked available.", {
				action: { label: "Undo", onClick: () => markUnavailable(meetingId) },
			});
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Couldn't update.");
		} finally {
			setBusyMeetingId(null);
		}
	}

	async function releaseAndMark(meetingId: string) {
		if (!currentMemberId || !clubId) return;
		setConfirm(null);
		setBusyMeetingId(meetingId);
		try {
			await markUnavailableReleasing({
				data: { memberId: currentMemberId, meetingId, clubId },
			});
			await onChanged?.();
			toast.success("Role released — you're marked unavailable.");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Couldn't update.");
		} finally {
			setBusyMeetingId(null);
		}
	}

	function onAvailability(cell: ViewCell) {
		if (cell.kind === "na") {
			clearUnavailable(cell.meetingId);
		} else if (cell.kind === "assigned") {
			const m = data.meetings.find((x) => x.id === cell.meetingId);
			setConfirm({
				meetingId: cell.meetingId,
				roleLabel: cell.title,
				date: m ? formatMeetingDate(m.scheduledAt, m.timezone) : "this meeting",
			});
		} else {
			markUnavailable(cell.meetingId);
		}
	}

	// Header chip: decline (or un-decline) a whole meeting. Holding a role
	// routes through the same release-and-mark confirm as the members-row cells.
	function onHeaderAvailability(
		m: SeasonGridData["meetings"][number],
		status: MemberMeetingStatus | undefined,
	) {
		if (!status) return;
		if (status.declined) {
			clearUnavailable(m.id);
		} else if (status.heldRoleLabels.length > 0) {
			setConfirm({
				meetingId: m.id,
				roleLabel: status.heldRoleLabels.join(", "),
				date: formatMeetingDate(m.scheduledAt, m.timezone),
			});
		} else {
			markUnavailable(m.id);
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
				No members yet. Add members from the Roster view.
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
							<th className="sticky top-0 left-0 z-20 bg-card px-3 py-2 text-left text-xs font-semibold">
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
											<div className="text-[10px] font-medium text-amber-700">
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
										<MeetingLink
											clubSlug={clubSlug}
											meetingId={m.id}
											className="block"
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
													"mx-auto mt-1 flex cursor-pointer items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap transition-colors disabled:opacity-50",
													status?.declined
														? "border-rose-700 bg-rose-700 text-white hover:opacity-80"
														: "border-border text-muted-foreground/70 hover:border-rose-400 hover:text-rose-700",
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
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr key={row.id}>
								<th className="sticky left-0 z-10 bg-card px-3 py-1 text-right text-xs font-semibold whitespace-nowrap">
									{row.memberId ? (
										<Link
											to="/members/$id"
											params={{ id: row.memberId }}
											className="hover:underline"
										>
											{row.label}
										</Link>
									) : (
										row.label
									)}
								</th>
								{row.cells.map((cell, i) => {
									const m = data.meetings[i];
									// Members × Meetings, your own row, an upcoming (not
									// past/locked) meeting → the cell toggles your availability.
									const availabilityEditable =
										orientation === "members" &&
										!!currentMemberId &&
										row.memberId === currentMemberId &&
										!!m &&
										!m.isCompleted &&
										!m.isPast;
									return (
										<td key={`${row.id}:${m?.id}`} className="p-0">
											<GridCell
												cell={cell}
												currentMemberId={actingMemberId}
												busy={
													(!!cell.slotId && busySlotId === cell.slotId) ||
													busyMeetingId === cell.meetingId
												}
												onClaim={claim}
												onRelease={release}
												availabilityEditable={availabilityEditable}
												onAvailability={onAvailability}
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
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<Dialog
				open={confirm !== null}
				onOpenChange={(o) => !o && setConfirm(null)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Mark yourself unavailable?</DialogTitle>
						<DialogDescription>
							You're {confirm?.roleLabel} on {confirm?.date}. Release and mark
							yourself unavailable for the meeting?
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setConfirm(null)}>
							Cancel
						</Button>
						<Button
							onClick={() => confirm && releaseAndMark(confirm.meetingId)}
						>
							Release &amp; mark unavailable
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
