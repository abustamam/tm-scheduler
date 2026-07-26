import { useState } from "react";

export interface OutreachMember {
	id: string;
	name: string;
}

export interface OutreachBuckets {
	assignedCount: number;
	unavailableCount: number;
	contacted: OutreachMember[];
	notContacted: OutreachMember[];
}

/**
 * Split the active roster into outreach buckets (#340). Assigned members are
 * implicitly "contacted about a role" and are excluded from both lists — the
 * panel only tracks the gap (asked-but-not-assigned + still-to-ask). Members who
 * marked themselves unavailable for this meeting are excluded too (#376): the
 * agenda already tells the officer to skip them, so listing them as people to
 * chase contradicts the section directly above. They are counted, not dropped,
 * so the header still accounts for every active member. Pure.
 *
 * Bucket precedence is assigned → unavailable → contacted/not, so nobody is
 * counted twice: someone assigned a role has answered regardless of the flag.
 */
export function deriveOutreach(input: {
	roster: OutreachMember[];
	assignedIds: ReadonlySet<string>;
	contactedIds: ReadonlySet<string>;
	unavailableIds: ReadonlySet<string>;
}): OutreachBuckets {
	const contacted: OutreachMember[] = [];
	const notContacted: OutreachMember[] = [];
	let assignedCount = 0;
	let unavailableCount = 0;
	for (const m of input.roster) {
		if (input.assignedIds.has(m.id)) {
			assignedCount++;
			continue;
		}
		if (input.unavailableIds.has(m.id)) {
			unavailableCount++;
			continue;
		}
		(input.contactedIds.has(m.id) ? contacted : notContacted).push(m);
	}
	return { assignedCount, unavailableCount, contacted, notContacted };
}

/** One roster row with its own pending state — hoisted to module scope so it
 *  keeps a stable identity across `OutreachPanel` renders (avoids remount +
 *  lost focus on every toggle). */
function OutreachRow({
	m,
	isContacted,
	disabled,
	onToggle,
}: {
	m: OutreachMember;
	isContacted: boolean;
	disabled: boolean;
	onToggle: (memberId: string, next: boolean) => void;
}) {
	return (
		<label className="flex items-center gap-2 py-1 text-sm">
			<input
				type="checkbox"
				checked={isContacted}
				disabled={disabled}
				onChange={(e) => onToggle(m.id, e.target.checked)}
			/>
			<span className="flex-1 truncate">{m.name}</span>
		</label>
	);
}

/**
 * Officer-only "Outreach" panel on the meeting view (#340). Lists active members
 * who aren't assigned, split into contacted / still-to-ask, each with a toggle.
 * Rendered by <MeetingAgenda> only under `viewer.canManage`.
 */
export function OutreachPanel({
	roster,
	assignedIds,
	contactedIds,
	unavailableIds,
	onContacted,
	onUncontacted,
}: {
	roster: OutreachMember[];
	assignedIds: ReadonlySet<string>;
	contactedIds: ReadonlySet<string>;
	/** Members who marked themselves out for this meeting (#376) — counted, not
	 *  listed; the "Not available this week" section above already names them. */
	unavailableIds: ReadonlySet<string>;
	onContacted: (memberId: string) => void | Promise<void>;
	onUncontacted: (memberId: string) => void | Promise<void>;
}) {
	const { assignedCount, unavailableCount, contacted, notContacted } =
		deriveOutreach({
			roster,
			assignedIds,
			contactedIds,
			unavailableIds,
		});
	// Per-row in-flight tracking (not the removed `busy` prop, which no caller
	// ever passed): disables only the row being toggled, and guards against a
	// rapid double-toggle race on the same member.
	const [pendingId, setPendingId] = useState<string | null>(null);

	async function toggle(memberId: string, next: boolean) {
		setPendingId(memberId);
		try {
			await (next ? onContacted(memberId) : onUncontacted(memberId));
		} finally {
			setPendingId(null);
		}
	}

	return (
		<section className="rounded-xl border bg-card p-4">
			<div className="mb-2 flex items-baseline justify-between">
				<h3 className="text-sm font-semibold">Outreach</h3>
				<span className="text-xs text-[var(--sea-ink-soft)]">
					{assignedCount} assigned · {contacted.length} contacted ·{" "}
					{notContacted.length} to ask
					{unavailableCount > 0 ? ` · ${unavailableCount} unavailable` : null}
				</span>
			</div>
			{contacted.map((m) => (
				<OutreachRow
					key={m.id}
					m={m}
					isContacted
					disabled={pendingId === m.id}
					onToggle={toggle}
				/>
			))}
			{notContacted.map((m) => (
				<OutreachRow
					key={m.id}
					m={m}
					isContacted={false}
					disabled={pendingId === m.id}
					onToggle={toggle}
				/>
			))}
			{contacted.length === 0 && notContacted.length === 0 ? (
				<p className="text-xs text-[var(--sea-ink-soft)]">
					{roster.length === 0
						? "No active members yet."
						: unavailableCount > 0
							? "Everyone else is assigned or unavailable."
							: "Everyone active is assigned."}
				</p>
			) : null}
		</section>
	);
}
