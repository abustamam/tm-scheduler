import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { formatMeetingDate } from "#/lib/format";
import { type Orientation, projectGrid } from "#/lib/season-grid-view";
import { cn } from "#/lib/utils";
import type { SeasonGridCount, SeasonGridData } from "#/server/season-grid";
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
}: {
	data: SeasonGridData;
	orientation: Orientation;
	count: SeasonGridCount;
}) {
	const rows = projectGrid(data, orientation);
	const labelHead = orientation === "roles" ? "Role" : "Member";
	const anchorRef = useRef<HTMLTableCellElement>(null);

	useEffect(() => {
		anchorRef.current?.scrollIntoView({ inline: "center", block: "nearest" });
	}, []);

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
						<Link
							key={v.value}
							to="/schedule"
							search={(prev) => ({ view: v.value, count: prev.count ?? 8 })}
							className={cn(
								"px-3 py-1.5 text-xs font-semibold",
								orientation === v.value
									? "bg-primary text-primary-foreground"
									: "text-muted-foreground",
							)}
						>
							{v.label}
						</Link>
					))}
				</div>
				<div className="inline-flex overflow-hidden rounded-lg border">
					{COUNTS.map((c) => (
						<Link
							key={String(c)}
							to="/schedule"
							search={(prev) => ({ count: c, view: prev.view ?? "members" })}
							className={cn(
								"px-3 py-1.5 text-xs font-semibold",
								count === c
									? "bg-accent text-accent-foreground"
									: "text-muted-foreground",
							)}
						>
							{c === "all" ? "All" : c}
						</Link>
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
										m.isPast && "opacity-45",
										m.isAnchor && "rounded-md ring-2 ring-primary",
									)}
								>
									<Link
										to="/meetings/$id"
										params={{ id: m.id }}
										className="block"
									>
										<div>{formatMeetingDate(m.scheduledAt, m.timezone)}</div>
										<div className="text-[10px] font-medium text-amber-600">
											{m.isPast
												? "done"
												: m.openCount === 0
													? "full"
													: `${m.openCount} open`}
										</div>
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
										<GridCell cell={cell} />
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
