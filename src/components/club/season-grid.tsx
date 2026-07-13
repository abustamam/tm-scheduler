import { Link } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formatMeetingDate } from "#/lib/format";
import { type Orientation, projectGrid } from "#/lib/season-grid-view";
import { cn } from "#/lib/utils";
import type { SeasonGridCount, SeasonGridData } from "#/server/season-grid";
import { claimSlot, releaseSlot } from "#/server/slots";
import { GridCell } from "./grid-cell";

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
	onOrientationChange,
	onCountChange,
	onChanged,
}: {
	data: SeasonGridData;
	orientation: Orientation;
	count: SeasonGridCount;
	/** When set, the grid becomes the interactive sign-up sheet: claim OPEN
	 *  roles, release your own (Roles × Meetings only). #198. */
	currentMemberId?: string | null;
	onOrientationChange?: (o: Orientation) => void;
	onCountChange?: (c: SeasonGridCount) => void;
	/** Called after a successful claim/release so the page can refetch. */
	onChanged?: () => void | Promise<void>;
}) {
	const rows = projectGrid(data, orientation);
	const labelHead = orientation === "roles" ? "Role" : "Member";
	const anchorRef = useRef<HTMLTableCellElement>(null);
	const [busySlotId, setBusySlotId] = useState<string | null>(null);

	// Only Roles × Meetings is the tappable sheet (members orientation is a
	// read-only lens — a member cell can aggregate several slots).
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

			<div className="overflow-auto rounded-xl border">
				<table className="border-separate border-spacing-1">
					<thead>
						<tr>
							<th className="sticky top-0 left-0 z-20 bg-card px-3 py-2 text-left text-xs font-semibold">
								{labelHead}
							</th>
							{data.meetings.map((m) => (
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
									<Link
										to="/meetings/$id"
										params={{ id: m.id }}
										className="block"
									>
										<div>{formatMeetingDate(m.scheduledAt, m.timezone)}</div>
										{m.isCompleted ? (
											<div className="flex items-center justify-center gap-0.5 text-[10px] font-semibold text-muted-foreground">
												<Lock className="size-2.5" aria-hidden />
												locked
											</div>
										) : (
											<div className="text-[10px] font-medium text-amber-600">
												{m.isPast
													? "done"
													: m.openCount === 0
														? "full"
														: `${m.openCount} open`}
											</div>
										)}
									</Link>
								</th>
							))}
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
								{row.cells.map((cell, i) => (
									<td key={`${row.id}:${data.meetings[i]?.id}`} className="p-0">
										<GridCell
											cell={cell}
											currentMemberId={actingMemberId}
											busy={busySlotId === cell.slotId}
											onClaim={claim}
											onRelease={release}
										/>
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
