import { useState } from "react";

export interface OutreachMember {
	id: string;
	name: string;
}

export interface OutreachBuckets {
	assignedCount: number;
	contacted: OutreachMember[];
	notContacted: OutreachMember[];
}

/**
 * Split the active roster into outreach buckets (#340). Assigned members are
 * implicitly "contacted about a role" and are excluded from both lists — the
 * panel only tracks the gap (asked-but-not-assigned + still-to-ask). Pure.
 */
export function deriveOutreach(input: {
	roster: OutreachMember[];
	assignedIds: ReadonlySet<string>;
	contactedIds: ReadonlySet<string>;
}): OutreachBuckets {
	const contacted: OutreachMember[] = [];
	const notContacted: OutreachMember[] = [];
	let assignedCount = 0;
	for (const m of input.roster) {
		if (input.assignedIds.has(m.id)) {
			assignedCount++;
			continue;
		}
		(input.contactedIds.has(m.id) ? contacted : notContacted).push(m);
	}
	return { assignedCount, contacted, notContacted };
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
	onContacted,
	onUncontacted,
}: {
	roster: OutreachMember[];
	assignedIds: ReadonlySet<string>;
	contactedIds: ReadonlySet<string>;
	onContacted: (memberId: string) => void | Promise<void>;
	onUncontacted: (memberId: string) => void | Promise<void>;
}) {
	const { assignedCount, contacted, notContacted } = deriveOutreach({
		roster,
		assignedIds,
		contactedIds,
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
						: "Everyone active is assigned."}
				</p>
			) : null}
		</section>
	);
}
