import { ClipboardCheck } from "lucide-react";
import { formatCalendarDay } from "#/lib/format";
import type { ActionItemRow } from "#/server/action-items-logic";

/**
 * The club's currently-open action items, on the meeting page (#529).
 *
 * Read-only, and shown to any signed-in member of the club rather than only to
 * admins. It deliberately does NOT sit inside `MeetingMinutes`: the minutes are
 * hidden until a meeting is completed, and an open action item is most useful
 * BEFORE the meeting — hiding it until afterwards removes the point of tracking
 * it. The route renders this only when the minutes section is not already
 * showing its own timestamp-pinned list, so there is never more than one
 * action-item list on the page.
 *
 * The two lists differ by design: this is "what is open right now", the minutes'
 * version is "what was open at that meeting's instant", reconstructed from
 * timestamps so it stays stable forever.
 */
export function OpenActionItems({ items }: { items: ActionItemRow[] }) {
	if (items.length === 0) return null;
	return (
		<section className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-5">
			<div className="mb-3 flex items-center gap-2">
				<ClipboardCheck
					className="size-4 text-[var(--sea-ink-soft)]"
					aria-hidden
				/>
				<h2 className="font-semibold text-sm">Open action items</h2>
			</div>
			<ul className="space-y-1.5">
				{items.map((i) => (
					<li key={i.id} className="text-sm">
						<span className="font-medium">{i.text}</span>
						{/* No owner run at all when nobody owns it — a placeholder would
						    read as an assignment that was never made. */}
						{i.ownerName || i.dueDate ? (
							<span className="text-xs text-[var(--sea-ink-soft)]">
								{i.ownerName ? ` · ${i.ownerName}` : ""}
								{i.dueDate ? ` · due ${formatCalendarDay(i.dueDate)}` : ""}
							</span>
						) : null}
					</li>
				))}
			</ul>
		</section>
	);
}
